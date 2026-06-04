/**
 * In-memory Token Bucket Rate Limiter
 * 
 * Provides basic protection against API abuse without external dependencies.
 * Resets on serverless cold starts, which is acceptable for our use case.
 * 
 * Each unique identifier (IP or API key) gets its own token bucket.
 * Tokens refill at a steady rate. Each request consumes one token.
 */

interface TokenBucket {
  tokens: number
  lastRefill: number
}

interface RateLimiterConfig {
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

class RateLimiter {
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

/**
 * Extract the client identifier from a request.
 * Prefers the API key (unique per project), falls back to IP.
 */
export function getClientIdentifier(request: Request, apiKey?: string): string {
  if (apiKey) return `key:${apiKey}`

  // Check forwarded headers (Vercel, Cloudflare, etc.)
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return `ip:${forwarded.split(',')[0].trim()}`

  const realIp = request.headers.get('x-real-ip')
  if (realIp) return `ip:${realIp}`

  return 'ip:unknown'
}
