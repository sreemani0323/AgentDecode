import { describe, test, expect, beforeEach } from 'vitest'
import { TransactionalOutboxManager } from '@/lib/outbox'

describe('Transactional Evaluation Outbox & Lease Protocol Suite', () => {
  let outbox: TransactionalOutboxManager

  beforeEach(() => {
    outbox = new TransactionalOutboxManager()
  })

  test('Test 8 (Quiescence Scheduling): Ingestion schedules evaluation with 15s delay', async () => {
    const now = new Date('2026-11-03T12:00:00.000Z')
    const job = await outbox.scheduleOrUpdateEvaluation(
      'proj-1',
      'trace-quiesce-1',
      'hallucination',
      { span_count: 1 },
      15,
      now
    )

    expect(job.status).toBe('pending')
    expect(job.traceVersion).toBe(1)
    expect(job.scheduledAt.getTime() - job.createdAt.getTime()).toBe(15000)
  })

  test('Test 9 (Late Span During Evaluation): Stale worker cannot commit after trace reopening', async () => {
    const t0 = new Date('2026-11-03T12:00:00.000Z')
    const t15 = new Date('2026-11-03T12:00:15.000Z')

    // 1. Initial span schedules job
    const initialJob = await outbox.scheduleOrUpdateEvaluation('proj-1', 'trace-race-1', 'llm_judge', {}, 15, t0)

    // 2. Worker 1 claims job after quiescence
    const claimedJob = await outbox.claimJob('worker-1', 180, t15)
    expect(claimedJob).not.toBeNull()
    expect(claimedJob?.claimedBy).toBe('worker-1')
    expect(claimedJob?.traceVersion).toBe(1)

    const leaseToken = claimedJob!.leaseToken!

    // 3. New span arrives WHILE Worker 1 is evaluating!
    const updatedJob = await outbox.scheduleOrUpdateEvaluation('proj-1', 'trace-race-1', 'llm_judge', {}, 15, t15)
    expect(updatedJob.traceVersion).toBe(2)
    expect(updatedJob.status).toBe('reopened')
    expect(updatedJob.leaseToken).toBeNull() // Active lease instantly wiped!

    // 4. Worker 1 finishes LLM call and attempts to finalize with version 1 and old lease token
    const finalizeRes = await outbox.finalizeJob({
      outboxId: initialJob.id,
      workerId: 'worker-1',
      leaseToken,
      leasedTraceVersion: 1,
      score: 8.5,
      reasoning: 'Good response',
      flagged: false,
    }, t15)

    // Must be rejected!
    expect(finalizeRes.success).toBe(false)
    expect(finalizeRes.reason).toBe('LEASE_TOKEN_REVOKED_OR_MISMATCH')
  })

  test('Test 10 (Worker Lease Expiration): Expired lease cannot commit; second worker can reclaim', async () => {
    const t0 = new Date('2026-11-03T12:00:00.000Z')
    const tClaim = new Date('2026-11-03T12:00:15.000Z')
    const tExpired = new Date('2026-11-03T12:03:20.000Z') // +3m 5s (lease was 3 minutes)

    await outbox.scheduleOrUpdateEvaluation('proj-1', 'trace-expire-1', 'hallucination', {}, 15, t0)
    const claimed = await outbox.claimJob('worker-slow', 180, tClaim)
    expect(claimed).not.toBeNull()
    const slowToken = claimed!.leaseToken!

    // Worker attempts to commit after lease expiration time
    const finalizeRes = await outbox.finalizeJob({
      outboxId: claimed!.id,
      workerId: 'worker-slow',
      leaseToken: slowToken,
      leasedTraceVersion: 1,
      score: 7.0,
      reasoning: 'Evaluation complete',
      flagged: false,
    }, tExpired)

    expect(finalizeRes.success).toBe(false)
    expect(finalizeRes.reason).toBe('LEASE_EXPIRED')

    // Worker 2 reclaims the expired job
    const reclaimed = await outbox.claimJob('worker-fast', 180, tExpired)
    expect(reclaimed).not.toBeNull()
    expect(reclaimed?.claimedBy).toBe('worker-fast')
    expect(reclaimed?.leaseToken).not.toBe(slowToken)
  })

  test('Test 11 (Retry Exhaustion): Job transitions to terminal failed after max retries', async () => {
    const t0 = new Date('2026-11-03T12:00:00.000Z')
    const job = await outbox.scheduleOrUpdateEvaluation('proj-1', 'trace-fail-1', 'safety', {}, 0, t0)

    // Attempt 1
    const claim1 = await outbox.claimJob('worker-1', 60, t0)
    expect(claim1).not.toBeNull()
    await outbox.recordFailure(claim1!.id, 'worker-1', claim1!.leaseToken!, 'API 429 Rate Limit', true, t0)

    // Attempt 2
    const t1 = new Date(t0.getTime() + 31000)
    const claim2 = await outbox.claimJob('worker-2', 60, t1)
    expect(claim2).not.toBeNull()
    await outbox.recordFailure(claim2!.id, 'worker-2', claim2!.leaseToken!, 'API 503 Overload', true, t1)

    // Attempt 3
    const t2 = new Date(t1.getTime() + 121000)
    const claim3 = await outbox.claimJob('worker-3', 60, t2)
    expect(claim3).not.toBeNull()
    const failedJob = await outbox.recordFailure(claim3!.id, 'worker-3', claim3!.leaseToken!, 'API 503 Overload', true, t2)

    // Retry limit (3) exceeded -> terminal failure!
    expect(failedJob?.status).toBe('failed')
    expect(failedJob?.retryCount).toBe(3)

    // Cannot be claimed again
    const claimAfterFail = await outbox.claimJob('worker-4', 60, new Date(t2.getTime() + 1000))
    expect(claimAfterFail).toBeNull()
  })

  test('Test 12 (Lease Renewal Heartbeat): Long-running evaluation renews lease successfully', async () => {
    const t0 = new Date('2026-11-03T12:00:00.000Z')
    await outbox.scheduleOrUpdateEvaluation('proj-1', 'trace-renew-1', 'hallucination', {}, 0, t0)
    const claimed = await outbox.claimJob('worker-long', 180, t0)
    expect(claimed).not.toBeNull()

    const tMidway = new Date(t0.getTime() + 120000) // 2 minutes in
    const renewed = await outbox.renewLease(claimed!.id, 'worker-long', claimed!.leaseToken!, 180, tMidway)
    expect(renewed).toBe(true)

    // Job is still valid at 4 minutes (since extended by 3 minutes from 2m -> expires at 5m)
    const t4m = new Date(t0.getTime() + 240000)
    const finalizeRes = await outbox.finalizeJob({
      outboxId: claimed!.id,
      workerId: 'worker-long',
      leaseToken: claimed!.leaseToken!,
      leasedTraceVersion: 1,
      score: 9.0,
      reasoning: 'Extensively analyzed',
      flagged: false,
    }, t4m)

    expect(finalizeRes.success).toBe(true)
  })
})
