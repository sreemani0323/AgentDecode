"""
LlamaIndex callback handler for AgentDecode.

Integrates with LlamaIndex's callback system to automatically trace
queries, retrievals, LLM calls, and tool invocations.
LlamaIndex is an optional dependency — the SDK works without it.

Usage::

    from agentdecode import AgentDecode
    from agentdecode.integrations.llamaindex import AgentDecodeLlamaIndexHandler
    from llama_index.core.callbacks import CallbackManager

    agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
    handler = AgentDecodeLlamaIndexHandler(agent, session_name="rag_query")
    callback_manager = CallbackManager([handler])

    # Pass to your index/query engine
    index.as_query_engine(callback_manager=callback_manager)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from agentdecode.tracer import Span

# Try to import llama_index
try:
    from llama_index.core.callbacks import CBEventType
    from llama_index.core.callbacks.base_handler import BaseCallbackHandler

    LLAMAINDEX_AVAILABLE = True
except ImportError:
    LLAMAINDEX_AVAILABLE = False
    BaseCallbackHandler = object  # type: ignore[misc,assignment]

# Event type → span_type mapping
_EVENT_TYPE_MAP: Dict[str, str] = {
    "llm": "llm",
    "retrieve": "retrieval",
    "query": "agent",
    "function_call": "tool",
    "embedding": "llm",
    "chunking": "tool",
    "node_parsing": "tool",
    "sub_question": "agent",
    "synthesize": "agent",
    "tree": "agent",
    "templating": "tool",
    "reranking": "tool",
    "agent_step": "agent",
}


class AgentDecodeLlamaIndexHandler(BaseCallbackHandler):  # type: ignore[misc]
    """LlamaIndex callback handler that sends trace data to AgentDecode.

    Automatically captures queries, retrievals, LLM calls, and tool
    invocations as spans. Each ``start_trace`` / ``end_trace`` pair
    produces one AgentDecode session.
    """

    def __init__(
        self,
        agent: Any,
        session_name: str = "llamaindex_run",
        *,
        _send_fn: Any = None,
    ) -> None:
        if not LLAMAINDEX_AVAILABLE:
            raise ImportError(
                "llama-index is not installed. "
                "Install it with: pip install llama-index-core"
            )
        super().__init__(
            event_starts_to_ignore=[],
            event_ends_to_ignore=[],
        )
        self.agent = agent
        self.session_name = session_name
        self._send_fn = _send_fn
        self._session: Any = None
        self._event_spans: Dict[str, Span] = {}

    def start_trace(self, trace_id: Optional[str] = None) -> None:
        """Called when a new trace starts (e.g. a query begins)."""
        self._session = self.agent._start_session(
            self.session_name, _send_fn=self._send_fn
        )

    def end_trace(
        self,
        trace_id: Optional[str] = None,
        trace_map: Optional[Dict[str, List[str]]] = None,
    ) -> None:
        """Called when a trace ends — flushes all collected spans."""
        if self._session is not None:
            try:
                self._session._flush(silent_fail=True)
            except Exception:
                pass
            self._session = None
            self._event_spans.clear()

    def on_event_start(
        self,
        event_type: Any,
        payload: Optional[Dict[str, Any]] = None,
        event_id: str = "",
        parent_id: str = "",
        **kwargs: Any,
    ) -> str:
        """Called when a LlamaIndex event starts."""
        if self._session is None:
            return event_id

        # Resolve span_type from event_type
        event_value = event_type.value if hasattr(event_type, "value") else str(event_type)
        span_type = _EVENT_TYPE_MAP.get(event_value.lower(), "agent")
        span_name = event_value

        # Find parent span if available
        parent_span = self._event_spans.get(parent_id) if parent_id else None

        span = self._session._start_span(
            span_name, span_type=span_type, parent=parent_span
        )

        if payload:
            try:
                span.input = {
                    k: str(v)[:200] for k, v in list(payload.items())[:5]
                }
            except Exception:
                pass

        self._event_spans[event_id] = span
        return event_id

    def on_event_end(
        self,
        event_type: Any,
        payload: Optional[Dict[str, Any]] = None,
        event_id: str = "",
        **kwargs: Any,
    ) -> None:
        """Called when a LlamaIndex event ends."""
        span = self._event_spans.pop(event_id, None)
        if span is None:
            return

        if payload:
            try:
                span.output = {
                    k: str(v)[:200] for k, v in list(payload.items())[:5]
                }
            except Exception:
                pass

        span._finish()
