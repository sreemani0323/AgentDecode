# AgentDecode

**Open-source observability for AI agents.** Trace every LLM call, tool execution, and decision your agent makes — then debug failures with AI-powered diagnostics.

[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres-green)](https://supabase.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What is AgentDecode?

AI agents are complex and often fail silently. When they return wrong answers, hallucinate, or get stuck in loops, you get a generic HTTP status — not an explanation. AgentDecode gives you full visibility into every step:

- **Trace** LLM calls, tool executions, retrieval steps, and agent decisions in a hierarchical timeline.
- **Auto-evaluate** response quality with Groq-powered scoring (0–10 scale).
- **Debug** failures with AI-generated root cause analysis and suggested fixes.
- **Monitor** error rates, latency, and costs with real-time analytics.
- **Alert** on error rate spikes, latency regressions, or cost anomalies.
- **Export** high-quality traces as fine-tuning datasets (JSONL format).
- **Compare** sessions side-by-side to spot regressions.
- **Search** across all sessions and spans with a ⌘K command palette.

## Project Structure

This repository is a monorepos containing:
* [**agentdecode/**](file:///agentdecode) - The Next.js Next 16 web application / backend dashboard.
* [**packages/sdk/**](file:///packages/sdk) - TypeScript / JavaScript SDK for instrumenting Node.js/web applications.
* [**agentdecode-sdk/**](file:///agentdecode-sdk) - Python SDK for instrumenting Python agents.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 18, TypeScript |
| Styling | Vanilla CSS (Aesthetic glassmorphism and animations) |
| Database | Supabase (Postgres + Row Level Security) |
| Auth | Supabase Auth (email/password + Google OAuth) |
| AI — Eval Scoring | Groq (llama-3.3-70b-versatile) |
| AI — Error Diagnosis | Google Gemini (gemini-2.0-flash) |
| Email | Resend |
| SDK | TypeScript (CJS/ESM via tsup) & Python |

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/sreemani0323/AgentDecode.git
cd AgentDecode
```

### 2. Set up the Web Dashboard

1. Navigate to the app directory:
   ```bash
   cd agentdecode
   ```
2. Install dependencies:
   ```bash
   npm install --legacy-peer-deps
   ```
3. Set up environment variables:
   ```bash
   cp .env.local.example .env.local
   ```
   Fill in the required Supabase credentials, Groq API keys, and optionally Resend/Gemini.
4. Apply the Supabase migration:
   - Create a database at [supabase.com](https://supabase.com).
   - Copy the SQL from `agentdecode/supabase/migrations/001_initial_schema.sql` and run it in the SQL Editor on Supabase.
5. Start development server:
   ```bash
   npm run dev
   ```

### 3. Instrument Your Agent

#### Node.js / TypeScript SDK

Install the SDK package:
```bash
npm install @agentdecode/sdk
```

Instrument your code:
```typescript
import { AgentDecode } from '@agentdecode/sdk'

const tracker = new AgentDecode({
  apiKey: 'al_sk_your_api_key',
  projectId: 'your-project-id',
  endpoint: 'https://your-domain.vercel.app/api/ingest', // Optional: for self-hosted
})

const sessionId = `session_${Date.now()}`;

// Trace functions automatically
const runAgent = tracker.trace(
  'agent_execution',
  { type: 'agent' },
  async (query: string) => {
    // Agent logic here
    return "Result";
  }
)

await runAgent(sessionId, "What is the capital of France?")
```

#### Python SDK

Navigate to `agentdecode-sdk/` for instructions and python package installation details.

---

## Deploying to Vercel

1. Push your repository to GitHub.
2. Link the repository in [Vercel](https://vercel.com/new).
3. Set **Root Directory** to `agentdecode`.
4. Configure all environment variables (from `.env.local.example`).
5. Deploy.

---

## License

MIT
