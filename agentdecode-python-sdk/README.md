# agentdecode

Free, open-source observability SDK for AI agents.

Trace every LLM call, tool invocation, and retrieval step your AI agent makes. Catch silent failures, score output quality automatically, and debug agent pipelines with full visibility.

## Installation

```bash
pip install agentdecode
```

## Quick Start

```python
from agentdecode import AgentDecode

agent = AgentDecode(
    api_key="al_your_api_key",
    endpoint="https://agent-decode.vercel.app"
)

# Use as a context manager to group spans into a session
with agent.session("Customer Support Agent") as session:
    with session.span("classify_intent", span_type="llm") as span:
        span.model = "gpt-4o-mini"
        span.input = {"message": "Cancel my subscription"}
        # ... your LLM call here ...
        span.output = {"intent": "cancellation", "confidence": 0.97}
        span.input_tokens = 24
        span.output_tokens = 8
        span.cost_usd = 0.0001

    with session.span("lookup_account", span_type="tool") as span:
        span.input = {"user_id": "usr_9281"}
        # ... your DB call here ...
        span.output = {"plan": "pro", "months_active": 14}

    with session.span("generate_response", span_type="llm") as span:
        span.model = "gpt-4o"
        span.input = {"context": "Pro user, 14 months", "intent": "cancellation"}
        # ... your LLM call here ...
        span.output = {"response": "I understand you'd like to cancel..."}
        span.input_tokens = 85
        span.output_tokens = 120
        span.cost_usd = 0.003

# All spans are sent automatically when the session exits
```

## Nested Spans (Parent-Child)

```python
with agent.session("RAG Pipeline") as session:
    with session.span("orchestrator", span_type="agent") as parent:
        parent.input = {"query": "What is our refund policy?"}

        # Child spans — pass the parent to create hierarchy
        with session.span("search_docs", span_type="retrieval", parent=parent) as s:
            s.input = {"query": "refund policy", "top_k": 5}
            s.output = {"documents": ["doc1", "doc2"], "count": 2}

        with session.span("generate_answer", span_type="llm", parent=parent) as s:
            s.model = "gpt-4o"
            s.input = {"context": ["doc1", "doc2"], "question": "refund policy"}
            s.output = {"answer": "Our refund policy allows..."}

        parent.output = {"answer": "Our refund policy allows..."}
```

## Automatic Span Nesting (contextvars)

Spans nest automatically using Python's `contextvars` — no need to pass `parent` explicitly. Any span created inside another span automatically becomes its child:

```python
from agentdecode import AgentDecode, current_session

agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")

def search_docs(query):
    """This function auto-nests under whatever span is active."""
    session = current_session()
    if session:
        with session.span("search_docs", span_type="retrieval") as span:
            span.input = {"query": query}
            results = vector_db.search(query)
            span.output = {"count": len(results)}
            return results
    return vector_db.search(query)

with agent.session("RAG Agent") as session:
    with session.span("orchestrator", span_type="agent") as parent:
        # search_docs() automatically nests under "orchestrator"
        docs = search_docs("refund policy")

        with session.span("generate", span_type="llm") as s:
            # This also auto-nests under "orchestrator"
            s.model = "gpt-4o"
            s.output = {"answer": "..."}
```

The `current_session()` and `current_span()` functions return the active session/span in the current context, or `None` if called outside a session block.

## OpenAI Auto-Instrumentation

Automatically trace all OpenAI chat completion calls with two lines:

```python
from agentdecode import AgentDecode
from agentdecode.integrations.openai import instrument_openai

agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
instrumentation = instrument_openai(agent)

# Now ALL openai calls inside a session are automatically traced
import openai
client = openai.OpenAI()

with agent.session("My Agent") as session:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Hello!"}]
    )
    # ^ Automatically captured as a span with model, tokens, and cost

# To undo the instrumentation:
instrumentation.uninstrument()
```

Requires: `pip install agentdecode openai`

## LangChain Integration

```python
from agentdecode import AgentDecode
from agentdecode.integrations.langchain import AgentDecodeCallbackHandler

agent = AgentDecode(api_key="al_...", endpoint="https://agent-decode.vercel.app")
handler = AgentDecodeCallbackHandler(agent, session_name="my_chain")

# Drop into any LangChain chain with one line
chain.invoke(input, config={"callbacks": [handler]})
# Automatically captures: LLM calls, tool invocations, token counts, and errors
```

Requires: `pip install agentdecode langchain-core`

## Decorator for Simple Tracing

```python
@agent.trace("classify_intent", span_type="llm")
def classify(message: str) -> dict:
    # Your logic here
    return {"intent": "support", "confidence": 0.95}

# Calling this sends a single-span trace automatically
result = classify("I need help with my order")
```

## Error Tracking

Exceptions inside spans are automatically captured with `status: "error"` and the exception message stored in `error_message`. The session is still sent so you can see exactly where things broke.

```python
with agent.session("Risky Pipeline") as session:
    with session.span("flaky_api_call", span_type="tool") as span:
        span.input = {"url": "https://api.example.com/data"}
        response = requests.get("https://api.example.com/data")
        response.raise_for_status()  # If this throws, it's captured
        span.output = response.json()
```

## Timeout Configuration

Control HTTP timeout, retry count, and total flush timeout:

```python
agent = AgentDecode(
    api_key="al_your_api_key",
    endpoint="https://agent-decode.vercel.app",
    timeout=5,         # seconds per HTTP attempt (default: 10)
    max_retries=2,     # retry count on failure (default: 3)
    flush_timeout=15,  # total seconds before giving up (default: 30)
)
```

- `timeout`: How long each individual HTTP request waits before timing out.
- `max_retries`: How many times to retry on network/server errors (with exponential backoff: 0.5s, 1s, 2s).
- `flush_timeout`: Total wall-clock time allowed for the entire flush (including all retries). If exceeded, a warning is printed and the trace is dropped.

## API Reference

### `AgentDecode(api_key, endpoint, timeout=10, max_retries=3, flush_timeout=30)`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `api_key` | str | ✓ | — | Your API key (starts with `al_`) |
| `endpoint` | str | ✓ | — | Your AgentDecode server URL |
| `timeout` | int | — | 10 | HTTP timeout per request (seconds) |
| `max_retries` | int | — | 3 | Number of retry attempts |
| `flush_timeout` | int | — | 30 | Total flush timeout (seconds) |

### `agent.session(name, session_id=None)`

Returns a `Session` context manager. All spans created inside are batched and sent on exit.

### `session.span(name, span_type="tool", parent=None)`

Returns a `Span` context manager. If `parent` is not provided, automatically nests under the current active span (via contextvars). Set properties on the span object:

| Property | Type | Description |
|----------|------|-------------|
| `input` | any | Input data (any JSON-serializable value) |
| `output` | any | Output data (any JSON-serializable value) |
| `model` | str | Model name (e.g. "gpt-4o") |
| `input_tokens` | int | Input token count |
| `output_tokens` | int | Output token count |
| `cost_usd` | float | Cost in USD |
| `error_message` | str | Error description |
| `metadata` | dict | Custom key-value pairs |

### `@agent.trace(name, span_type="agent")`

Decorator that wraps a function in a single-span session. The function's arguments are captured as `input` and the return value as `output`.

### `current_session() -> Optional[Session]`

Returns the active session in the current context, or `None`.

### `current_span() -> Optional[Span]`

Returns the active span in the current context, or `None`.

## Requirements

- Python ≥ 3.8
- Zero external dependencies (uses only Python stdlib)
- Optional: `langchain-core` for LangChain integration
- Optional: `openai` for OpenAI auto-instrumentation

## License

MIT
