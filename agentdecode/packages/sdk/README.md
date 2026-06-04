# @agentdecode/sdk

The official TypeScript SDK for AgentDecode.

## Installation

```bash
npm install @agentdecode/sdk
```

## Usage

```typescript
import { AgentDecode } from '@agentdecode/sdk'

const lens = new AgentDecode({
  apiKey: 'al_sk_...',
  projectId: 'project-id',
  endpoint: 'http://localhost:3000/api/ingest', // Optional: Use for self-hosting
})

const sessionId = `session_${Date.now()}`;

const classify = lens.trace(
  'classify_intent',
  { type: 'llm' },
  async (message: string) => {
    // ... your logic ...
    return "support";
  }
)

// Call it, passing the sessionId as the first argument
await classify(sessionId, 'I need help with my order')
```
