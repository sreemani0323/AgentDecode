"""AgentDecode integrations — optional connectors for popular frameworks."""

# Optional exports — only available when the respective library is installed.
# These are provided for convenience; users can also import directly from
# the submodule (e.g. from agentdecode.integrations.openai import instrument_openai).

try:
    from agentdecode.integrations.langchain import AgentDecodeCallbackHandler
except ImportError:
    pass

try:
    from agentdecode.integrations.openai import instrument_openai
except ImportError:
    pass

try:
    from agentdecode.integrations.anthropic import instrument_anthropic
except ImportError:
    pass

try:
    from agentdecode.integrations.llamaindex import AgentDecodeLlamaIndexHandler
except ImportError:
    pass

try:
    from agentdecode.integrations.crewai import AgentDecodeCrewObserver
except ImportError:
    pass
