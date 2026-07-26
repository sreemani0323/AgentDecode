"""
CrewAI integration for AgentDecode.

Provides an observer wrapper that traces crew execution with a single
``observer.run(crew, inputs=...)`` call.
CrewAI is an optional dependency — the SDK works without it.

Usage::

    from agentdecode import AgentDecode
    from agentdecode.integrations.crewai import AgentDecodeCrewObserver

    agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
    observer = AgentDecodeCrewObserver(agent)

    # Wrap your crew.kickoff() call
    result = observer.run(crew, inputs={"topic": "AI trends"})
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# Try to import crewai
try:
    import crewai  # noqa: F401

    CREWAI_AVAILABLE = True
except ImportError:
    CREWAI_AVAILABLE = False


class AgentDecodeCrewObserver:
    """Observer for CrewAI that traces crew execution.

    Wraps ``crew.kickoff()`` in an AgentDecode session with a single
    span. Agent count, task count, and the crew result are captured
    automatically.
    """

    def __init__(self, agent: Any, *, _send_fn: Any = None) -> None:
        self.agent = agent
        self._send_fn = _send_fn

    def run(
        self,
        crew: Any,
        inputs: Optional[Dict[str, Any]] = None,
        session_name: Optional[str] = None,
    ) -> Any:
        """Execute a crew run with full tracing.

        Args:
            crew: A CrewAI ``Crew`` instance.
            inputs: Input dict to pass to ``crew.kickoff()``.
            session_name: Optional override for the session name.
                          Defaults to ``crew.name`` or ``"crew_run"``.

        Returns:
            The result of ``crew.kickoff(inputs=...)``.
        """
        if not CREWAI_AVAILABLE:
            raise ImportError(
                "crewai is not installed. "
                "Install it with: pip install crewai"
            )

        crew_name = session_name or getattr(crew, "name", None) or "crew_run"

        with self.agent.session(crew_name, _send_fn=self._send_fn) as session:
            with session.span("crew.kickoff", span_type="agent") as span:
                span.input = inputs or {}
                span.metadata = {
                    "agents": (
                        len(crew.agents) if hasattr(crew, "agents") else 0
                    ),
                    "tasks": (
                        len(crew.tasks) if hasattr(crew, "tasks") else 0
                    ),
                }

                try:
                    result = crew.kickoff(inputs=inputs or {})
                    try:
                        span.output = {"result": str(result)[:500]}
                    except Exception:
                        span.output = {"result": "<unserializable>"}
                    return result
                except Exception as e:
                    span.error_message = str(e)
                    span._status = "error"
                    raise
