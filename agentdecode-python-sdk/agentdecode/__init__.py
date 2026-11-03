"""AgentDecode — Free, open-source observability for AI agents."""

from agentdecode.tracer import AgentDecode, Session, Span, current_session, current_span
from agentdecode.wal import (
    SQLiteWAL,
    WALBatch,
    DeadLetterBatch,
    WALError,
    WALCapacityError,
    WALStorageError,
    WALCorruptedError,
)

__version__ = "0.1.5"
__all__ = [
    "AgentDecode",
    "Session",
    "Span",
    "SQLiteWAL",
    "WALBatch",
    "DeadLetterBatch",
    "WALError",
    "WALCapacityError",
    "WALStorageError",
    "WALCorruptedError",
    "current_session",
    "current_span",
    "__version__",
]

# Optional: export LangChain handler if langchain is installed
try:
    from agentdecode.integrations.langchain import AgentDecodeCallbackHandler

    __all__.append("AgentDecodeCallbackHandler")
except ImportError:
    pass  # langchain not installed, that's fine
