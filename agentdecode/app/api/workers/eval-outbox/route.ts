import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { EvaluationOutboxWorker } from '@/lib/outbox-worker'
import { logger } from '@/lib/logger'

// Bound execution to Vercel Hobby serverless function ceiling (10s)
export const maxDuration = 10

/**
 * Verify worker authorization secret using constant-time comparison to prevent timing attacks.
 */
function verifyWorkerSecret(request: Request): boolean {
  const configuredSecret = process.env.EVAL_WORKER_SECRET || process.env.CRON_SECRET
  if (!configuredSecret) {
    // If no worker secret is configured in production, fail closed
    if (process.env.NODE_ENV === 'production') {
      logger.error('EVAL_WORKER_SECRET and CRON_SECRET are not configured; rejecting outbox worker trigger')
      return false
    }
    // Only in non-production local dev if no secret configured
    return true
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false
  }

  const token = authHeader.slice(7).trim()
  if (!token) return false

  const tokenBuf = Buffer.from(token)
  const secretBuf = Buffer.from(configuredSecret)

  if (tokenBuf.length !== secretBuf.length) {
    return false
  }

  return crypto.timingSafeEqual(tokenBuf, secretBuf)
}

async function handleWorkerRun(request: Request) {
  if (!verifyWorkerSecret(request)) {
    return NextResponse.json(
      { error: 'Unauthorized: invalid or missing evaluation worker secret' },
      { status: 401 }
    )
  }

  // Parse optional parameters from URL search params or POST JSON body
  let bodyJson: Record<string, unknown> = {}
  if (request.method === 'POST') {
    try {
      const cloned = request.clone()
      bodyJson = (await cloned.json()) || {}
    } catch {
      // Body may be empty or plain text; searchParams fallback applies
    }
  }

  const { searchParams } = new URL(request.url)
  const rawBatchSize = searchParams.get('batch_size') ?? (bodyJson.batch_size as string | number)
  const rawMaxTime = searchParams.get('max_time_ms') ?? (bodyJson.max_time_ms as string | number)

  // Vercel Hobby safe defaults: 5 jobs, 8,000ms execution budget (strictly under 10s ceiling)
  const parsedBatchSize = rawBatchSize !== undefined ? parseInt(String(rawBatchSize), 10) : 5
  const parsedMaxTimeMs = rawMaxTime !== undefined ? parseInt(String(rawMaxTime), 10) : 8_000

  const batchSize = isNaN(parsedBatchSize) || parsedBatchSize <= 0 ? 5 : parsedBatchSize
  const maxExecutionTimeMs = isNaN(parsedMaxTimeMs) || parsedMaxTimeMs <= 0 ? 8_000 : Math.min(parsedMaxTimeMs, 9_000)

  try {
    const worker = new EvaluationOutboxWorker()
    const result = await worker.processBatch({
      batchSize,
      maxExecutionTimeMs,
    })

    return NextResponse.json({
      status: 'ok',
      ...result,
    })
  } catch (err: any) {
    logger.error('Unhandled error in evaluation outbox worker endpoint', err)
    return NextResponse.json(
      { error: 'Internal worker execution error: ' + (err?.message || 'unknown') },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  return handleWorkerRun(request)
}

export async function POST(request: Request) {
  return handleWorkerRun(request)
}
