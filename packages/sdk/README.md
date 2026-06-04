# @agentdecode/sdk

> Observability for AI agents. Trace every LLM call, tool execution, and decision your agent makes — in one line of code.

[![npm](https://img.shields.io/npm/v/@agentdecode/sdk)](https://www.npmjs.com/package/@agentdecode/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why AgentDecode?

AI agents are opaque. When they fail, you get a stack trace — not an explanation. AgentDecode gives you full visibility into every step:

- **Trace** LLM calls, tool executions, retrieval steps, and agent decisions
- **Auto-evaluate** response quality with built-in Groq-powered scoring
- **Debug** failures with an interactive trace viewer and prompt playground
- **Export** high-quality traces as fine-tuning datasets

---

## Install

```bash
npm install @agentdecode/sdk
```

---

## Quick Start

### 1. Initialize the client

```ts
import { AgentDecode } from '@agentdecode/sdk'

const lens = new AgentDecode({
  apiKey: 'al_sk_your_api_key_here',
  endpoint: 'https://your-app.vercel.app/api/ingest',
})
```

### 2. Trace a function (simplest)

Wrap any async function. AgentDecode automatically captures input, output, timing, and errors.

```ts
const classifyIntent = lens.trace(
  'classify_intent',
  { type: 'llm', model: 'gpt-4o' },
  async (userMessage: string) => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: userMessage }],
    })
    return response.choices[0].message
  }
)

// Use it like a normal function — tracing happens automatically
const result = await classifyIntent('I want to cancel my subscription')
```

### 3. Trace a multi-step session

For complex agent workflows with multiple steps:

```ts
const session = lens.session('Customer Support Agent')

// Step 1: Classify intent
const classify = session.trace(
  'classify_intent',
  { type: 'llm', model: 'gpt-4o-mini' },
  async (span, message: string) => {
    const result = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: message }],
    })

    // Optionally enrich the span with token usage
    span.setTokens(result.usage.prompt_tokens, result.usage.completion_tokens)

    return result.choices[0].message
  }
)

// Step 2: Look up customer
const lookupCustomer = session.trace(
  'lookup_customer',
  { type: 'tool' },
  async (span, userId: string) => {
    const customer = await db.customers.findById(userId)
    return customer
  }
)

// Step 3: Generate response
const generateResponse = session.trace(
  'generate_response',
  { type: 'llm', model: 'gpt-4o' },
  async (span, context: object) => {
    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful support agent.' },
        { role: 'user', content: JSON.stringify(context) },
      ],
    })

    span.setTokens(result.usage.prompt_tokens, result.usage.completion_tokens)
    span.setCost(0.004)

    return result.choices[0].message
  }
)

// Run the pipeline
const intent = await classify('Cancel my subscription')
const customer = await lookupCustomer('usr_9281')
const response = await generateResponse({ intent, customer })

// Flush all spans to AgentDecode
await session.end()
```

### 4. Manual span control

For cases where you need full control:

```ts
const session = lens.session('Data Pipeline')

const span = session.startSpan('fetch_documents', { type: 'retrieval' })
span.setInput({ query: 'quarterly revenue report', top_k: 5 })

try {
  const docs = await vectorStore.search('quarterly revenue report', 5)
  span.setOutput({ documents: docs, count: docs.length })
  span.end()
  session.addSpan(span)
} catch (error) {
  span.end({ error_message: error.message })
  session.addSpan(span)
}

await session.end()
```

---

## API Reference

### `new AgentDecode(config)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `apiKey` | `string` | ✅ | Your AgentDecode API key |
| `endpoint` | `string` | ✅ | The ingest endpoint URL |
| `debug` | `boolean` | | Enable console logging |
| `timeout` | `number` | | Request timeout in ms (default: 10000) |
| `disabled` | `boolean` | | Disable tracing (for tests) |
| `headers` | `Record<string, string>` | | Custom headers |

### `lens.session(options)`

Create a new tracing session. Accepts a string (session name) or an options object:

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Human-readable session name |
| `sessionId` | `string` | External ID for linking |

### `lens.trace(name, options, fn)`

Wrap a function for automatic tracing with fire-and-forget flushing.

### `session.trace(name, options, fn)`

Wrap a function within a session. The function receives a `SpanHandle` as its first argument.

### `SpanHandle`

| Method | Description |
|--------|-------------|
| `.setInput(data)` | Set input data |
| `.setOutput(data)` | Set output data |
| `.setModel(model)` | Set the model name |
| `.setTokens(in, out)` | Set token usage |
| `.setCost(usd)` | Set cost in USD |
| `.setMetadata(key, value)` | Add custom metadata |
| `.setError(message)` | Mark as error |
| `.end(options?)` | Finalize the span |

---

## Span Types

| Type | When to use |
|------|-------------|
| `llm` | LLM API calls (OpenAI, Anthropic, etc.) |
| `tool` | External tool/API calls |
| `retrieval` | Vector search, document retrieval |
| `chain` | Multi-step chains or pipelines |
| `agent` | Top-level agent orchestration |

---

## Framework Integrations

### LangChain

```ts
import { AgentDecode } from '@agentdecode/sdk'

const lens = new AgentDecode({ apiKey: '...', endpoint: '...' })
const session = lens.session('LangChain RAG')

// Trace each step of your chain
const retriever = session.trace('retrieve', { type: 'retrieval' }, async (span, query) => {
  return await vectorStore.similaritySearch(query, 5)
})

const generator = session.trace('generate', { type: 'llm', model: 'gpt-4o' }, async (span, docs) => {
  return await chain.invoke({ documents: docs })
})
```

### Vercel AI SDK

```ts
import { generateText } from 'ai'
import { AgentDecode } from '@agentdecode/sdk'

const lens = new AgentDecode({ apiKey: '...', endpoint: '...' })

const chat = lens.trace('chat', { type: 'llm', model: 'gpt-4o' }, async (prompt: string) => {
  return await generateText({ model: openai('gpt-4o'), prompt })
})
```

---

## License

MIT
