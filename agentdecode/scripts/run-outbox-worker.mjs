#!/usr/bin/env node
/**
 * Standalone Operator Runner for Evaluation Outbox Worker
 * Usage:
 *   node scripts/run-outbox-worker.mjs [--batch-size=20] [--endpoint=http://localhost:3000]
 */

const args = process.argv.slice(2)
let endpoint = process.env.WORKER_ENDPOINT || 'http://localhost:3000'
let batchSize = 10

for (const arg of args) {
  if (arg.startsWith('--endpoint=')) endpoint = arg.split('=')[1]
  if (arg.startsWith('--batch-size=')) batchSize = parseInt(arg.split('=')[1], 10)
}

const secret = process.env.EVAL_WORKER_SECRET || process.env.CRON_SECRET || 'local_dev_secret'

console.log(`[AgentDecode Worker] Triggering evaluation outbox worker at ${endpoint}/api/workers/eval-outbox (batch: ${batchSize})...`)

async function run() {
  try {
    const res = await fetch(`${endpoint}/api/workers/eval-outbox?batch_size=${batchSize}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
    })

    const body = await res.json()
    console.log(`[AgentDecode Worker] Status: ${res.status}`, body)
    if (!res.ok) process.exit(1)
  } catch (err) {
    console.error('[AgentDecode Worker] Execution failed:', err.message)
    process.exit(1)
  }
}

run()

