"""
Anthropic auto-instrumentation for AgentDecode.

Patches the Anthropic client to automatically trace all message creation calls.
Anthropic is an optional dependency — the SDK works without it.

Usage::

    from agentdecode import AgentDecode
    from agentdecode.integrations.anthropic import instrument_anthropic

    agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
    instrument_anthropic(agent)

    # Now ALL anthropic calls are automatically traced when inside a session
    client = anthropic.Anthropic()
    with agent.session("my_run") as session:
        response = client.messages.create(
            model="claude-opus-4-5",
            messages=[{"role": "user", "content": "Hello"}]
        )
        # ^ This is automatically captured as a span
"""

from __future__ import annotations

from typing import Any, Optional

from agentdecode.tracer import _current_session, _current_span

# Try to import anthropic
try:
    import anthropic
    import anthropic.resources.messages

    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False


class AgentDecodeAnthropicInstrumentation:
    """Auto-instruments the Anthropic client to trace all message creation calls.

    Wraps ``client.messages.create()`` so that each call automatically
    produces an AgentDecode span with model, tokens, input messages,
    and output captured.

    When no session is active (``current_session()`` returns None), calls
    pass through without any tracing overhead.
    """

    def __init__(self, agent: Any) -> None:
        if not ANTHROPIC_AVAILABLE:
            raise ImportError(
                "anthropic is not installed. "
                "Install it with: pip install anthropic"
            )
        self.agent = agent
        self._original_create: Any = None
        self._patched_target: Any = None

    def instrument(self, client: Any = None) -> "AgentDecodeAnthropicInstrumentation":
        """Patch the Anthropic client to auto-trace message creation.

        Args:
            client: Optional specific Anthropic client instance to instrument.
                    If None, instruments all Anthropic clients globally by
                    patching the class method.

        Returns:
            self (for chaining or later calling .uninstrument())
        """
        if not ANTHROPIC_AVAILABLE:
            raise ImportError(
                "anthropic is not installed. "
                "Install it with: pip install anthropic"
            )

        if client is None:
            # Patch the class method for all clients
            target = anthropic.resources.messages.Messages
        else:
            target = client.messages

        original_create = target.create
        self._original_create = original_create
        self._patched_target = target

        def traced_create(messages_self: Any, *args: Any, **kwargs: Any) -> Any:
            session = _current_session.get()

            if session is None:
                # No active session — just call through without tracing
                return original_create(messages_self, *args, **kwargs)

            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages", [])

            # Build a span name from the model
            span_name = f"anthropic.messages.{model}"

            with session.span(span_name, span_type="llm") as span:
                span.model = model
                span.input = {
                    "messages": [
                        {
                            "role": m.get("role", "unknown"),
                            "content": str(m.get("content", ""))[:200],
                        }
                        for m in (messages[-3:] if messages else [])
                    ]
                }

                try:
                    response = original_create(messages_self, *args, **kwargs)

                    # Extract output
                    if hasattr(response, "content") and response.content:
                        first_block = response.content[0]
                        text = getattr(first_block, "text", None)
                        if text:
                            span.output = {"content": text[:500]}

                    # Extract token usage
                    if hasattr(response, "usage") and response.usage:
                        usage = response.usage
                        input_tok = getattr(usage, "input_tokens", None)
                        output_tok = getattr(usage, "output_tokens", None)
                        if input_tok is not None:
                            span.input_tokens = input_tok
                        if output_tok is not None:
                            span.output_tokens = output_tok

                        # Cost estimation
                        total = (input_tok or 0) + (output_tok or 0)
                        if "claude-opus" in model:
                            span.cost_usd = total * 0.000015
                        elif "claude-sonnet" in model:
                            span.cost_usd = total * 0.000003
                        elif "claude-haiku" in model:
                            span.cost_usd = total * 0.00000025

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


def instrument_anthropic(agent: Any, client: Any = None) -> AgentDecodeAnthropicInstrumentation:
    """Convenience function to instrument Anthropic with one line.

    Args:
        agent: AgentDecode instance.
        client: Optional specific Anthropic client instance to instrument.
                If None, instruments all Anthropic clients globally.

    Returns:
        AgentDecodeAnthropicInstrumentation instance (call .uninstrument() to undo).
    """
    instrumentation = AgentDecodeAnthropicInstrumentation(agent)
    return instrumentation.instrument(client=client)
