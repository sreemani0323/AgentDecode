import { BookOpen, Terminal, Zap, Code2, Box, ChevronRight } from "lucide-react"
import Link from "next/link"

export default function DocsPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto w-full space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Documentation</h1>
        <p className="text-muted-foreground mt-1">
          Everything you need to integrate AgentDecode into your AI agent pipeline.
        </p>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <a href="#installation" className="p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors group">
          <Terminal className="w-5 h-5 text-primary mb-2" />
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">Installation</h3>
          <p className="text-xs text-muted-foreground mt-1">Get the SDK set up in 30 seconds</p>
        </a>
        <a href="#tracing" className="p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors group">
          <Zap className="w-5 h-5 text-primary mb-2" />
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">Tracing</h3>
          <p className="text-xs text-muted-foreground mt-1">Wrap functions for automatic tracing</p>
        </a>
        <a href="#api-reference" className="p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors group">
          <Code2 className="w-5 h-5 text-primary mb-2" />
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">API Reference</h3>
          <p className="text-xs text-muted-foreground mt-1">Full SDK configuration & methods</p>
        </a>
      </div>

      {/* Installation */}
      <section id="installation" className="space-y-4">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Installation</h2>
        </div>

        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <p className="text-sm text-muted-foreground">
            Install the TypeScript SDK from npm:
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto">
            <code>npm install @agentdecode/sdk</code>
          </pre>
          <p className="text-sm text-muted-foreground">
            Then initialize with your API key (get one from{" "}
            <Link href="/dashboard" className="text-primary hover:underline">Project Settings → API Keys</Link>):
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`import { AgentDecode } from '@agentdecode/sdk'

const lens = new AgentDecode({
  apiKey: 'al_sk_your_api_key_here',
  endpoint: 'https://your-app.vercel.app/api/ingest',
})`}</code>
          </pre>
        </div>
      </section>

      {/* Tracing */}
      <section id="tracing" className="space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Tracing</h2>
        </div>

        {/* Simple trace */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">Simple function wrapping</h3>
          <p className="text-sm text-muted-foreground">
            Wrap any async function with <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">lens.trace()</code>.
            AgentDecode automatically captures input, output, timing, and errors.
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`const classifyIntent = lens.trace(
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

// Use it like a normal function
const result = await classifyIntent('Cancel my subscription')`}</code>
          </pre>
        </div>

        {/* Session tracing */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">Multi-step sessions</h3>
          <p className="text-sm text-muted-foreground">
            For complex agent workflows with multiple steps, create a session to group related traces:
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`const session = lens.session('Customer Support Agent')

const classify = session.trace(
  'classify_intent',
  { type: 'llm', model: 'gpt-4o-mini' },
  async (span, message: string) => {
    const result = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: message }],
    })
    span.setTokens(result.usage.prompt_tokens, result.usage.completion_tokens)
    return result.choices[0].message
  }
)

const lookupCustomer = session.trace(
  'lookup_customer',
  { type: 'tool' },
  async (span, userId: string) => {
    return await db.customers.findById(userId)
  }
)

// Run the pipeline
const intent = await classify('Cancel my subscription')
const customer = await lookupCustomer('usr_9281')

// Flush all spans to AgentDecode
await session.end()`}</code>
          </pre>
        </div>

        {/* Manual spans */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">Manual span control</h3>
          <p className="text-sm text-muted-foreground">
            For cases where you need full control over span lifecycle:
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`const session = lens.session('Data Pipeline')

const span = session.startSpan('fetch_documents', { type: 'retrieval' })
span.setInput({ query: 'quarterly revenue', top_k: 5 })

try {
  const docs = await vectorStore.search('quarterly revenue', 5)
  span.setOutput({ documents: docs, count: docs.length })
  span.end()
  session.addSpan(span)
} catch (error) {
  span.end({ error_message: error.message })
  session.addSpan(span)
}

await session.end()`}</code>
          </pre>
        </div>
      </section>

      {/* Span Types */}
      <section id="span-types" className="space-y-4">
        <div className="flex items-center gap-2">
          <Box className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Span Types</h2>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Type</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">When to use</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              <tr>
                <td className="px-6 py-3"><code className="text-sm font-mono px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">llm</code></td>
                <td className="px-6 py-3 text-sm text-muted-foreground">LLM API calls (OpenAI, Anthropic, Gemini, etc.)</td>
              </tr>
              <tr>
                <td className="px-6 py-3"><code className="text-sm font-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">tool</code></td>
                <td className="px-6 py-3 text-sm text-muted-foreground">External tool/API calls, database queries, HTTP requests</td>
              </tr>
              <tr>
                <td className="px-6 py-3"><code className="text-sm font-mono px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">retrieval</code></td>
                <td className="px-6 py-3 text-sm text-muted-foreground">Vector search, document retrieval, knowledge base lookups</td>
              </tr>
              <tr>
                <td className="px-6 py-3"><code className="text-sm font-mono px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">chain</code></td>
                <td className="px-6 py-3 text-sm text-muted-foreground">Multi-step chains or pipelines (LangChain, etc.)</td>
              </tr>
              <tr>
                <td className="px-6 py-3"><code className="text-sm font-mono px-2 py-0.5 rounded bg-teal-500/10 text-teal-400 border border-teal-500/20">agent</code></td>
                <td className="px-6 py-3 text-sm text-muted-foreground">Top-level agent orchestration (parent of all other spans)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* API Reference */}
      <section id="api-reference" className="space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">API Reference</h2>
        </div>

        {/* AgentDecode constructor */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground font-mono">new AgentDecode(config)</h3>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Option</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Type</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Required</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 text-sm">
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">apiKey</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">Your AgentDecode API key</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">endpoint</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">The ingest endpoint URL</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">debug</td>
                  <td className="px-4 py-2 text-muted-foreground">boolean</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Enable console logging</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">timeout</td>
                  <td className="px-4 py-2 text-muted-foreground">number</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Request timeout in ms (default: 10000)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">disabled</td>
                  <td className="px-4 py-2 text-muted-foreground">boolean</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Disable tracing (for tests)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* SpanHandle methods */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground font-mono">SpanHandle</h3>
          <p className="text-sm text-muted-foreground">
            The span handle is passed as the first argument to session.trace() callbacks:
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Method</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 text-sm">
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setInput(data)</td>
                  <td className="px-4 py-2 text-muted-foreground">Set input data for the span</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setOutput(data)</td>
                  <td className="px-4 py-2 text-muted-foreground">Set output data for the span</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setModel(model)</td>
                  <td className="px-4 py-2 text-muted-foreground">Set the model name (e.g. &apos;gpt-4o&apos;)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setTokens(in, out)</td>
                  <td className="px-4 py-2 text-muted-foreground">Set token usage counts</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setCost(usd)</td>
                  <td className="px-4 py-2 text-muted-foreground">Set cost in USD</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setMetadata(key, value)</td>
                  <td className="px-4 py-2 text-muted-foreground">Add custom metadata</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.setError(message)</td>
                  <td className="px-4 py-2 text-muted-foreground">Mark the span as errored</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">.end(options?)</td>
                  <td className="px-4 py-2 text-muted-foreground">Finalize the span</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Ingest API */}
      <section id="ingest-api" className="space-y-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Ingest API</h2>
        </div>

        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">
            POST <code className="font-mono text-primary">/api/ingest</code>
          </h3>
          <p className="text-sm text-muted-foreground">
            The SDK sends telemetry to this endpoint. You can also call it directly for custom integrations:
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`curl -X POST https://your-app.vercel.app/api/ingest \\
  -H "Authorization: Bearer al_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "session_name": "My Agent Session",
    "spans": [
      {
        "name": "classify_intent",
        "span_type": "llm",
        "model": "gpt-4o",
        "status": "ok",
        "started_at": "2026-06-04T12:00:00Z",
        "ended_at": "2026-06-04T12:00:01Z",
        "duration_ms": 1000,
        "input": { "message": "Hello" },
        "output": { "intent": "greeting" },
        "input_tokens": 10,
        "output_tokens": 5,
        "cost_usd": 0.001
      }
    ]
  }'`}</code>
          </pre>

          <div className="mt-4 space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Response</h4>
            <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto">
              <code>{`{
  "session_id": "uuid",
  "span_ids": ["uuid"],
  "spans_ingested": 1
}`}</code>
            </pre>
          </div>

          <div className="mt-4 p-4 rounded-lg bg-yellow-500/5 border border-yellow-500/20">
            <p className="text-sm text-muted-foreground">
              <strong className="text-yellow-400">Rate Limit:</strong> The ingest API allows bursts of up to 50 requests with a sustained rate of 5 requests/second per API key. Exceeding this returns <code className="text-xs bg-muted/50 px-1 py-0.5 rounded font-mono">429 Too Many Requests</code>.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
