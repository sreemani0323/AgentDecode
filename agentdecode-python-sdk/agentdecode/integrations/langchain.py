"""
LangChain callback handler for AgentDecode.

Provides a drop-in callback that sends LangChain traces to AgentDecode.
LangChain is an optional dependency — the SDK works without it.

Usage::

    from agentdecode import AgentDecode
    from agentdecode.integrations.langchain import AgentDecodeCallbackHandler

    agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
    handler = AgentDecodeCallbackHandler(agent, session_name="my_chain_run")

    chain.invoke(input, config={"callbacks": [handler]})
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Union

# Try langchain-core first (modern), then langchain (legacy)
try:
    from langchain_core.callbacks.base import BaseCallbackHandler
    from langchain_core.outputs import LLMResult

    LANGCHAIN_AVAILABLE = True
except ImportError:
    try:
        from langchain.callbacks.base import BaseCallbackHandler  # type: ignore[no-redef]
        from langchain.schema import LLMResult  # type: ignore[no-redef]

        LANGCHAIN_AVAILABLE = True
    except ImportError:
        LANGCHAIN_AVAILABLE = False
        BaseCallbackHandler = object  # type: ignore[misc,assignment]
        LLMResult = object  # type: ignore[misc,assignment]


class AgentDecodeCallbackHandler(BaseCallbackHandler):  # type: ignore[misc]
    """LangChain callback handler that sends traces to AgentDecode.

    Captures chain, LLM, and tool events and sends them as spans
    grouped into a single session.
    """

    def __init__(
        self,
        agent: Any,
        session_name: str = "langchain_run",
        *,
        _send_fn: Any = None,
    ) -> None:
        if not LANGCHAIN_AVAILABLE:
            raise ImportError(
                "langchain is not installed. "
                "Install it with: pip install langchain-core"
            )
        super().__init__()
        self.agent = agent
        self.session_name = session_name
        self._session: Any = None
        self._spans: Dict[str, Any] = {}  # run_id -> Span
        self._send_fn = _send_fn

    def _ensure_session(self) -> Any:
        """Lazily create a session on first event."""
        if self._session is None:
            self._session = self.agent._start_session(
                self.session_name, _send_fn=self._send_fn
            )
        return self._session

    # ── Chain events ───────────────────────────────────────────────

    def on_chain_start(
        self,
        serialized: Dict[str, Any],
        inputs: Union[Dict[str, Any], Any],
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        session = self._ensure_session()
        chain_name = serialized.get("name", "chain") if serialized else "chain"
        span = session._start_span(chain_name, span_type="chain")
        span.input = inputs if isinstance(inputs, dict) else {"input": str(inputs)[:500]}
        if run_id:
            self._spans[str(run_id)] = span

    def on_chain_end(
        self,
        outputs: Union[Dict[str, Any], Any],
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        span = self._spans.pop(str(run_id), None)
        if span:
            span.output = outputs if isinstance(outputs, dict) else {"output": str(outputs)[:500]}
            span._finish()

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        span = self._spans.pop(str(run_id), None)
        if span:
            span.error_message = str(error)
            span._status = "error"
            span._finish()

    # ── LLM events ─────────────────────────────────────────────────

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        session = self._ensure_session()
        model_name = serialized.get("name", "llm") if serialized else "llm"
        span = session._start_span(f"llm.{model_name}", span_type="llm")
        span.input = {"prompts": [p[:500] for p in prompts]}
        span.model = model_name
        if run_id:
            self._spans[str(run_id)] = span

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        span = self._spans.pop(str(run_id), None)
        if span:
            # Extract generated text
            generations = getattr(response, "generations", None)
            if generations and len(generations) > 0 and len(generations[0]) > 0:
                span.output = {"text": generations[0][0].text[:500]}

            # Extract token usage if available
            llm_output = getattr(response, "llm_output", None)
            if llm_output and isinstance(llm_output, dict):
                usage = llm_output.get("token_usage", {})
                if usage.get("prompt_tokens") is not None:
                    span.input_tokens = usage["prompt_tokens"]
                if usage.get("completion_tokens") is not None:
                    span.output_tokens = usage["completion_tokens"]

            span._finish()

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        span = self._spans.pop(str(run_id), None)
        if span:
            span.error_message = str(error)
            span._status = "error"
            span._finish()

    # ── Tool events ────────────────────────────────────────────────

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        session = self._ensure_session()
        tool_name = serialized.get("name", "tool") if serialized else "tool"
        span = session._start_span(f"tool.{tool_name}", span_type="tool")
        span.input = {"input": input_str[:500]}
        if run_id:
            self._spans[str(run_id)] = span

    def on_tool_end(
        self,
        output: str,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        span = self._spans.pop(str(run_id), None)
        if span:
            span.output = {"output": str(output)[:500]}
            span._finish()

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        span = self._spans.pop(str(run_id), None)
        if span:
            span.error_message = str(error)
            span._status = "error"
            span._finish()

    # ── Agent finish ───────────────────────────────────────────────

    def on_agent_finish(
        self,
        finish: Any,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        """Flush the entire session when the agent finishes."""
        if self._session:
            self._session._flush(silent_fail=True)
            self._session = None

    # ── Text event (no-op, required by some versions) ──────────────

    def on_text(self, text: str, **kwargs: Any) -> None:
        pass
