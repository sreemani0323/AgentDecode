import { BookOpen, Terminal, Zap, Code2, Box, Globe } from "lucide-react"
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
        <a href="#quickstart" className="p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors group">
          <Terminal className="w-5 h-5 text-primary mb-2" />
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">Quickstart</h3>
          <p className="text-xs text-muted-foreground mt-1">Send your first trace in 30 seconds</p>
        </a>
        <a href="#examples" className="p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors group">
          <Code2 className="w-5 h-5 text-primary mb-2" />
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">Code Examples</h3>
          <p className="text-xs text-muted-foreground mt-1">Python, JavaScript, and cURL examples</p>
        </a>
        <a href="#api-reference" className="p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors group">
          <BookOpen className="w-5 h-5 text-primary mb-2" />
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">API Reference</h3>
          <p className="text-xs text-muted-foreground mt-1">Full ingest API specification</p>
        </a>
      </div>

      {/* Quickstart */}
      <section id="quickstart" className="space-y-4">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Quickstart — Direct HTTP Integration</h2>
        </div>

        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">
              Works with any language — no SDK installation required.
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            AgentDecode uses a simple HTTP API. Send a{" "}
            <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">POST</code> request to{" "}
            <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">/api/ingest</code> with your API key and span data. That&apos;s it.
          </p>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">1. Get an API key</h4>
            <p className="text-sm text-muted-foreground">
              Create a project from{" "}
              <Link href="/dashboard" className="text-primary hover:underline">your dashboard</Link>, then go to{" "}
              <strong className="text-foreground">Project Settings → API Keys</strong> to generate one.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">2. Send a trace</h4>
            <p className="text-sm text-muted-foreground">
              Use any HTTP client to POST your trace data. Here&apos;s a minimal example:
            </p>
            <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
              <code>{`curl -X POST https://your-domain.com/api/ingest \\
  -H "Authorization: Bearer al_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "session_name": "My Agent Session",
    "spans": [
      {
        "name": "classify_intent",
        "span_type": "llm",
        "model": "gpt-4o",
        "status": "ok",
        "started_at": "2026-01-01T12:00:00Z",
        "ended_at": "2026-01-01T12:00:01Z",
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
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">3. View in dashboard</h4>
            <p className="text-sm text-muted-foreground">
              Your session appears immediately. Click any span to inspect inputs, outputs, eval scores, and AI-generated failure explanations.
            </p>
          </div>
        </div>
      </section>

      {/* Code Examples */}
      <section id="examples" className="space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Code Examples</h2>
        </div>

        {/* Python example */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">Python</h3>
          <p className="text-sm text-muted-foreground">
            Uses only the standard <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">requests</code> library. No extra dependencies.
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`import requests
from datetime import datetime, timezone

API_KEY = "al_your_key_here"
ENDPOINT = "https://your-domain.com/api/ingest"

def send_trace(session_name, spans):
    """Send a trace session to AgentDecode."""
    response = requests.post(
        ENDPOINT,
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"session_name": session_name, "spans": spans}
    )
    response.raise_for_status()
    return response.json()

# ── Example: Instrument a 3-step AI agent ──────────────
now = datetime.now(timezone.utc)

result = send_trace("Customer Support Agent", [
    {
        "name": "classify_intent",
        "span_type": "llm",
        "status": "ok",
        "model": "gpt-4o-mini",
        "started_at": now.isoformat(),
        "ended_at": now.isoformat(),
        "duration_ms": 450,
        "input": {"message": "Cancel my subscription"},
        "output": {"intent": "cancellation", "confidence": 0.97},
        "input_tokens": 24,
        "output_tokens": 8,
        "cost_usd": 0.0001,
        "client_span_id": "span-1"
    },
    {
        "name": "lookup_account",
        "span_type": "tool",
        "status": "ok",
        "started_at": now.isoformat(),
        "ended_at": now.isoformat(),
        "duration_ms": 120,
        "input": {"user_id": "usr_9281"},
        "output": {"plan": "pro", "months_active": 14},
        "client_span_id": "span-2",
        "parent_client_span_id": "span-1"
    },
    {
        "name": "generate_response",
        "span_type": "llm",
        "status": "ok",
        "model": "gpt-4o",
        "started_at": now.isoformat(),
        "ended_at": now.isoformat(),
        "duration_ms": 900,
        "input": {"context": "Pro user, 14 months", "intent": "cancellation"},
        "output": {"response": "I understand you'd like to cancel..."},
        "input_tokens": 85,
        "output_tokens": 120,
        "cost_usd": 0.003,
        "client_span_id": "span-3",
        "parent_client_span_id": "span-1"
    }
])

print(f"Session: {result['session_id']}")
print(f"Spans ingested: {result['spans_ingested']}")`}</code>
          </pre>
        </div>

        {/* JavaScript/Node.js example */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">JavaScript / Node.js</h3>
          <p className="text-sm text-muted-foreground">
            Uses only built-in <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">fetch</code>. Zero dependencies.
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`const API_KEY = "al_your_key_here";
const ENDPOINT = "https://your-domain.com/api/ingest";

async function sendTrace(sessionName, spans) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${API_KEY}\`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ session_name: sessionName, spans })
  });
  return response.json();
}

// ── Example: Instrument a 3-step AI agent ──────────────
const now = new Date().toISOString();

const result = await sendTrace("Customer Support Agent", [
  {
    name: "classify_intent",
    span_type: "llm",
    status: "ok",
    model: "gpt-4o-mini",
    started_at: now,
    ended_at: now,
    duration_ms: 450,
    input: { message: "Cancel my subscription" },
    output: { intent: "cancellation", confidence: 0.97 },
    input_tokens: 24,
    output_tokens: 8,
    cost_usd: 0.0001,
    client_span_id: "span-1"
  },
  {
    name: "lookup_account",
    span_type: "tool",
    status: "ok",
    started_at: now,
    ended_at: now,
    duration_ms: 120,
    input: { user_id: "usr_9281" },
    output: { plan: "pro", months_active: 14 },
    client_span_id: "span-2",
    parent_client_span_id: "span-1"  // child of classify_intent
  },
  {
    name: "generate_response",
    span_type: "llm",
    status: "ok",
    model: "gpt-4o",
    started_at: now,
    ended_at: now,
    duration_ms: 900,
    input: { context: "Pro user, 14 months", intent: "cancellation" },
    output: { response: "I understand you'd like to cancel..." },
    input_tokens: 85,
    output_tokens: 120,
    cost_usd: 0.003,
    client_span_id: "span-3",
    parent_client_span_id: "span-1"  // child of classify_intent
  }
]);

console.log(\`Session: \${result.session_id}\`);
console.log(\`Spans ingested: \${result.spans_ingested}\`);`}</code>
          </pre>
        </div>

        {/* Planned SDK note */}
        <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
          <p className="text-sm text-muted-foreground">
            <strong className="text-primary">Looking for a typed SDK?</strong>{" "}
            A TypeScript and Python SDK with automatic instrumentation is planned.
            For now, the HTTP API above gives you full functionality in any language.
          </p>
        </div>
      </section>

      {/* Key Concepts */}
      <section id="concepts" className="space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Key Concepts</h2>
        </div>

        {/* Parent-child spans */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">Parent-child spans</h3>
          <p className="text-sm text-muted-foreground">
            Use <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">client_span_id</code> and{" "}
            <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">parent_client_span_id</code> to
            build a span tree. AgentDecode resolves these into real database relationships, so your dashboard
            shows the full call hierarchy.
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`{
  "spans": [
    { "name": "agent",        "client_span_id": "a" },
    { "name": "classify",     "client_span_id": "b", "parent_client_span_id": "a" },
    { "name": "search_docs",  "client_span_id": "c", "parent_client_span_id": "a" },
    { "name": "generate",     "client_span_id": "d", "parent_client_span_id": "a" }
  ]
}`}</code>
          </pre>
        </div>

        {/* Error tracking */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">Error tracking</h3>
          <p className="text-sm text-muted-foreground">
            Set <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">status: &quot;error&quot;</code> and{" "}
            <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">error_message</code> on any span
            to flag failures. AgentDecode automatically groups identical errors into issues with occurrence counts.
          </p>
          <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
            <code>{`{
  "name": "search_knowledge_base",
  "span_type": "retrieval",
  "status": "error",
  "error_message": "Connection timeout after 3 retries",
  "started_at": "2026-01-01T12:00:00Z",
  "ended_at": "2026-01-01T12:00:03Z",
  "duration_ms": 3000,
  "input": { "query": "order status", "top_k": 5 },
  "output": null
}`}</code>
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

      {/* API Reference — Ingest endpoint */}
      <section id="api-reference" className="space-y-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold text-foreground">API Reference</h2>
        </div>

        {/* POST /api/ingest */}
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <h3 className="text-base font-semibold text-foreground">
            POST <code className="font-mono text-primary">/api/ingest</code>
          </h3>
          <p className="text-sm text-muted-foreground">
            Send trace data to AgentDecode. Requires a valid API key in the Authorization header.
          </p>

          {/* Request body fields */}
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Field</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Type</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Required</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 text-sm">
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">session_name</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">Name for this trace session</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">spans</td>
                  <td className="px-4 py-2 text-muted-foreground">array</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">Array of span objects (at least 1)</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Span fields */}
          <h4 className="text-sm font-semibold text-foreground mt-4">Span Object Fields</h4>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Field</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Type</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Required</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 text-sm">
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">name</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">Name of the operation</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">span_type</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">One of: llm, tool, retrieval, chain, agent</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">status</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">One of: ok, error</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">started_at</td>
                  <td className="px-4 py-2 text-muted-foreground">ISO 8601</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">When the operation started</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">ended_at</td>
                  <td className="px-4 py-2 text-muted-foreground">ISO 8601</td>
                  <td className="px-4 py-2 text-green-400">✓</td>
                  <td className="px-4 py-2 text-muted-foreground">When the operation ended</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">model</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Model name (e.g. gpt-4o, claude-3.5-sonnet)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">duration_ms</td>
                  <td className="px-4 py-2 text-muted-foreground">number</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Duration in milliseconds</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">input</td>
                  <td className="px-4 py-2 text-muted-foreground">object</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Input data (any JSON)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">output</td>
                  <td className="px-4 py-2 text-muted-foreground">object</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Output data (any JSON)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">input_tokens</td>
                  <td className="px-4 py-2 text-muted-foreground">number</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Input token count</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">output_tokens</td>
                  <td className="px-4 py-2 text-muted-foreground">number</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Output token count</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">cost_usd</td>
                  <td className="px-4 py-2 text-muted-foreground">number</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Cost in USD</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">error_message</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Error description (when status is &quot;error&quot;)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">client_span_id</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Your local span ID (for parent-child linking)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">parent_client_span_id</td>
                  <td className="px-4 py-2 text-muted-foreground">string</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Parent span&apos;s client_span_id</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">metadata</td>
                  <td className="px-4 py-2 text-muted-foreground">object</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">Any custom key-value pairs</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Response */}
          <div className="mt-4 space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Response</h4>
            <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto">
              <code>{`{
  "session_id": "uuid",
  "span_ids": ["uuid", "uuid", "uuid"],
  "spans_ingested": 3
}`}</code>
            </pre>
          </div>

          {/* Rate limit */}
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
