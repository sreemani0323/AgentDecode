import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { evaluateQualityWithGroq } from '@/lib/groq'

export interface WorkerBatchOptions {
  batchSize?: number
  maxExecutionTimeMs?: number
  leaseDurationSeconds?: number
}

export interface WorkerBatchResult {
  workerId: string
  claimed: number
  completed: number
  failed: number
  reopened: number
  durationMs: number
  rateLimitBucketsCleaned?: number
}

/**
 * Transactional Evaluation Outbox Worker
 *
 * Implements high-throughput outbox processing with leases, execution timeouts,
 * bounded batches, idempotent state transitions, and server-side credential isolation.
 */
export class EvaluationOutboxWorker {
  public workerId: string
  public supabaseClient?: any

  constructor(workerIdOrClient?: string | any) {
    if (
      typeof workerIdOrClient === 'object' &&
      workerIdOrClient !== null &&
      (workerIdOrClient.rpc || workerIdOrClient.from)
    ) {
      this.supabaseClient = workerIdOrClient
      this.workerId = `worker_${crypto.randomUUID().slice(0, 8)}`
    } else {
      this.workerId =
        (typeof workerIdOrClient === 'string' && workerIdOrClient) ||
        `worker_${crypto.randomUUID().slice(0, 8)}`
    }
  }

  /**
   * Calculate bounded exponential backoff with jitter in seconds.
   */
  private calculateBackoffWithJitter(retryCount: number): number {
    const baseSeconds = 30
    const maxSeconds = 600
    const rawBackoff = Math.min(maxSeconds, baseSeconds * Math.pow(2, retryCount))
    // 20% randomized jitter: 0.9 to 1.1 multiplier
    const jitter = 0.9 + Math.random() * 0.2
    return Math.round(rawBackoff * jitter)
  }

  /**
   * Execute evaluation logic server-side.
   * If external LLM evaluation is configured, provider credentials stay server-side.
   */
  public async evaluatePayload(
    evalType: string,
    payload: Record<string, unknown>
  ): Promise<{
    score: number
    reasoning: string
    flagged: boolean
    provenance: string
  }> {
    const input = payload.input
    const output = payload.output

    // If external LLM evaluation is configured, evaluate via Groq
    if (process.env.GROQ_API_KEY && (evalType === 'span_score' || evalType === 'quality')) {
      try {
        const groqResult = await evaluateQualityWithGroq(input, output)
        if (groqResult) {
          return {
            score: groqResult.score,
            reasoning: `[${groqResult.provenance}] ${groqResult.reasoning}`,
            flagged: groqResult.flagged,
            provenance: groqResult.provenance,
          }
        }
      } catch (err: any) {
        // Transient provider errors (429, 5xx, timeouts) and authentication failures must
        // NOT be silently converted to heuristic success. Re-throw to trigger outbox retry mechanism.
        if (process.env.ALLOW_HEURISTIC_ON_PROVIDER_ERROR !== 'true') {
          throw err
        }
        logger.warn(
          'External LLM scoring failed; ALLOW_HEURISTIC_ON_PROVIDER_ERROR enabled, falling back to heuristic',
          { error: err instanceof Error ? err.message : String(err) }
        )
      }
    }

    // Heuristic fallback evaluation for intentionally unconfigured setups
    const outputStr = output ? String(output) : ''
    const inputStr = input ? String(input) : ''

    let score = 0.85
    let flagged = false
    const reasons: string[] = []

    if (!outputStr || outputStr.trim().length === 0) {
      score = 0.0
      flagged = true
      reasons.push('Empty output detected')
    } else if (
      outputStr.toLowerCase().includes('error:') ||
      outputStr.toLowerCase().includes('exception:')
    ) {
      score = 0.2
      flagged = true
      reasons.push('Output contains error/exception signature')
    } else if (inputStr && outputStr.length > 50) {
      score = 0.95
      reasons.push('Healthy completion length and structure')
    } else {
      score = 0.75
      reasons.push('Standard response')
    }

    const provenance = process.env.GROQ_API_KEY ? 'heuristic:fallback' : 'heuristic:unconfigured'
    return {
      score,
      reasoning: `[${provenance}] ${reasons.join('; ')}`,
      flagged,
      provenance,
    }
  }

  /**
   * Process a single claimed job.
   */
  async processJob(
    job: {
      outbox_id?: string
      id?: string
      project_id: string
      trace_id: string
      span_id?: string | null
      eval_type: string
      trace_version?: number
      lease_token?: string
      payload: Record<string, unknown>
      attempt_count?: number
      max_attempts?: number
    },
    supabaseClient?: any
  ): Promise<'completed' | 'failed' | 'reopened'> {
    const supabase = supabaseClient || this.supabaseClient || createServiceClient()
    const outboxId = job.outbox_id || job.id!
    const leaseToken = job.lease_token || crypto.randomUUID()
    const traceVersion = job.trace_version || 1

    try {
      // 1. Evaluate payload
      const evalResult = await this.evaluatePayload(job.eval_type, job.payload || {})

      // 2. Finalize job atomically via stored procedure (verifying 6 concurrency conditions)
      const { data: finalizeSuccess, error: finalizeError } = await supabase.rpc(
        'finalize_evaluation_job',
        {
          p_outbox_id: outboxId,
          p_worker_id: this.workerId,
          p_lease_token: leaseToken,
          p_trace_version: traceVersion,
          p_score: evalResult.score,
          p_reasoning: evalResult.reasoning,
          p_flagged: evalResult.flagged,
          p_span_id: job.span_id || null,
        }
      )

      if (finalizeError) {
        throw new Error(`RPC finalize_evaluation_job error: ${finalizeError.message}`)
      }

      if (finalizeSuccess === false) {
        logger.warn(
          'Evaluation job finalization rejected: job was reopened or lease expired',
          {
            outboxId,
            traceId: job.trace_id,
            traceVersion,
          }
        )
        return 'reopened'
      }

      return 'completed'
    } catch (err: any) {
      logger.error(
        'Evaluation job processing error; recording retry or failure',
        err,
        {
          outboxId,
          traceId: job.trace_id,
        }
      )

      // Fetch current retry count
      let currentRetries = (job.attempt_count ?? 0) + 1
      let maxRetries = job.max_attempts ?? 5

      if (supabase && typeof supabase.from === 'function') {
        const { data: outboxRow } = await supabase
          .from('evaluation_outbox')
          .select('retry_count, max_retries')
          .eq('id', outboxId)
          .single()

        if (outboxRow) {
          currentRetries = (outboxRow.retry_count ?? 0) + 1
          maxRetries = outboxRow.max_retries ?? 5
        }
      }

      if (currentRetries >= maxRetries) {
        // Mark permanently failed
        if (supabase && typeof supabase.from === 'function') {
          await supabase
            .from('evaluation_outbox')
            .update({
              status: 'failed',
              retry_count: currentRetries,
              last_error: err.message || 'Maximum evaluation retries exceeded',
              claimed_by: null,
              lease_token: null,
              lease_expires_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', outboxId)
        }

        return 'failed'
      }

      // Calculate exponential backoff with jitter
      const retryDelaySeconds = this.calculateBackoffWithJitter(currentRetries)
      const nextScheduledAt = new Date(Date.now() + retryDelaySeconds * 1000).toISOString()

      if (supabase && typeof supabase.from === 'function') {
        await supabase
          .from('evaluation_outbox')
          .update({
            status: 'pending',
            retry_count: currentRetries,
            last_error: err.message,
            scheduled_at: nextScheduledAt,
            claimed_by: null,
            lease_token: null,
            lease_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', outboxId)
      }

      return 'failed'
    }
  }

  /**
   * Concurrency-safe, bounded maintenance to prune expired rate limit buckets.
   * Invoked reliably as part of the scheduled worker execution.
   */
  async cleanupExpiredRateLimits(
    batchSize: number = 1000,
    supabaseClient?: any
  ): Promise<number> {
    const supabase = supabaseClient || this.supabaseClient || createServiceClient()
    try {
      const { data, error } = await supabase.rpc('cleanup_expired_rate_limit_buckets', {
        p_batch_size: batchSize,
      })
      if (error) {
        logger.warn('Failed to prune expired rate limit buckets via RPC', { error: error.message })
        return 0
      }
      return typeof data === 'number' ? data : 0
    } catch (err: any) {
      logger.warn('Exception during rate limit bucket cleanup', {
        error: err instanceof Error ? err.message : String(err),
      })
      return 0
    }
  }

  /**
   * Process a bounded batch of outbox jobs up to batch size and time budget.
   */
  async processBatch(
    options: WorkerBatchOptions = {},
    supabaseClient?: any
  ): Promise<WorkerBatchResult> {
    const startTime = Date.now()
    const batchSize = options.batchSize || 5
    const maxExecutionTimeMs = options.maxExecutionTimeMs || 8_000 // 8s default for Vercel Hobby safety
    const leaseDurationSeconds = options.leaseDurationSeconds || 180
    const supabase = supabaseClient || this.supabaseClient || createServiceClient()

    // Maintenance: Reliably prune expired rate limit buckets during each worker execution
    let rateLimitBucketsCleaned = 0
    try {
      rateLimitBucketsCleaned = await this.cleanupExpiredRateLimits(1000, supabase)
    } catch (cleanErr: any) {
      logger.warn('Rate limit bucket maintenance warning', {
        error: cleanErr instanceof Error ? cleanErr.message : String(cleanErr),
      })
    }

    let claimedCount = 0
    let completedCount = 0
    let failedCount = 0
    let reopenedCount = 0

    // Claim jobs using claim_evaluation_job RPC
    let claimedJobs: any[] = []
    try {
      const { data, error } = await supabase.rpc('claim_evaluation_job', {
        p_worker_id: this.workerId,
        p_lease_duration_seconds: leaseDurationSeconds,
        p_batch_size: batchSize,
      })
      if (!error && Array.isArray(data)) {
        claimedJobs = data
      }
    } catch (claimErr: any) {
      logger.error('Failed to claim outbox jobs via RPC', claimErr)
      return {
        workerId: this.workerId,
        claimed: 0,
        completed: 0,
        failed: 0,
        reopened: 0,
        durationMs: Date.now() - startTime,
      }
    }

    claimedCount = claimedJobs.length

    for (const job of claimedJobs) {
      // Check remaining execution time budget
      if (Date.now() - startTime >= maxExecutionTimeMs) {
        logger.warn('Execution time limit reached; pausing outbox batch', {
          workerId: this.workerId,
        })
        break
      }

      const outcome = await this.processJob(job, supabase)
      if (outcome === 'completed') completedCount++
      else if (outcome === 'failed') failedCount++
      else if (outcome === 'reopened') reopenedCount++
    }

    return {
      workerId: this.workerId,
      claimed: claimedCount,
      completed: completedCount,
      failed: failedCount,
      reopened: reopenedCount,
      durationMs: Date.now() - startTime,
      rateLimitBucketsCleaned,
    }
  }

  /**
   * Alias for single batch run.
   */
  async runOnce(
    options: WorkerBatchOptions = {},
    supabaseClient?: any
  ): Promise<WorkerBatchResult> {
    return this.processBatch(options, supabaseClient)
  }
}
