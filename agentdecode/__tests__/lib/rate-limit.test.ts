import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { RateLimiter, getClientIdentifier, ingestRateLimiter, checkRateLimit } from '@/lib/rate-limit'

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('allows requests up to maxTokens (burst capacity)', () => {
    const limiter = new RateLimiter({
      maxTokens: 3,
      refillRate: 1,
      ttlMs: 60000
    })

    // Consume all 3 tokens
    const res1 = limiter.check('client1')
    expect(res1.allowed).toBe(true)
    expect(res1.remaining).toBe(2)

    const res2 = limiter.check('client1')
    expect(res2.allowed).toBe(true)
    expect(res2.remaining).toBe(1)

    const res3 = limiter.check('client1')
    expect(res3.allowed).toBe(true)
    expect(res3.remaining).toBe(0)

    // 4th request should be rate limited
    const res4 = limiter.check('client1')
    expect(res4.allowed).toBe(false)
    expect(res4.remaining).toBe(0)
    expect(res4.retryAfterMs).toBeGreaterThan(0)
  })

  test('refills tokens over time', () => {
    const limiter = new RateLimiter({
      maxTokens: 5,
      refillRate: 2, // 2 tokens per second
      ttlMs: 60000
    })

    // Consume 3 tokens
    limiter.check('client1')
    limiter.check('client1')
    const res = limiter.check('client1')
    expect(res.remaining).toBe(2)

    // Advance time by 500ms -> should refill 1 token (0.5 * 2)
    vi.advanceTimersByTime(500)

    // Consume 1 token
    const resAfterRefill = limiter.check('client1')
    expect(resAfterRefill.allowed).toBe(true)
    // bucket started at 2, got 1 refilled (now 3), consumed 1 (now 2)
    expect(resAfterRefill.remaining).toBe(2)
  })

  test('calculates correct retryAfterMs when rate-limited', () => {
    const limiter = new RateLimiter({
      maxTokens: 1,
      refillRate: 0.5, // 1 token every 2 seconds
      ttlMs: 60000
    })

    // Consume the only token
    limiter.check('client1')

    // Immediate next request should fail
    const res = limiter.check('client1')
    expect(res.allowed).toBe(false)
    // Deficit is 1. refillRate is 0.5. Deficit / refillRate = 2 seconds = 2000ms
    expect(res.retryAfterMs).toBe(2000)

    // Advance 1 second. Deficit is now 0.5. retryAfterMs should be 0.5 / 0.5 = 1 second = 1000ms
    vi.advanceTimersByTime(1000)
    const res2 = limiter.check('client1')
    expect(res2.allowed).toBe(false)
    expect(res2.retryAfterMs).toBe(1000)
  })

  test('cleans up idle buckets via maybeCleanup', () => {
    const limiter = new RateLimiter({
      maxTokens: 5,
      refillRate: 1,
      ttlMs: 1000 // 1 second TTL
    })

    // Create a bucket for client1
    limiter.check('client1')

    // Advance time past TTL (1000ms) and past cleanup interval (default 60s, wait, the class has a default 60s)
    // Since class cleanupIntervalMs is 60_000, we need to advance past 60s to trigger cleanup
    vi.advanceTimersByTime(65000)

    // Check a new client to trigger maybeCleanup
    limiter.check('client2')

    // client1 should have been cleaned up.
    // If it was cleaned up, checking it again should start with a fresh bucket (remaining: 4)
    const res = limiter.check('client1')
    expect(res.remaining).toBe(4)
  })

  test('singleton ingestRateLimiter is exported and configured', () => {
    expect(ingestRateLimiter).toBeInstanceOf(RateLimiter)
  })
})

describe('getClientIdentifier', () => {
  test('returns key identifier if apiKey is provided', () => {
    const req = new Request('http://localhost/api')
    expect(getClientIdentifier(req, 'my-secret-key')).toBe('key:my-secret-key')
  })

  test('returns x-forwarded-for header IP if present', () => {
    const req = new Request('http://localhost/api', {
      headers: {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18'
      }
    })
    expect(getClientIdentifier(req)).toBe('ip:203.0.113.195')
  })

  test('returns x-real-ip header IP if present and x-forwarded-for is missing', () => {
    const req = new Request('http://localhost/api', {
      headers: {
        'x-real-ip': '198.51.100.1'
      }
    })
    expect(getClientIdentifier(req)).toBe('ip:198.51.100.1')
  })

  test('returns unknown if headers are missing', () => {
    const req = new Request('http://localhost/api')
    expect(getClientIdentifier(req)).toBe('ip:unknown')
  })
})

describe('checkRateLimit', () => {
  test('returns allowed true when under limit', () => {
    const req = new Request('http://localhost/api')
    const res = checkRateLimit(req, 'read')
    expect(res.allowed).toBe(true)
  })

  test('returns allowed false and NextResponse when rate limited', () => {
    const req = new Request('http://localhost/api')
    // Consume all tokens
    for (let i = 0; i < 100; i++) {
      checkRateLimit(req, 'read')
    }
    const res = checkRateLimit(req, 'read')
    expect(res.allowed).toBe(false)
    expect(res).toHaveProperty('response')
    if (!res.allowed) {
      expect(res.response.status).toBe(429)
    }
  })
})
