# AgentDecode Python SDK

Free, open-source observability for AI agents.

## Install
```bash
pip install agentdecode
```

## Quickstart (2 lines)
```python
from agentdecode import init

tracer = init("al_your_key_here")
```

## Usage — Decorator
```python
@tracer.span("llm.call", span_type="llm")
def call_llm(prompt):
    return "Response"
```

## Usage — Context Manager
```python
with tracer.session("my_agent") as session:
    with session.span("search", span_type="tool") as span:
        span.input = {"query": "weather"}
        results = search("weather")
        span.output = results
    
    with session.span("llm.generate", span_type="llm") as span:
        span.model = "gemini-1.5-flash"
        span.input = {"prompt": "Analyze weather"}
        response = call_llm(results)
        span.output = response
```

## LangChain Integration
```python
from agentdecode.integrations import AgentDecodeCallbackHandler

handler = AgentDecodeCallbackHandler(api_key="al_your_key")
chain.invoke(input, config={"callbacks": [handler]})
```
