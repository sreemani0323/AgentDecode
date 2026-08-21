# @agentdecode/sdk

TypeScript SDK for [AgentDecode](https://agent-decode.vercel.app) — free, open-source observability for AI agents.

Trace LLM calls, catch silent failures, score output quality. Zero lock-in.

## Install

```bash
npm install @agentdecode/sdk
```

## Quick Start

```typescript
import { AgentDecode } from '@agentdecode/sdk'

const agent = new AgentDecode({
  apiKey: 'al_your_key_here',
  endpoint: 'https://agent-decode.vercel.app',
})

// Group related operations in a session
await agent.session('Customer Support Agent').run(async (session) => {
  // Each span tracks one operation
  await session.span('classify_intent', 'llm').run(async (span) => {
    span.model = 'gpt-4o'
    span.input = { message: 'I need to return my order' }

    const result = await classifyIntent(message)

    span.output = result
    span.inputTokens = result.usage.prompt_tokens
    span.outputTokens = result.usage.completion_tokens
  })

  await session.span('lookup_order', 'tool').run(async (span) => {
    span.input = { orderId: '12345' }
    const order = await lookupOrder('12345')
    span.output = order
  })
})
// ^ Session auto-flushes all spans on completion
```

## One-Line Tracing

```typescript
// Wraps a function in a single-span session
const result = await agent.trace('quick_classify', 'llm', async () => {
  return await classify(message)
})
```

## OpenAI Auto-Instrumentation

```typescript
import { AgentDecode } from '@agentdecode/sdk'
import { instrumentOpenAI } from '@agentdecode/sdk/integrations/openai'
import OpenAI from 'openai'

const agent = new AgentDecode({ apiKey: 'al_...' })
const openai = new OpenAI()
const cleanup = instrumentOpenAI(agent, openai)

// All chat.completions.create() calls are now traced
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
})
// ^ Automatically captured with model, tokens, and cost

cleanup() // restore original when done
```

## LangChain Integration

```typescript
import { AgentDecode } from '@agentdecode/sdk'
import { AgentDecodeCallbackHandler } from '@agentdecode/sdk/integrations/langchain'

const agent = new AgentDecode({ apiKey: 'al_...' })
const handler = new AgentDecodeCallbackHandler(agent, 'my_chain')

const result = await chain.invoke(input, {
  callbacks: [handler],
})

await handler.flush() // send all collected spans
```

## Nested Spans

```typescript
await agent.session('RAG Pipeline').run(async (session) => {
  await session.span('retrieve', 'retrieval').run(async (retrieveSpan) => {
    retrieveSpan.input = { query: 'refund policy' }

    // This span auto-nests under "retrieve"
    await session.span('embed_query', 'llm').run(async (embedSpan) => {
      embedSpan.model = 'text-embedding-3-small'
      // ...
    })

    retrieveSpan.output = { documents: docs }
  })

  await session.span('generate', 'llm').run(async (genSpan) => {
    genSpan.model = 'gpt-4o'
    // ...
  })
})
```

## Error Tracking

Exceptions inside spans are automatically captured with `status: "error"`. The session still flushes so you see exactly where things broke.

```typescript
await agent.session('Risky Pipeline').run(async (session) => {
  await session.span('flaky_api', 'tool').run(async (span) => {
    span.input = { url: 'https://api.example.com/data' }
    const response = await fetch('https://api.example.com/data')
    if (!response.ok) throw new Error(`API returned ${response.status}`)
    span.output = await response.json()
  })
})
```

## Configuration

```typescript
const agent = new AgentDecode({
  apiKey: 'al_your_key',
  endpoint: 'https://agent-decode.vercel.app', // default
  timeout: 5,      // seconds per HTTP attempt (default: 10)
  maxRetries: 2,   // retry count on failure (default: 3)
})
```

## API Reference

### `new AgentDecode(options)`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `apiKey` | string | ✓ | — | Your API key (starts with `al_`) |
| `endpoint` | string | — | `https://agent-decode.vercel.app` | Server URL |
| `timeout` | number | — | 10 | HTTP timeout per request (seconds) |
| `maxRetries` | number | — | 3 | Number of retry attempts |

### `agent.session(name, sessionId?)`

Returns a `SessionRunner`. Call `.run(async (session) => { ... })` to execute.

### `session.span(name, spanType?)`

Returns a `SpanContext`. Call `.run(async (span) => { ... })` to execute.

| Property | Type | Description |
|----------|------|-------------|
| `span.input` | any | Input data (JSON-serializable) |
| `span.output` | any | Output data (JSON-serializable) |
| `span.model` | string | Model name (e.g. `"gpt-4o"`) |
| `span.inputTokens` | number | Input token count |
| `span.outputTokens` | number | Output token count |
| `span.costUsd` | number | Cost in USD |
| `span.errorMessage` | string | Error description |
| `span.metadata` | object | Custom key-value pairs |

### `agent.trace(name, spanType, fn)`

Convenience: wraps a function in a single-span session.

## Requirements

- Node.js ≥ 18 (uses `fetch` and `crypto.randomUUID`)
- TypeScript ≥ 5.0 (optional, ships with `.d.ts` files)
- Zero runtime dependencies
- Optional: `openai` for OpenAI auto-instrumentation
- Optional: `@langchain/core` for LangChain integration

## License

MIT
