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
    endpoint="https://your-app.vercel.app"
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

## API Reference

### `AgentDecode(api_key, endpoint)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `api_key` | str | ✓ | Your API key (starts with `al_`) |
| `endpoint` | str | ✓ | Your AgentDecode server URL |

### `agent.session(name, session_id=None)`

Returns a `Session` context manager. All spans created inside are batched and sent on exit.

### `session.span(name, span_type="tool", parent=None)`

Returns a `Span` context manager. Set properties on the span object:

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

## Requirements

- Python ≥ 3.8
- Zero external dependencies (uses only Python stdlib)

## License

MIT
