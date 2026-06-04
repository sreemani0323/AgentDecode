# AgentDecode

**Open-source observability for AI agents.** Trace every LLM call, tool execution, and decision your agent makes — then debug failures with AI-powered diagnostics.

[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres-green)](https://supabase.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What is AgentDecode?

AI agents are opaque. When they fail, you get a stack trace — not an explanation. AgentDecode gives you full visibility into every step:

- **Trace** LLM calls, tool executions, retrieval steps, and agent decisions in a hierarchical timeline
- **Auto-evaluate** response quality with Groq-powered scoring (0–10 scale)
- **Debug** failures with AI-generated root cause analysis and suggested fixes
- **Monitor** error rates, latency, and costs with real-time analytics
- **Alert** on error rate spikes, latency regressions, or cost anomalies
- **Export** high-quality traces as fine-tuning datasets (JSONL format)
- **Compare** sessions side-by-side to spot regressions
- **Search** across all sessions and spans with ⌘K command palette

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 18, TypeScript |
| Styling | Tailwind CSS, shadcn/ui, Satoshi + Clash Display fonts |
| Database | Supabase (Postgres + Row Level Security) |
| Auth | Supabase Auth (email/password + Google OAuth) |
| AI — Eval Scoring | Groq (llama-3.3-70b-versatile) |
| AI — Error Diagnosis | Google Gemini (gemini-2.0-flash) |
| Email | Resend |
| SDK | TypeScript (CJS/ESM via tsup) |

**Total cost to run: $0.** Everything uses free tiers.

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) account (free tier)
- A [Groq](https://console.groq.com) API key (free tier)

### 1. Clone the repo

```bash
git clone https://github.com/your-username/agentdecode.git
cd agentdecode/agentdecode
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up Supabase

1. Create a new Supabase project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. Go to **SQL Editor** and run the contents of [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql)
3. Go to **Authentication → Providers** and enable Email and (optionally) Google OAuth

### 4. Configure environment variables

```bash
cp .env.local.example .env.local
```

Fill in the values from your Supabase dashboard and API keys.

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you'll see the landing page. Sign up to access the dashboard.

---

## Project Structure

```
agentdecode/
├── app/
│   ├── (auth)/          # Login, signup, password reset
│   ├── (dashboard)/     # Protected dashboard pages
│   │   ├── dashboard/   # Projects list, issues, team, docs, settings
│   │   ├── projects/    # Project detail, analytics, alerts, compare
│   │   └── sessions/    # Session detail with trace viewer
│   ├── api/             # API routes (ingest, keys, projects, search, etc.)
│   └── page.tsx         # Public landing page
├── components/          # Reusable UI components
│   ├── ui/              # shadcn/ui primitives
│   ├── dashboard/       # Dashboard-specific components
│   ├── sessions/        # Session table, trace viewer
│   └── charts/          # Recharts wrappers
├── lib/                 # Utilities
│   ├── supabase/        # Client & server Supabase clients
│   ├── groq.ts          # Groq eval scoring
│   ├── gemini.ts        # Gemini error diagnosis
│   ├── rate-limit.ts    # Token bucket rate limiter
│   └── alerts.ts        # Alert rule evaluation
├── packages/sdk/        # @agentdecode/sdk (TypeScript)
├── supabase/
│   └── migrations/      # Database schema (SQL)
└── types/               # Shared TypeScript interfaces
```

## TypeScript SDK Usage

The easiest way to integrate AgentDecode in Node.js/TypeScript environments is using the official SDK.

```bash
npm install @agentdecode/sdk
```

```typescript
import { AgentDecode } from '@agentdecode/sdk'

const lens = new AgentDecode({
  apiKey: 'al_sk_your_api_key',
  projectId: 'your-project-id',
  endpoint: 'https://your-app.vercel.app/api/ingest', // Optional: Use for self-hosting
})

const sessionId = `session_${Date.now()}`;

// Wrap any function to trace it automatically
const classify = lens.trace(
  'classify_intent',
  { type: 'llm' },
  async (message: string) => {
    // ... your logic ...
    return "support";
  }
)

await classify(sessionId, 'I need help with my order')
```

See the [SDK documentation](packages/sdk/README.md) for full details.

---

## Direct HTTP Integration

Send traces from any language using a simple POST request to the `/api/ingest` endpoint.

```javascript
const response = await fetch('https://your-app.vercel.app/api/ingest', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer al_sk_your_api_key',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    projectId: 'your-project-id',
    sessionId: `session_${Date.now()}`,
    spans: [
      {
        name: 'classify_intent',
        type: 'llm',
        status: 'success',
        duration_ms: 450,
        input: { message: 'I need help with my order' },
        output: { intent: 'support', confidence: 0.95 },
        tokens_prompt: 45,
        tokens_completion: 12,
        cost_usd: 0.0001
      }
    ]
  })
});
```

Check the `app/(dashboard)/projects/[id]/page.tsx` or `app/(dashboard)/projects/[id]/settings/page.tsx` for dynamic snippets tailored to your project.

---

## Deploying to Vercel

1. Push your repo to GitHub
2. Import the project in [Vercel](https://vercel.com/new)
3. Set the **Root Directory** to `agentdecode`
4. Add all environment variables from `.env.local.example`
5. Deploy

The app will be live at `your-project.vercel.app`.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anonymous key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (server-only, bypasses RLS) |
| `GROQ_API_KEY` | ✅ | Groq API key for eval scoring |
| `GEMINI_API_KEY` | Optional | Google Gemini key for AI error diagnosis |
| `RESEND_API_KEY` | Optional | Resend key for alert emails |
| `NEXT_PUBLIC_SITE_URL` | Optional | Your deployment URL (for SDK snippets) |

---

## License

MIT
