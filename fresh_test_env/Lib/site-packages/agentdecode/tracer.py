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

import functools
import json
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


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

    # ── Context manager ────────────────────────────────────────────

    def __enter__(self) -> "Span":
        self._started_at = datetime.now(timezone.utc)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:  # type: ignore[type-arg]
        self._ended_at = datetime.now(timezone.utc)
        if exc_val is not None:
            self._status = "error"
            self.error_message = (
                self.error_message or f"{type(exc_val).__name__}: {exc_val}"
            )
        return False  # do not suppress exceptions

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
        _send_fn: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.name = name
        self.session_id = session_id
        self._api_key = api_key
        self._endpoint = endpoint
        self._spans: List[Span] = []
        self._send_fn = _send_fn  # injectable for testing

    # ── Span factory ───────────────────────────────────────────────

    def span(
        self,
        name: str,
        span_type: str = "tool",
        parent: Optional[Span] = None,
    ) -> Span:
        """Create a child span. Returns a context manager."""
        s = Span(name=name, span_type=span_type, parent=parent)
        self._spans.append(s)
        return s

    # ── Context manager ────────────────────────────────────────────

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:  # type: ignore[type-arg]
        # Always try to flush, even if an exception occurred inside the
        # session block — the user needs to see where things broke.
        try:
            self._flush()
        except Exception:
            # Print but do not mask the original exception
            traceback.print_exc()
        return False

    # ── Flush ──────────────────────────────────────────────────────

    def _flush(self) -> Dict[str, Any]:
        """Send all collected spans to /api/ingest."""
        if not self._spans:
            return {}

        payload: Dict[str, Any] = {
            "session_name": self.name,
            "spans": [s.to_dict() for s in self._spans],
        }
        if self.session_id:
            payload["session_id"] = self.session_id

        if self._send_fn is not None:
            return self._send_fn(payload)

        return _http_post(
            url=f"{self._endpoint}/api/ingest",
            api_key=self._api_key,
            payload=payload,
        )


class AgentDecode:
    """Top-level client. Create one per project.

    Example::

        agent = AgentDecode(api_key="al_...", endpoint="https://my-app.vercel.app")

        with agent.session("My Agent Run") as session:
            with session.span("llm_call", span_type="llm") as span:
                span.model = "gpt-4o"
                span.input = {"prompt": "Hello"}
                result = call_llm(...)
                span.output = result
    """

    def __init__(self, api_key: str, endpoint: str) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        if not endpoint:
            raise ValueError("endpoint is required")
        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")

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
            _send_fn=_send_fn,
        )

    def trace(
        self,
        name: str,
        span_type: str = "agent",
        session_name: Optional[str] = None,
    ) -> Callable:  # type: ignore[type-arg]
        """Decorator: wraps a function in a single-span session.

        Usage::

            @agent.trace("classify_intent", span_type="llm")
            def classify(message: str) -> dict:
                return {"intent": "support"}
        """

        def decorator(fn: Callable) -> Callable:  # type: ignore[type-arg]
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
    timeout: int = 10,
) -> Dict[str, Any]:
    """POST JSON to a URL. Returns parsed response body."""
    data = json.dumps(payload, default=str).encode("utf-8")

    req = Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "agentdecode-python/0.1.0",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")
        except Exception:
            pass
        raise RuntimeError(
            f"AgentDecode API error {e.code}: {body or e.reason}"
        ) from e
    except URLError as e:
        raise RuntimeError(
            f"AgentDecode connection error: {e.reason}"
        ) from e
