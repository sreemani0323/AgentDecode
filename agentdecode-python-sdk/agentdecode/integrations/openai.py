"""
OpenAI auto-instrumentation for AgentDecode.

Patches the OpenAI client to automatically trace all chat completion calls.
OpenAI is an optional dependency — the SDK works without it.

Usage::

    from agentdecode import AgentDecode
    from agentdecode.integrations.openai import instrument_openai

    agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
    instrument_openai(agent)

    # Now ALL openai calls are automatically traced when inside a session
    client = openai.OpenAI()
    with agent.session("my_run") as session:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "Hello"}]
        )
        # ^ This is automatically captured as a span
"""

from __future__ import annotations

from typing import Any, Optional

from agentdecode.tracer import _current_session, _current_span

# Try to import openai
try:
    import openai
    import openai.resources.chat.completions

    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False


class AgentDecodeOpenAIInstrumentation:
    """Auto-instruments the OpenAI client to trace all chat completion calls.

    Wraps ``client.chat.completions.create()`` so that each call
    automatically produces an AgentDecode span with model, tokens,
    input messages, and output captured.

    When no session is active (``current_session()`` returns None), calls
    pass through without any tracing overhead.
    """

    def __init__(self, agent: Any) -> None:
        if not OPENAI_AVAILABLE:
            raise ImportError(
                "openai is not installed. "
                "Install it with: pip install openai"
            )
        self.agent = agent
        self._original_create: Any = None
        self._patched_target: Any = None

    def instrument(self, client: Any = None) -> "AgentDecodeOpenAIInstrumentation":
        """Patch the OpenAI client to auto-trace chat completions.

        Args:
            client: Optional specific OpenAI client instance to instrument.
                    If None, instruments all OpenAI clients globally by
                    patching the class method.

        Returns:
            self (for chaining or later calling .uninstrument())
        """
        if not OPENAI_AVAILABLE:
            raise ImportError(
                "openai is not installed. "
                "Install it with: pip install openai"
            )

        if client is None:
            # Patch the class method for all clients
            target = openai.resources.chat.completions.Completions
        else:
            target = client.chat.completions

        original_create = target.create
        self._original_create = original_create
        self._patched_target = target

        def traced_create(completions_self: Any, *args: Any, **kwargs: Any) -> Any:
            session = _current_session.get()

            if session is None:
                # No active session — just call through without tracing
                return original_create(completions_self, *args, **kwargs)

            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages", [])

            # Build a span name from the model
            span_name = f"openai.chat.{model}"

            with session.span(span_name, span_type="llm") as span:
                span.model = model
                span.input = {
                    "messages": [
                        {
                            "role": m.get("role", "unknown"),
                            "content": str(m.get("content", ""))[:200],
                        }
                        for m in (messages[-3:] if messages else [])  # last 3 messages only
                    ]
                }

                try:
                    response = original_create(completions_self, *args, **kwargs)

                    # Extract output
                    if hasattr(response, "choices") and response.choices:
                        choice = response.choices[0]
                        if hasattr(choice, "message") and choice.message:
                            content = getattr(choice.message, "content", None)
                            if content:
                                span.output = {"content": content[:500]}

                    # Extract token usage
                    if hasattr(response, "usage") and response.usage:
                        usage = response.usage
                        if hasattr(usage, "prompt_tokens") and usage.prompt_tokens is not None:
                            span.input_tokens = usage.prompt_tokens
                        if hasattr(usage, "completion_tokens") and usage.completion_tokens is not None:
                            span.output_tokens = usage.completion_tokens
                        # Rough cost estimation
                        total = getattr(usage, "total_tokens", 0) or 0
                        if "gpt-4o" in model and "mini" not in model:
                            span.cost_usd = total * 0.000005
                        elif "gpt-4o-mini" in model:
                            span.cost_usd = total * 0.0000002

                    return response

                except Exception as e:
                    span.error_message = str(e)
                    span._status = "error"
                    raise

        target.create = traced_create
        return self

    def uninstrument(self, client: Any = None) -> None:
        """Restore the original ``create`` method."""
        if self._original_create is not None and self._patched_target is not None:
            self._patched_target.create = self._original_create
            self._original_create = None
            self._patched_target = None


def instrument_openai(agent: Any, client: Any = None) -> AgentDecodeOpenAIInstrumentation:
    """Convenience function to instrument OpenAI with one line.

    Args:
        agent: AgentDecode instance.
        client: Optional specific OpenAI client instance to instrument.
                If None, instruments all OpenAI clients globally.

    Returns:
        AgentDecodeOpenAIInstrumentation instance (call .uninstrument() to undo).
    """
    instrumentation = AgentDecodeOpenAIInstrumentation(agent)
    return instrumentation.instrument(client=client)
