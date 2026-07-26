"""AgentDecode — Free, open-source observability for AI agents."""

from agentdecode.tracer import AgentDecode, Session, Span

__version__ = "0.1.3"
__all__ = ["AgentDecode", "Session", "Span"]

# Optional: export LangChain handler if langchain is installed
try:
    from agentdecode.integrations.langchain import AgentDecodeCallbackHandler

    __all__.append("AgentDecodeCallbackHandler")
except ImportError:
    pass  # langchain not installed, that's fine
