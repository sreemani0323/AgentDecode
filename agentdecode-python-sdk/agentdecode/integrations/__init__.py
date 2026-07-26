"""AgentDecode integrations — optional connectors for popular frameworks."""

# Optional exports — only available when the respective library is installed.
# These are provided for convenience; users can also import directly from
# the submodule (e.g. from agentdecode.integrations.openai import instrument_openai).

try:
    from agentdecode.integrations.openai import instrument_openai
except ImportError:
    pass
