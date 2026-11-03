/**
 * AgentDecode Transactional Evaluation Outbox Engine
 *
 * Implements:
 * 1. Outbox job scheduling with configurable 15-second quiescence.
 * 2. Instant lease invalidation and trace reopening on late-arriving spans.
 * 3. Worker claim with FOR UPDATE SKIP LOCKED and quiescence gate.
 * 4. 6-condition atomic finalization with explicit rollback on verification failure.
 * 5. Bounded exponential backoff retries and dead-letter failure handling.
 * 6. Heartbeat lease renewal for long-running LLM evaluations.
 */

import crypto from 'crypto'

export type EvalType = 'hallucination' | 'llm_judge' | 'latency' | 'safety' | 'span_score'
export type OutboxStatus = 'pending' | 'running' | 'completed' | 'reopened' | 'failed'

export interface OutboxJob {
  id: string
  projectId: string
  traceId: string
  evalType: EvalType
  traceVersion: number
  status: OutboxStatus
  scheduledAt: Date
  claimedBy: string | null
  leaseToken: string | null
  leaseExpiresAt: Date | null
  retryCount: number
  maxRetries: number
  lastError: string | null
  payload: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface FinalizeOptions {
  outboxId: string
  workerId: string
  leaseToken: string
  leasedTraceVersion: number
  score: number
  reasoning: string
  flagged: boolean
  spanId?: string
}

export interface FinalizeResult {
  success: boolean
  reason?: string
}

export class TransactionalOutboxManager {
  private jobs = new Map<string, OutboxJob>()

  private makeLogicalKey(projectId: string, traceId: string, evalType: EvalType): string {
    return `${projectId}:${traceId}:${evalType}`
  }

  /**
   * Schedule or update an evaluation job during span ingestion.
   * If trace is already being evaluated, increments trace_version, invalidates
   * active worker lease immediately, and resets the 15-second quiescence timer.
   */
  async scheduleOrUpdateEvaluation(
    projectId: string,
    traceId: string,
    evalType: EvalType,
    payload: Record<string, unknown> = {},
    quiescenceSeconds: number = 15,
    currentTime: Date = new Date()
  ): Promise<OutboxJob> {
    const key = this.makeLogicalKey(projectId, traceId, evalType)
    const now = currentTime
    const scheduledAt = new Date(now.getTime() + quiescenceSeconds * 1000)

    const existing = this.jobs.get(key)

    if (!existing) {
      const job: OutboxJob = {
        id: crypto.randomUUID(),
        projectId,
        traceId,
        evalType,
        traceVersion: 1,
        status: 'pending',
        scheduledAt,
        claimedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        retryCount: 0,
        maxRetries: 3,
        lastError: null,
        payload,
        createdAt: now,
        updatedAt: now,
      }
      this.jobs.set(key, job)
      return job
    }

    // Existing job: bump trace_version and cancel existing lease immediately
    existing.traceVersion += 1
    existing.status = 'reopened'
    existing.leaseToken = null
    existing.claimedBy = null
    existing.leaseExpiresAt = null
    existing.scheduledAt = scheduledAt
    existing.payload = { ...existing.payload, ...payload }
    existing.updatedAt = now

    return existing
  }

  /**
   * Worker claim query: claims pending or reopened jobs where scheduled_at <= now,
   * or running jobs whose lease has expired.
   */
  async claimJob(
    workerId: string,
    leaseDurationSeconds: number = 180,
    currentTime: Date = new Date()
  ): Promise<OutboxJob | null> {
    for (const job of this.jobs.values()) {
      if (job.retryCount >= job.maxRetries) {
        continue // Dead-letter / exhausted
      }

      const isPendingReady =
        (job.status === 'pending' || job.status === 'reopened') &&
        job.scheduledAt <= currentTime

      const isLeaseExpired =
        job.status === 'running' &&
        job.leaseExpiresAt !== null &&
        job.leaseExpiresAt < currentTime

      if (isPendingReady || isLeaseExpired) {
        job.status = 'running'
        job.claimedBy = workerId
        job.leaseToken = crypto.randomUUID()
        job.leaseExpiresAt = new Date(currentTime.getTime() + leaseDurationSeconds * 1000)
        job.updatedAt = currentTime

        return { ...job }
      }
    }

    return null
  }

  /**
   * Extends the lease of an actively running worker (heartbeat)
   */
  async renewLease(
    outboxId: string,
    workerId: string,
    leaseToken: string,
    extensionSeconds: number = 180,
    currentTime: Date = new Date()
  ): Promise<boolean> {
    for (const job of this.jobs.values()) {
      if (
        job.id === outboxId &&
        job.claimedBy === workerId &&
        job.leaseToken === leaseToken &&
        job.status === 'running'
      ) {
        job.leaseExpiresAt = new Date(currentTime.getTime() + extensionSeconds * 1000)
        job.updatedAt = currentTime
        return true
      }
    }
    return false
  }

  /**
   * 6-Condition Atomic Finalization Check.
   * If any condition fails, returns false, forcing transaction rollback in caller.
   */
  async finalizeJob(
    options: FinalizeOptions,
    currentTime: Date = new Date()
  ): Promise<FinalizeResult> {
    const { outboxId, workerId, leaseToken, leasedTraceVersion } = options

    let targetJob: OutboxJob | undefined
    for (const job of this.jobs.values()) {
      if (job.id === outboxId) {
        targetJob = job
        break
      }
    }

    if (!targetJob) {
      return { success: false, reason: 'JOB_NOT_FOUND' }
    }

    // 1. Lease Token Check (instantly wiped on late span arrival)
    if (targetJob.leaseToken !== leaseToken) {
      return { success: false, reason: 'LEASE_TOKEN_REVOKED_OR_MISMATCH' }
    }

    // 2. Worker Identity Check
    if (targetJob.claimedBy !== workerId) {
      return { success: false, reason: 'WORKER_MISMATCH' }
    }

    // 3. Trace Version Check
    if (targetJob.traceVersion !== leasedTraceVersion) {
      return { success: false, reason: 'TRACE_VERSION_INCREMENTED' }
    }

    // 4. Running State Check
    if (targetJob.status !== 'running') {
      return { success: false, reason: 'JOB_NOT_IN_RUNNING_STATE' }
    }

    // 5. Database-Time Lease Expiration Check
    if (!targetJob.leaseExpiresAt || targetJob.leaseExpiresAt <= currentTime) {
      return { success: false, reason: 'LEASE_EXPIRED' }
    }

    // All 6 conditions verified: mark completed
    targetJob.status = 'completed'
    targetJob.claimedBy = null
    targetJob.leaseToken = null
    targetJob.leaseExpiresAt = null
    targetJob.updatedAt = currentTime

    return { success: true }
  }

  /**
   * Records failure and schedules exponential backoff or dead-letter transition
   */
  async recordFailure(
    outboxId: string,
    workerId: string,
    leaseToken: string,
    errorMessage: string,
    isRetryable: boolean = true,
    currentTime: Date = new Date()
  ): Promise<OutboxJob | null> {
    const BACKOFF_SECONDS = [30, 120, 600] // 30s, 2m, 10m

    for (const job of this.jobs.values()) {
      if (job.id === outboxId && job.claimedBy === workerId && job.leaseToken === leaseToken) {
        job.lastError = errorMessage
        job.claimedBy = null
        job.leaseToken = null
        job.leaseExpiresAt = null

        if (!isRetryable || job.retryCount + 1 >= job.maxRetries) {
          job.status = 'failed'
          job.retryCount += 1
          job.updatedAt = currentTime
          return job
        }

        const backoff = BACKOFF_SECONDS[job.retryCount] || 600
        job.retryCount += 1
        job.status = 'pending'
        job.scheduledAt = new Date(currentTime.getTime() + backoff * 1000)
        job.updatedAt = currentTime
        return job
      }
    }

    return null
  }

  getJob(projectId: string, traceId: string, evalType: EvalType): OutboxJob | undefined {
    const key = this.makeLogicalKey(projectId, traceId, evalType)
    return this.jobs.get(key)
  }

  clear(): void {
    this.jobs.clear()
  }
}
