import { NextResponse } from 'next/server'

/**
 * Rate Limiting Infrastructure: In-memory & Distributed Token Bucket
 *
 * Ingress & Reverse Proxy Header Ordering:
 * 1. `x-vercel-forwarded-for`: Set by Vercel Edge Network. Cannot be spoofed by external clients.
 * 2. `cf-connecting-ip`: Set by Cloudflare Edge Network.
 * 3. `x-real-ip`: Standard reverse proxy header set by Nginx / AWS ALB.
 * 4. `x-forwarded-for`: Standard proxy chain header; take the leftmost client IP.
 * 5. Fallback: 'unknown'
 */

interface TokenBucket {
  tokens: number
  lastRefill: number
}

export interface RateLimiterConfig {
  /** Maximum tokens in the bucket (burst capacity) */
  maxTokens: number
  /** Tokens added per second (sustained rate) */
  refillRate: number
  /** Time in ms before an idle bucket is garbage-collected */
  ttlMs: number
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxTokens: 50,      // Allow bursts of up to 50 requests
  refillRate: 5,       // Refill 5 tokens per second (300 req/min sustained)
  ttlMs: 5 * 60_000,  // Clean up buckets idle for 5 minutes
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>()
  private config: RateLimiterConfig
  private lastCleanup = Date.now()
  private cleanupIntervalMs = 60_000 // Run cleanup every 60 seconds

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Attempt to consume a token for the given identifier.
   * @returns `{ allowed: true, remaining }` if the request is allowed,
   *          `{ allowed: false, retryAfterMs }` if rate-limited.
   */
  check(identifier: string): {
    allowed: boolean
    remaining: number
    retryAfterMs: number
  } {
    const now = Date.now()
    this.maybeCleanup(now)

    let bucket = this.buckets.get(identifier)

    if (!bucket) {
      // First request from this identifier — start with a full bucket
      bucket = { tokens: this.config.maxTokens, lastRefill: now }
      this.buckets.set(identifier, bucket)
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefill
    const tokensToAdd = (elapsedMs / 1000) * this.config.refillRate
    bucket.tokens = Math.min(this.config.maxTokens, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now

    if (bucket.tokens >= 1) {
      // Consume a token
      bucket.tokens -= 1
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
      }
    }

    // Not enough tokens — calculate when one will be available
    const deficit = 1 - bucket.tokens
    const retryAfterMs = Math.ceil((deficit / this.config.refillRate) * 1000)

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    }
  }

  /**
   * Reset all buckets (for test isolation).
   */
  reset() {
    this.buckets.clear()
  }

  /**
   * Garbage-collect idle buckets to prevent memory leaks.
   */
  private maybeCleanup(now: number) {
    if (now - this.lastCleanup < this.cleanupIntervalMs) return
    this.lastCleanup = now

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.config.ttlMs) {
        this.buckets.delete(key)
      }
    }
  }
}

// Singleton instances — shared across all requests on the same serverless instance
export const ingestRateLimiter = new RateLimiter({
  maxTokens: 50,   // Burst: 50 requests
  refillRate: 5,    // Sustained: 5 req/s ≈ 300 req/min
  ttlMs: 5 * 60_000,
})

export const apiReadRateLimiter = new RateLimiter({
  maxTokens: 100,  // Burst: 100 requests
  refillRate: 10,  // Sustained: 10 req/s
  ttlMs: 5 * 60_000,
})

export const apiWriteRateLimiter = new RateLimiter({
  maxTokens: 30,   // Burst: 30 requests
  refillRate: 3,    // Sustained: 3 req/s
  ttlMs: 5 * 60_000,
})

export const aiRateLimiter = new RateLimiter({
  maxTokens: 10,   // Burst: 10 requests
  refillRate: 1,    // Sustained: 1 req/s
  ttlMs: 5 * 60_000,
})

/**
 * Safely extracts client IP address following trusted ingress precedence.
 */
export function getClientIp(request: Request): string {
  // 1. Vercel Edge Network
  const vercelIp = request.headers.get('x-vercel-forwarded-for')
  if (vercelIp) return vercelIp.split(',')[0].trim()

  // 2. Cloudflare Edge Network
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp) return cfIp.trim()

  // 3. Standard Reverse Proxy (Nginx, ALB)
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()

  // 4. Standard X-Forwarded-For chain
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()

  return 'unknown'
}

/**
 * Extract the client identifier from a request.
 * Prefers the API key (unique per project), falls back to IP.
 * API keys are hashed so raw secrets are never stored in the in-memory rate limiter map.
 */
export function getClientIdentifier(request: Request, apiKey?: string): string {
  if (apiKey) {
    // Fast non-crypto hash for bucketing — raw key never stored in memory
    let hash = 0
    for (let i = 0; i < apiKey.length; i++) {
      const chr = apiKey.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0 // Convert to 32-bit integer
    }
    return `key:${hash.toString(36)}`
  }

  const ip = getClientIp(request)
  return `ip:${ip}`
}

/**
 * Helper to check rate limit for a request based on route type (synchronous in-memory).
 * Returns { allowed: true } or { allowed: false, response: NextResponse }
 */
export function checkRateLimit(
  request: Request,
  type: 'read' | 'write' | 'ai' | 'ingest'
): { allowed: true } | { allowed: false; response: NextResponse } {
  const limiter =
    type === 'read'
      ? apiReadRateLimiter
      : type === 'write'
      ? apiWriteRateLimiter
      : type === 'ai'
      ? aiRateLimiter
      : ingestRateLimiter

  const clientId = getClientIdentifier(request)
  const rateCheck = limiter.check(clientId)

  if (!rateCheck.allowed) {
    return {
      allowed: false,
      response: NextResponse.json(
        {
          error: 'Rate limit exceeded. Please slow down.',
          retry_after_ms: rateCheck.retryAfterMs,
        },
        {
          status: 429,
          headers: {
            'Retry-After': Math.max(1, Math.ceil(rateCheck.retryAfterMs / 1000)).toString(),
            'X-RateLimit-Remaining': '0',
          },
        }
      ),
    }
  }

  return { allowed: true }
}

export interface DistributedRateLimitContext {
  apiKey?: string
  projectId?: string
  supabase?: any
  cost?: number
}

const RATE_CONFIGS: Record<string, RateLimiterConfig> = {
  ingest: { maxTokens: 50, refillRate: 5, ttlMs: 300_000 },
  read: { maxTokens: 100, refillRate: 10, ttlMs: 300_000 },
  write: { maxTokens: 30, refillRate: 3, ttlMs: 300_000 },
  ai: { maxTokens: 10, refillRate: 1, ttlMs: 300_000 },
}

/**
 * Distributed Token Bucket Rate Limiter using PostgreSQL atomic RPC `consume_rate_limit_token`.
 * Falls back to local in-memory RateLimiter if database is unavailable or unconfigured.
 */
export async function checkDistributedRateLimit(
  request: Request,
  type: 'read' | 'write' | 'ai' | 'ingest',
  context?: DistributedRateLimitContext
): Promise<{ allowed: true; remaining: number } | { allowed: false; response: NextResponse }> {
  const config = RATE_CONFIGS[type] || DEFAULT_CONFIG
  const cost = context?.cost ?? 1

  let key: string
  if (context?.projectId) {
    key = `project:${context.projectId}:${type}`
  } else if (context?.apiKey) {
    key = `${getClientIdentifier(request, context.apiKey)}:${type}`
  } else {
    key = `ip:${getClientIp(request)}:${type}`
  }

  let supabase = context?.supabase
  if (!supabase) {
    try {
      const { createServiceClient } = await import('@/lib/supabase/server')
      supabase = createServiceClient()
    } catch {
      // Supabase unavailable in test / isolated run
    }
  }

  // Attempt distributed rate limiting via PostgreSQL RPC
  if (supabase && typeof supabase.rpc === 'function') {
    try {
      const { data, error } = await supabase.rpc('consume_rate_limit_token', {
        p_key: key,
        p_max_tokens: config.maxTokens,
        p_refill_rate: config.refillRate,
        p_cost: cost,
        p_ttl_seconds: Math.ceil(config.ttlMs / 1000),
      })

      if (!error && data) {
        const row = Array.isArray(data) ? data[0] : data
        if (row && typeof row.allowed === 'boolean') {
          if (!row.allowed) {
            const retryAfterSec = Math.max(1, Math.ceil((row.retry_after_ms || 1000) / 1000))
            return {
              allowed: false,
              response: NextResponse.json(
                {
                  error: 'Rate limit exceeded. Please slow down.',
                  retry_after_ms: row.retry_after_ms,
                },
                {
                  status: 429,
                  headers: {
                    'Retry-After': retryAfterSec.toString(),
                    'X-RateLimit-Remaining': '0',
                  },
                }
              ),
            }
          }

          return {
            allowed: true,
            remaining: Math.floor(Number(row.remaining || 0)),
          }
        }
      }
    } catch {
      // Database call threw; fall through to memory limiter
    }
  }

  // Fallback to local in-memory token bucket
  const limiter =
    type === 'read'
      ? apiReadRateLimiter
      : type === 'write'
      ? apiWriteRateLimiter
      : type === 'ai'
      ? aiRateLimiter
      : ingestRateLimiter

  const checkResult = limiter.check(key)
  if (!checkResult.allowed) {
    return {
      allowed: false,
      response: NextResponse.json(
        {
          error: 'Rate limit exceeded. Please slow down.',
          retry_after_ms: checkResult.retryAfterMs,
        },
        {
          status: 429,
          headers: {
            'Retry-After': Math.max(1, Math.ceil(checkResult.retryAfterMs / 1000)).toString(),
            'X-RateLimit-Remaining': '0',
          },
        }
      ),
    }
  }

  return {
    allowed: true,
    remaining: checkResult.remaining,
  }
}
