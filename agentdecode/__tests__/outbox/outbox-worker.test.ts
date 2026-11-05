import { describe, test, expect, vi, beforeEach } from 'vitest'
import { EvaluationOutboxWorker } from '@/lib/outbox-worker'
import { GET, POST } from '@/app/api/workers/eval-outbox/route'

describe('Evaluation Outbox Worker & Worker Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.EVAL_WORKER_SECRET
  })

  test('Worker claims, processes, and finalizes evaluation jobs successfully', async () => {
    const claimedJob = {
      id: 'job-123',
      project_id: 'proj-1',
      trace_id: 'trace-1',
      span_id: 'span-1',
      eval_type: 'span_score',
      trace_version: 1,
      lease_token: '00000000-0000-0000-0000-000000000001',
      payload: {
        span_id: 'span-1',
        input: 'Hello world',
        output: 'Hi there! How can I help you today?',
      },
      attempt_count: 1,
      max_attempts: 5,
    }

    const mockRpc = vi.fn((fnName: string, args: any) => {
      if (fnName === 'cleanup_expired_rate_limit_buckets') {
        return Promise.resolve({ data: 5, error: null })
      }
      if (fnName === 'claim_evaluation_job') {
        return Promise.resolve({ data: [claimedJob], error: null })
      }
      if (fnName === 'finalize_evaluation_job') {
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const mockSupabase = {
      rpc: mockRpc,
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { retry_count: 1, max_retries: 5 } }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }

    const worker = new EvaluationOutboxWorker(mockSupabase)
    const result = await worker.runOnce({ batchSize: 5, leaseDurationSeconds: 60 })

    expect(result.claimed).toBe(1)
    expect(result.completed).toBe(1)
    expect(result.failed).toBe(0)

    // Verify claim RPC
    expect(mockRpc).toHaveBeenCalledWith('claim_evaluation_job', {
      p_worker_id: worker.workerId,
      p_lease_duration_seconds: 60,
      p_batch_size: 5,
    })

    // Verify finalize RPC
    expect(mockRpc).toHaveBeenCalledWith('finalize_evaluation_job', {
      p_outbox_id: 'job-123',
      p_worker_id: worker.workerId,
      p_lease_token: '00000000-0000-0000-0000-000000000001',
      p_trace_version: 1,
      p_score: expect.any(Number),
      p_reasoning: expect.any(String),
      p_flagged: false,
      p_span_id: 'span-1',
    })
    expect(result.rateLimitBucketsCleaned).toBe(5)
  })

  test('Worker reliably executes bounded rate-limit cleanup during processBatch', async () => {
    const mockRpc = vi.fn((fnName: string, args: any) => {
      if (fnName === 'cleanup_expired_rate_limit_buckets') {
        return Promise.resolve({ data: 42, error: null })
      }
      if (fnName === 'claim_evaluation_job') {
        return Promise.resolve({ data: [], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const mockSupabase = { rpc: mockRpc }
    const worker = new EvaluationOutboxWorker(mockSupabase)
    const result = await worker.processBatch({ batchSize: 10 })

    expect(mockRpc).toHaveBeenCalledWith('cleanup_expired_rate_limit_buckets', {
      p_batch_size: 1000,
    })
    expect(result.rateLimitBucketsCleaned).toBe(42)
  })

  test('Worker retries with exponential backoff on transient evaluation failures', async () => {
    const claimedJob = {
      id: 'job-err',
      project_id: 'proj-1',
      trace_id: 'trace-1',
      span_id: 'span-1',
      eval_type: 'span_score',
      payload: {
        span_id: 'span-1',
        input: 'Test input',
        output: 'Simulate failure',
      },
      attempt_count: 1,
      max_attempts: 5,
    }

    let updatePayload: any = null
    const mockSupabase = {
      rpc: vi.fn((fnName: string) => {
        if (fnName === 'claim_evaluation_job') {
          return Promise.resolve({ data: [claimedJob], error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }),
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { retry_count: 1, max_retries: 5 } }),
          }),
        }),
        update: (payload: any) => {
          updatePayload = payload
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
      }),
    }

    const worker = new EvaluationOutboxWorker(mockSupabase)
    vi.spyOn(worker, 'evaluatePayload').mockRejectedValueOnce(
      new Error('Rate limited by LLM provider')
    )

    const result = await worker.runOnce()

    expect(result.claimed).toBe(1)
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(1)

    // Verify backoff rescheduled in pending state with retry_count incremented
    expect(updatePayload).not.toBeNull()
    expect(updatePayload.status).toBe('pending')
    expect(updatePayload.retry_count).toBe(2)
    expect(updatePayload.last_error).toBe('Rate limited by LLM provider')
    expect(updatePayload.scheduled_at).toBeDefined()
  })

  test('Worker marks job as failed when maximum retries are exhausted', async () => {
    const claimedJob = {
      id: 'job-exhausted',
      project_id: 'proj-1',
      trace_id: 'trace-1',
      span_id: 'span-1',
      eval_type: 'span_score',
      payload: {
        span_id: 'span-1',
      },
      attempt_count: 4,
      max_attempts: 5,
    }

    let updatePayload: any = null
    const mockSupabase = {
      rpc: vi.fn((fnName: string) => {
        if (fnName === 'claim_evaluation_job') {
          return Promise.resolve({ data: [claimedJob], error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }),
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { retry_count: 4, max_retries: 5 } }),
          }),
        }),
        update: (payload: any) => {
          updatePayload = payload
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
      }),
    }

    const worker = new EvaluationOutboxWorker(mockSupabase)
    vi.spyOn(worker, 'evaluatePayload').mockRejectedValueOnce(
      new Error('Permanent schema corruption')
    )

    const result = await worker.runOnce()

    expect(result.claimed).toBe(1)
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(1)

    expect(updatePayload).not.toBeNull()
    expect(updatePayload.status).toBe('failed')
    expect(updatePayload.retry_count).toBe(5)
    expect(updatePayload.last_error).toBe('Permanent schema corruption')
  })

  describe('Scoring Provenance & LLM Integration', () => {
    test('uses Groq LLM scoring when configured and reports LLM provenance', async () => {
      process.env.GROQ_API_KEY = 'gsk_test_key_123'

      const originalFetch = global.fetch
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 8.8,
                  reason: 'High quality and accurate reasoning',
                  flagged: false,
                }),
              },
            },
          ],
        }),
      }) as any

      try {
        const worker = new EvaluationOutboxWorker()
        const result = await worker.evaluatePayload('span_score', {
          input: 'Explain gravity',
          output: 'Gravity is the curvature of spacetime caused by mass and energy.',
        })

        expect(result.score).toBe(8.8)
        expect(result.provenance).toBe('groq:llama-3.3-70b-versatile')
        expect(result.reasoning).toContain('[groq:llama-3.3-70b-versatile]')
        expect(result.reasoning).toContain('High quality and accurate reasoning')
      } finally {
        global.fetch = originalFetch
        delete process.env.GROQ_API_KEY
      }
    })

    test('cleanly falls back to heuristic scoring when LLM is unconfigured and reports unconfigured provenance', async () => {
      delete process.env.GROQ_API_KEY

      const worker = new EvaluationOutboxWorker()
      const result = await worker.evaluatePayload('span_score', {
        input: 'Hello',
        output: 'Healthy output that is long enough to meet the threshold of fifty characters easily.',
      })

      expect(result.provenance).toBe('heuristic:unconfigured')
      expect(result.reasoning).toContain('[heuristic:unconfigured]')
      expect(result.score).toBeGreaterThan(0)
    })

    test('re-throws Groq HTTP 429 rate limit error so outbox marks for retry rather than finalizing heuristic', async () => {
      process.env.GROQ_API_KEY = 'gsk_test_key_123'

      const originalFetch = global.fetch
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded: TPM limit hit',
      }) as any

      try {
        const worker = new EvaluationOutboxWorker()
        await expect(
          worker.evaluatePayload('span_score', { input: 'Hi', output: 'There' })
        ).rejects.toThrow(/rate limit/i)
      } finally {
        global.fetch = originalFetch
        delete process.env.GROQ_API_KEY
      }
    })

    test('re-throws Groq HTTP 503 server error so outbox marks for retry', async () => {
      process.env.GROQ_API_KEY = 'gsk_test_key_123'

      const originalFetch = global.fetch
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      }) as any

      try {
        const worker = new EvaluationOutboxWorker()
        await expect(
          worker.evaluatePayload('span_score', { input: 'Hi', output: 'There' })
        ).rejects.toThrow(/server error/i)
      } finally {
        global.fetch = originalFetch
        delete process.env.GROQ_API_KEY
      }
    })

    test('re-throws Groq HTTP 401 authentication failure as non-transient error', async () => {
      process.env.GROQ_API_KEY = 'gsk_invalid_key'

      const originalFetch = global.fetch
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Invalid API key',
      }) as any

      try {
        const worker = new EvaluationOutboxWorker()
        await expect(
          worker.evaluatePayload('span_score', { input: 'Hi', output: 'There' })
        ).rejects.toThrow(/Invalid Groq API credentials/i)
      } finally {
        global.fetch = originalFetch
        delete process.env.GROQ_API_KEY
      }
    })
  })

  describe('Worker API Route Protection (/api/workers/eval-outbox)', () => {
    test('rejects request with 401 when Authorization header is missing', async () => {
      process.env.CRON_SECRET = 'super-secret-token'
      const request = new Request('http://localhost:3000/api/workers/eval-outbox', {
        method: 'POST',
      })

      const response = await POST(request)
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data.error).toContain('Unauthorized')
    })

    test('rejects request with 401 when secret does not match', async () => {
      process.env.CRON_SECRET = 'super-secret-token'
      const request = new Request('http://localhost:3000/api/workers/eval-outbox', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-secret-token',
        },
      })

      const response = await POST(request)
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data.error).toContain('Unauthorized')
    })

    test('rejects request with 401 in production when secret is unconfigured', async () => {
      delete process.env.CRON_SECRET
      delete process.env.EVAL_WORKER_SECRET
      const oldEnv = process.env.NODE_ENV
      ;(process.env as any).NODE_ENV = 'production'

      const request = new Request('http://localhost:3000/api/workers/eval-outbox', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer some-token',
        },
      })

      const response = await POST(request)
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data.error).toContain('Unauthorized')

      ;(process.env as any).NODE_ENV = oldEnv
    })

    test('accepts valid Authorization Bearer with POST JSON body and respects bounded Hobby params', async () => {
      process.env.CRON_SECRET = 'super-secret-token'
      const processBatchSpy = vi
        .spyOn(EvaluationOutboxWorker.prototype, 'processBatch')
        .mockResolvedValueOnce({
          workerId: 'worker-hobby-1',
          claimed: 2,
          completed: 2,
          failed: 0,
          reopened: 0,
          durationMs: 450,
          rateLimitBucketsCleaned: 1,
        })

      const request = new Request('http://localhost:3000/api/workers/eval-outbox', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer super-secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batch_size: 5, max_time_ms: 8000 }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.status).toBe('ok')
      expect(data.workerId).toBe('worker-hobby-1')
      expect(data.claimed).toBe(2)

      expect(processBatchSpy).toHaveBeenCalledWith({
        batchSize: 5,
        maxExecutionTimeMs: 8000,
      })
    })
  })

  describe('Vercel Hobby Compatibility & Scheduler Architecture', () => {
    test('vercel.json contains no unsupported minute-level Cron expressions', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const vercelJsonPath = path.resolve(__dirname, '../../vercel.json')
      const content = fs.readFileSync(vercelJsonPath, 'utf8')
      const parsed = JSON.parse(content)

      expect(parsed.crons).toBeUndefined()
      expect(content).not.toContain('* * * * *')
    })

    test('Overlapping worker invocations remain idempotent under lease locks', async () => {
      // Simulate two overlapping workers competing for the same outbox job
      let isClaimed = false
      const mockRpc = vi.fn((fnName: string, args: any) => {
        if (fnName === 'cleanup_expired_rate_limit_buckets') {
          return Promise.resolve({ data: 0, error: null })
        }
        if (fnName === 'claim_evaluation_job') {
          if (!isClaimed) {
            isClaimed = true
            return Promise.resolve({
              data: [
                {
                  id: 'concurrent-job-1',
                  project_id: 'proj-1',
                  trace_id: 'trace-concurrent',
                  span_id: 'span-concurrent',
                  eval_type: 'span_score',
                  trace_version: 1,
                  lease_token: 'lease-worker-1',
                  payload: { span_id: 'span-concurrent', input: 'test', output: 'ok' },
                },
              ],
              error: null,
            })
          }
          // Concurrent worker 2 receives empty list because job is locked/leased via SKIP LOCKED
          return Promise.resolve({ data: [], error: null })
        }
        if (fnName === 'finalize_evaluation_job') {
          // Finalize only succeeds if the caller provides the matching lease_token
          if (args.p_lease_token === 'lease-worker-1') {
            return Promise.resolve({ data: true, error: null })
          }
          return Promise.resolve({ data: false, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      })

      const mockSupabase = { rpc: mockRpc }
      const worker1 = new EvaluationOutboxWorker(mockSupabase)
      const worker2 = new EvaluationOutboxWorker(mockSupabase)

      // Both workers run concurrently (simulating overlapping cron ticks)
      const [res1, res2] = await Promise.all([
        worker1.processBatch({ batchSize: 5 }),
        worker2.processBatch({ batchSize: 5 }),
      ])

      // Worker 1 claimed and completed the job
      expect(res1.claimed).toBe(1)
      expect(res1.completed).toBe(1)

      // Worker 2 safely skipped already-claimed/leased jobs (0 claimed, 0 duplicated)
      expect(res2.claimed).toBe(0)
      expect(res2.completed).toBe(0)
    })
  })
})
