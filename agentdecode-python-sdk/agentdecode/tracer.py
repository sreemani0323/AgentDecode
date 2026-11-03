"""
AgentDecode tracer — zero-dependency SDK using only Python stdlib.

Sends trace data to the AgentDecode /api/ingest endpoint.
Field names match the server's Zod validation schema exactly:
  - session_name, session_id (top-level)
  - name, span_type, status, started_at, ended_at, duration_ms,
    model, input, output, error_message, input_tokens, output_tokens,
    cost_usd, metadata, client_span_id, parent_client_span_id (per span)
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
import json
import random
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from agentdecode.wal import SQLiteWAL, WALBatch, WALCapacityError


class HTTPClientError(RuntimeError):
    """Permanent 4xx client error (excluding 429)."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"AgentDecode API client error {code}: {message}")
        self.code = code


# ── Context variables for automatic span nesting ───────────────────────

_current_span: contextvars.ContextVar[Optional["Span"]] = contextvars.ContextVar(
    "agentdecode_current_span", default=None
)

_current_session: contextvars.ContextVar[Optional["Session"]] = contextvars.ContextVar(
    "agentdecode_current_session", default=None
)


def current_session() -> Optional["Session"]:
    """Return the active Session in this context, or None."""
    return _current_session.get()


def current_span() -> Optional["Span"]:
    """Return the active Span in this context, or None."""
    return _current_span.get()


class Span:
    """A single traced operation. Use as a context manager.

    Properties can be set freely inside the `with` block. On exit,
    timing is finalised and any unhandled exception is captured.
    """

    def __init__(
        self,
        name: str,
        span_type: str = "tool",
        parent: Optional["Span"] = None,
    ) -> None:
        self.name = name
        self.span_type = span_type

        # Public properties the user can set
        self.input: Any = None
        self.output: Any = None
        self.model: Optional[str] = None
        self.input_tokens: Optional[int] = None
        self.output_tokens: Optional[int] = None
        self.cost_usd: Optional[float] = None
        self.error_message: Optional[str] = None
        self.metadata: Dict[str, Any] = {}

        # Internal
        self._client_span_id: str = uuid.uuid4().hex[:16]
        self._parent_client_span_id: Optional[str] = (
            parent._client_span_id if parent else None
        )
        self._started_at: Optional[datetime] = None
        self._ended_at: Optional[datetime] = None
        self._status: str = "ok"
        self._context_token: Optional[contextvars.Token] = None

    # ── Context manager ────────────────────────────────────────────

    def __enter__(self) -> "Span":
        self._started_at = datetime.now(timezone.utc)
        # Set this span as the current span in context
        self._context_token = _current_span.set(self)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:  # type: ignore[type-arg]
        self._ended_at = datetime.now(timezone.utc)
        if exc_val is not None:
            self._status = "error"
            self.error_message = (
                self.error_message or f"{type(exc_val).__name__}: {exc_val}"
            )
        # Reset the context variable to the previous span
        if self._context_token is not None:
            _current_span.reset(self._context_token)
            self._context_token = None
        return False  # do not suppress exceptions

    # ── Internal helpers for non-context-manager usage ─────────────

    def _start(self) -> "Span":
        """Start timing this span (non-context-manager usage)."""
        self._started_at = datetime.now(timezone.utc)
        return self

    def _finish(self) -> None:
        """Finish timing this span (non-context-manager usage)."""
        self._ended_at = datetime.now(timezone.utc)

    # ── Serialisation ──────────────────────────────────────────────

    def _duration_ms(self) -> Optional[int]:
        if self._started_at and self._ended_at:
            delta = self._ended_at - self._started_at
            return max(0, int(delta.total_seconds() * 1000))
        return None

    def to_dict(self) -> Dict[str, Any]:
        """Produce the dict matching the server's Zod SpanSchema."""
        d: Dict[str, Any] = {
            "name": self.name,
            "span_type": self.span_type,
            "status": self._status,
            "started_at": (
                self._started_at.isoformat().replace("+00:00", "Z")
                if self._started_at
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            ),
            "client_span_id": self._client_span_id,
        }

        if self._ended_at:
            d["ended_at"] = self._ended_at.isoformat().replace("+00:00", "Z")
        if self._duration_ms() is not None:
            d["duration_ms"] = self._duration_ms()
        if self._parent_client_span_id:
            d["parent_client_span_id"] = self._parent_client_span_id
        if self.model is not None:
            d["model"] = self.model
        if self.input is not None:
            d["input"] = self.input
        if self.output is not None:
            d["output"] = self.output
        if self.error_message is not None:
            d["error_message"] = self.error_message
        if self.input_tokens is not None:
            d["input_tokens"] = self.input_tokens
        if self.output_tokens is not None:
            d["output_tokens"] = self.output_tokens
        if self.cost_usd is not None:
            d["cost_usd"] = self.cost_usd
        if self.metadata:
            d["metadata"] = self.metadata

        return d


class Session:
    """A group of related spans. Use as a context manager.

    On ``__exit__``, all collected spans are sent in one batch to the
    AgentDecode ingest API.
    """

    def __init__(
        self,
        name: str,
        api_key: str,
        endpoint: str,
        session_id: Optional[str] = None,
        timeout: int = 10,
        max_retries: int = 3,
        flush_timeout: int = 30,
        _send_fn: Optional[Callable[..., Any]] = None,
        wal: Optional[SQLiteWAL] = None,
    ) -> None:
        self.name = name
        self.session_id = session_id
        self._api_key = api_key
        self._endpoint = endpoint
        self._timeout = timeout
        self._max_retries = max_retries
        self._flush_timeout = flush_timeout
        self._spans: List[Span] = []
        self._send_fn = _send_fn  # injectable for testing
        self._wal = wal
        self._context_token: Optional[contextvars.Token] = None

    # ── Span factory ───────────────────────────────────────────────

    def span(
        self,
        name: str,
        span_type: str = "tool",
        parent: Optional[Span] = None,
    ) -> Span:
        """Create a child span. Returns a context manager.

        If ``parent`` is not provided, the current span from contextvars
        is used automatically (if one exists).
        """
        if parent is None:
            parent = _current_span.get()
        s = Span(name=name, span_type=span_type, parent=parent)
        self._spans.append(s)
        return s

    def _start_span(
        self,
        name: str,
        span_type: str = "tool",
        parent: Optional[Span] = None,
    ) -> Span:
        """Create and start a span without a context manager.

        Used by integration callbacks (e.g. LangChain) where the
        start/end events arrive separately.
        """
        if parent is None:
            parent = _current_span.get()
        s = Span(name=name, span_type=span_type, parent=parent)
        s._start()
        self._spans.append(s)
        return s

    # ── Context manager ────────────────────────────────────────────

    def __enter__(self) -> "Session":
        self._context_token = _current_session.set(self)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:  # type: ignore[type-arg]
        # Always try to flush, even if an exception occurred inside the
        # session block — the user needs to see where things broke.
        try:
            self._flush()
        except Exception:
            # Print but do not mask the original exception
            traceback.print_exc()
        finally:
            # Reset the context variable to previous session
            if self._context_token is not None:
                _current_session.reset(self._context_token)
                self._context_token = None
        return False

    # ── Flush ──────────────────────────────────────────────────────

    def _flush(self, silent_fail: bool = False) -> Dict[str, Any]:
        """Send all collected spans to /api/ingest."""
        if not self._spans:
            return {}

        payload: Dict[str, Any] = {
            "session_name": self.name,
            "spans": [s.to_dict() for s in self._spans],
        }
        if self.session_id:
            payload["session_id"] = self.session_id

        # Persist to WAL before attempting transmission if WAL is active
        batch_id: Optional[str] = None
        if self._wal is not None:
            try:
                batch_id = self._wal.enqueue(
                    payload=payload,
                    session_name=self.name,
                    session_id=self.session_id,
                )
            except WALCapacityError as e:
                if silent_fail:
                    print(f"[agentdecode] Warning: {e}", file=sys.stderr)
                    return {}
                raise

        if self._send_fn is not None:
            try:
                res = self._send_fn(payload)
                if batch_id and self._wal is not None:
                    self._wal.acknowledge(batch_id)
                return res if res is not None else {}
            except Exception as e:
                if batch_id and self._wal is not None:
                    self._wal.record_retry(batch_id, str(e))
                if not silent_fail:
                    raise
                return {}

        # Use threading to enforce flush_timeout across all retries
        result: Dict[str, Any] = {}
        error: Optional[Exception] = None
        is_client_error = False

        def _do_send():
            nonlocal result, error, is_client_error
            try:
                result = _http_post(
                    url=f"{self._endpoint}/api/ingest",
                    api_key=self._api_key,
                    payload=payload,
                    max_retries=self._max_retries,
                    timeout=self._timeout,
                    silent_fail=False,
                    jitter=True,
                )
            except HTTPClientError as e:
                is_client_error = True
                error = e
            except Exception as e:
                error = e

        thread = threading.Thread(target=_do_send, daemon=True)
        thread.start()
        thread.join(timeout=self._flush_timeout)

        if thread.is_alive():
            # Flush timed out — trace safely retained in WAL
            msg = f"flush timed out after {self._flush_timeout}s"
            if batch_id and self._wal is not None:
                self._wal.record_retry(batch_id, msg)
            print(
                f"[agentdecode] Warning: flush timed out after "
                f"{self._flush_timeout}s — trace persisted in WAL for retry",
                file=sys.stderr,
            )
            return {}

        if error is not None:
            if batch_id and self._wal is not None:
                if is_client_error:
                    self._wal.record_permanent_failure(batch_id, str(error))
                else:
                    self._wal.record_retry(batch_id, str(error))
            if silent_fail:
                print(
                    f"[agentdecode] Warning: failed to send trace: {error}",
                    file=sys.stderr,
                )
                return {}
            raise error

        # Confirmed successful delivery: acknowledge and delete from WAL
        if batch_id and self._wal is not None:
            self._wal.acknowledge(batch_id)

        return result


class AgentDecode:
    """Top-level client. Create one per project.

    Example::

        agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")

        with agent.session("My Agent Run") as session:
            with session.span("llm_call", span_type="llm") as span:
                span.model = "gpt-4o"
                span.input = {"prompt": "Hello"}
                result = call_llm(...)
                span.output = result
    """

    def __init__(
        self,
        api_key: str,
        endpoint: str = "https://agent-decode.vercel.app",
        timeout: int = 10,
        max_retries: int = 3,
        flush_timeout: int = 30,
        wal_path: Optional[str] = None,
        max_wal_entries: int = 10000,
        max_wal_bytes: int = 50 * 1024 * 1024,
        wal_synchronous_mode: str = "FULL",
        disable_wal: bool = False,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        if not endpoint:
            raise ValueError("endpoint is required")
        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.flush_timeout = flush_timeout
        self.disable_wal = disable_wal

        self.wal: Optional[SQLiteWAL] = None
        if not disable_wal:
            self.wal = SQLiteWAL(
                db_path=wal_path,
                max_entries=max_wal_entries,
                max_bytes=max_wal_bytes,
                synchronous_mode=wal_synchronous_mode,
            )
            # Recover pending spans left in-flight from previous crashes/restarts
            self.wal.recover()

    def session(
        self,
        name: str,
        session_id: Optional[str] = None,
        *,
        _send_fn: Optional[Callable[..., Any]] = None,
    ) -> Session:
        """Create a trace session. Use as a context manager."""
        return Session(
            name=name,
            api_key=self.api_key,
            endpoint=self.endpoint,
            session_id=session_id,
            timeout=self.timeout,
            max_retries=self.max_retries,
            flush_timeout=self.flush_timeout,
            _send_fn=_send_fn,
            wal=self.wal,
        )

    def _start_session(
        self,
        name: str,
        session_id: Optional[str] = None,
        *,
        _send_fn: Optional[Callable[..., Any]] = None,
    ) -> Session:
        """Create a session without using it as a context manager.

        Used by integration callbacks (e.g. LangChain) where the
        session lifecycle is controlled externally.
        """
        return Session(
            name=name,
            api_key=self.api_key,
            endpoint=self.endpoint,
            session_id=session_id,
            timeout=self.timeout,
            max_retries=self.max_retries,
            flush_timeout=self.flush_timeout,
            _send_fn=_send_fn,
            wal=self.wal,
        )

    def flush(
        self,
        send_fn: Optional[Callable[..., Any]] = None,
        timeout: Optional[float] = None,
    ) -> int:
        """Flush pending WAL records to the ingest endpoint.

        Args:
            send_fn: Optional custom sender (e.g. for testing).
            timeout: Optional maximum seconds to attempt sending.

        Returns:
            Number of successfully acknowledged batches.
        """
        if self.wal is None:
            return 0

        pending = self.wal.get_pending()
        if not pending:
            return 0

        batch_ids = [b.id for b in pending]
        self.wal.mark_sending(batch_ids)

        acked_count = 0
        start_time = time.time()

        for batch in pending:
            if timeout is not None and (time.time() - start_time) >= timeout:
                remaining_ids = [b.id for b in pending[acked_count:]]
                for rid in remaining_ids:
                    self.wal.record_retry(rid, "Flush timeout reached")
                break

            try:
                if send_fn is not None:
                    send_fn(batch.payload)
                else:
                    _http_post(
                        url=f"{self.endpoint}/api/ingest",
                        api_key=self.api_key,
                        payload=batch.payload,
                        max_retries=self.max_retries,
                        timeout=self.timeout,
                        silent_fail=False,
                        jitter=True,
                    )
                self.wal.acknowledge(batch.id)
                acked_count += 1
            except HTTPClientError as e:
                self.wal.record_permanent_failure(batch.id, str(e))
            except Exception as e:
                self.wal.record_retry(batch.id, str(e))

        return acked_count

    def trace(
        self,
        name: str,
        span_type: str = "agent",
        session_name: Optional[str] = None,
    ) -> Callable:  # type: ignore[type-arg]
        """Decorator: wraps a function in a single-span session.

        Works with both sync and async functions.

        Usage::

            @agent.trace("classify_intent", span_type="llm")
            def classify(message: str) -> dict:
                return {"intent": "support"}

            @agent.trace("async_call", span_type="llm")
            async def call_llm(prompt: str) -> dict:
                return await some_async_llm(prompt)
        """

        def decorator(fn: Callable) -> Callable:  # type: ignore[type-arg]
            if inspect.iscoroutinefunction(fn):
                # ── Async version ──────────────────────────────────
                @functools.wraps(fn)
                async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                    sname = session_name or f"{name}"
                    with self.session(sname) as sess:
                        with sess.span(name, span_type=span_type) as span:
                            # Capture input
                            try:
                                span.input = {
                                    "args": str(args)[:200],
                                    "kwargs": str(kwargs)[:200],
                                }
                            except Exception:
                                pass

                            result = await fn(*args, **kwargs)

                            # Capture output
                            try:
                                span.output = (
                                    result
                                    if isinstance(result, (dict, list, str, int, float, bool, type(None)))
                                    else {"result": str(result)[:500]}
                                )
                            except Exception:
                                pass

                            return result

                return async_wrapper
            else:
                # ── Sync version ───────────────────────────────────
                @functools.wraps(fn)
                def wrapper(*args: Any, **kwargs: Any) -> Any:
                    sname = session_name or f"{name}"
                    with self.session(sname) as sess:
                        with sess.span(name, span_type=span_type) as span:
                            # Capture input
                            try:
                                span.input = {"args": args, "kwargs": kwargs}
                            except Exception:
                                pass

                            result = fn(*args, **kwargs)

                            # Capture output
                            try:
                                span.output = result
                            except Exception:
                                pass

                            return result

                return wrapper

        return decorator


# ── HTTP helper (stdlib only) ──────────────────────────────────────


def _http_post(
    url: str,
    api_key: str,
    payload: Dict[str, Any],
    max_retries: int = 3,
    timeout: int = 10,
    silent_fail: bool = False,
    jitter: bool = False,
) -> Dict[str, Any]:
    """POST JSON to a URL with retry and exponential backoff.

    Args:
        url: Target URL.
        api_key: Bearer token for Authorization header.
        payload: JSON-serializable dict to send.
        max_retries: Number of attempts before giving up (default 3).
        timeout: HTTP timeout per request in seconds (default 10).
        silent_fail: If True, print a warning instead of raising on total failure.
        jitter: If True, apply full randomized jitter to backoff delay.

    Returns:
        Parsed JSON response body as a dict.
    """
    data = json.dumps(payload, default=str).encode("utf-8")

    req = Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "agentdecode-python/0.1.5",
        },
        method="POST",
    )

    last_error: Optional[Exception] = None

    for attempt in range(max_retries):
        try:
            with urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8")
            except Exception:
                pass
            if 400 <= e.code < 500 and e.code != 429:
                last_error = HTTPClientError(e.code, err_body or e.reason)
                break
            last_error = RuntimeError(
                f"AgentDecode API error {e.code}: {err_body or e.reason}"
            )
        except URLError as e:
            last_error = RuntimeError(
                f"AgentDecode connection error: {e.reason}"
            )
        except Exception as e:
            last_error = RuntimeError(
                f"AgentDecode unexpected error: {e}"
            )

        # Exponential backoff: base 0.5s with optional jitter
        if attempt < max_retries - 1:
            backoff = min(10.0, (2 ** attempt) * 0.5)
            if jitter:
                wait = backoff * (0.8 + 0.4 * random.random())
            else:
                wait = backoff
            time.sleep(wait)

    # All retries exhausted
    if silent_fail:
        print(
            f"[agentdecode] Warning: failed to send trace after "
            f"{max_retries} attempts: {last_error}",
            file=sys.stderr,
        )
        return {}

    if last_error is not None:
        raise last_error

    return {}
