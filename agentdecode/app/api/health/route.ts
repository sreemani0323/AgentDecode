import { NextResponse } from 'next/server'
import { checkEnv } from '@/lib/env'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

/** Application version — bump on each release. */
const APP_VERSION = '0.1.0'

type CheckStatus = 'ok' | 'degraded' | 'error'

interface CheckDetail {
  status: CheckStatus
  latency_ms?: number
  message?: string
  details?: string[]
}

interface HealthResponse {
  status: CheckStatus
  version: string
  timestamp: string
  checks: {
    env: CheckDetail
    database: CheckDetail
  }
}

/**
 * GET /api/health
 *
 * Returns a structured health report. No auth required so that external
 * uptime monitors (e.g. Betteruptime, Pingdom) can poll it freely.
 */
export async function GET() {
  const timestamp = new Date().toISOString()

  // ── Environment check ─────────────────────────────────────────────
  let envCheck: CheckDetail

  try {
    const envResult = checkEnv()

    if (!envResult.ok) {
      envCheck = {
        status: 'error',
        message: 'Required environment variables are missing',
        details: envResult.missing.map((m) => m.key),
      }
    } else if (envResult.warnings.length > 0) {
      envCheck = {
        status: 'degraded',
        message: 'Optional environment variables are not set',
        details: envResult.warnings.map((w) => w.key),
      }
    } else {
      envCheck = { status: 'ok' }
    }
  } catch (err) {
    envCheck = {
      status: 'error',
      message: err instanceof Error ? err.message : 'Unknown env check error',
    }
  }

  // ── Database check ────────────────────────────────────────────────
  let dbCheck: CheckDetail

  try {
    // Dynamic import so the file still parses even if supabase env vars
    // are missing (the createServiceClient call will throw instead).
    const { createServiceClient } = await import('@/lib/supabase/server')
    const supabase = createServiceClient()

    const start = performance.now()
    const { error } = await supabase.rpc('', {}).maybeSingle()
    // If the rpc call itself errors because '' is not a function, fall back
    // to a simple query that Supabase always supports.
    if (error) {
      // Fallback: run a raw select via PostgREST
      const start2 = performance.now()
      const { error: fallbackError } = await supabase
        .from('projects')
        .select('id')
        .limit(1)
      const latency = Math.round(performance.now() - start2)

      if (fallbackError) {
        throw fallbackError
      }

      dbCheck = { status: 'ok', latency_ms: latency }
    } else {
      const latency = Math.round(performance.now() - start)
      dbCheck = { status: 'ok', latency_ms: latency }
    }
  } catch (err) {
    logger.error('Health check: database connectivity failed', err instanceof Error ? err : undefined, {
      check: 'database',
    })
    dbCheck = {
      status: 'error',
      message: err instanceof Error ? err.message : 'Database unreachable',
    }
  }

  // ── Overall status rollup ─────────────────────────────────────────
  let overall: CheckStatus = 'ok'
  if (envCheck.status === 'error' || dbCheck.status === 'error') {
    overall = 'error'
  } else if (envCheck.status === 'degraded' || dbCheck.status === 'degraded') {
    overall = 'degraded'
  }

  const body: HealthResponse = {
    status: overall,
    version: APP_VERSION,
    timestamp,
    checks: {
      env: envCheck,
      database: dbCheck,
    },
  }

  const httpStatus = overall === 'error' ? 503 : 200

  return NextResponse.json(body, {
    status: httpStatus,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
}
