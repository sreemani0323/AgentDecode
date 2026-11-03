import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as child_process from 'node:child_process'
import {
  AgentDecode,
  NodeFsWalStorage,
  MemoryWalStorage,
  createWalStorage,
  WALCapacityError,
} from '../src/index'

describe('NodeFsWalStorage', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdecode_ts_wal_'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('enqueues and retrieves pending batches with fsync durability', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    expect(await wal.countPending()).toBe(0)

    const payload = {
      session_name: 'test_session',
      spans: [{ client_span_id: 'span1', name: 'op1' }],
    }
    const id = await wal.enqueue(payload, 'test_session')
    expect(id).toBeDefined()
    expect(await wal.countPending()).toBe(1)

    const stats = await wal.getStats()
    expect(stats.isDurable).toBe(true)
    expect(stats.storageType).toBe('node-fs-atomic')
    expect(stats.pendingCount).toBe(1)

    const pending = await wal.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(id)
    expect(pending[0].sessionName).toBe('test_session')
    expect(pending[0].payload).toEqual(payload)
    expect(pending[0].status).toBe('pending')
    expect(pending[0].attempts).toBe(0)
  })

  it('acknowledges and removes batch after successful delivery', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    const id = await wal.enqueue({ session_name: 's', spans: [] }, 's')
    expect(await wal.countPending()).toBe(1)

    await wal.acknowledge(id)
    expect(await wal.countPending()).toBe(0)
    expect(await wal.getPending()).toEqual([])
  })

  it('records retries on transient network failure', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    const id = await wal.enqueue({ session_name: 's', spans: [] }, 's')
    await wal.markSending([id])

    await wal.recordRetry(id, 'HTTP 503 Service Unavailable')

    expect(await wal.countPending()).toBe(1)
    const pending = await wal.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(id)
    expect(pending[0].status).toBe('pending')
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].lastError).toContain('503')
  })

  it('preserves dead letter records, supports inspection, and allows requeue', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    const id = await wal.enqueue({ session_name: 'bad', spans: [] }, 'bad')

    await wal.recordPermanentFailure(id, 'AgentDecode API error 400: Bad Request')

    expect(await wal.countPending()).toBe(0)
    expect(await wal.countDeadLetter()).toBe(1)

    // Inspect dead letter entries
    const dlEntries = await wal.getDeadLetter()
    expect(dlEntries.length).toBe(1)
    expect(dlEntries[0].id).toBe(id)
    expect(dlEntries[0].errorMessage).toContain('400')

    // Requeue dead letter entry back to pending
    const requeued = await wal.requeueDeadLetter([id])
    expect(requeued).toBe(1)
    expect(await wal.countPending()).toBe(1)
    expect(await wal.countDeadLetter()).toBe(0)
  })

  it('recovers in-flight sending batches back to pending on restart', async () => {
    const wal1 = new NodeFsWalStorage({ storageDir: tempDir })
    const id = await wal1.enqueue({ session_name: 'crash', spans: [] }, 'crash')
    await wal1.markSending([id])

    // Before recovery: file is in 'sending' directory
    expect((await wal1.getPending()).length).toBe(0)

    // Re-instantiate WAL as if process restarted
    const wal2 = new NodeFsWalStorage({ storageDir: tempDir })
    const recovered = await wal2.recover()
    expect(recovered).toBe(1)

    const pending = await wal2.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(id)
    expect(pending[0].status).toBe('pending')
  })

  it('rejects new enqueue with WALCapacityError when capacity is reached without evicting pending batches', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir, maxEntries: 3 })

    const id1 = await wal.enqueue({ session_name: 's1', spans: [] }, 's1')
    const id2 = await wal.enqueue({ session_name: 's2', spans: [] }, 's2')
    const id3 = await wal.enqueue({ session_name: 's3', spans: [] }, 's3')
    expect(await wal.countPending()).toBe(3)

    // 4th entry must throw WALCapacityError without evicting existing data
    await expect(
      wal.enqueue({ session_name: 's4', spans: [] }, 's4'),
    ).rejects.toThrow(WALCapacityError)

    expect(await wal.countPending()).toBe(3)
    const pendingIds = (await wal.getPending()).map((p) => p.id)
    expect(pendingIds).toEqual([id1, id2, id3])
  })

  it('detects and cleans up orphaned temporary files on recovery', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    const pendingDir = path.join(tempDir, 'pending')

    // Create an orphaned .tmp file
    const orphanPath = path.join(pendingDir, 'abandoned_batch.tmp')
    fs.writeFileSync(orphanPath, '{"unfinished": true}', 'utf8')
    expect(fs.existsSync(orphanPath)).toBe(true)

    const cleaned = wal.cleanupOrphanedFiles()
    expect(cleaned).toBe(1)
    expect(fs.existsSync(orphanPath)).toBe(false)
  })

  it('recovers valid .tmp files written and fsynced before process termination prior to rename', async () => {
    const pendingDir = path.join(tempDir, 'pending')
    fs.mkdirSync(pendingDir, { recursive: true })

    // Simulate batch written and fsynced to disk, but killed before renameSync
    const validTmpBatch = {
      id: 'pre_rename_id',
      sessionName: 'survived_session',
      payload: {
        session_name: 'survived_session',
        spans: [{ client_span_id: 'span_recovered', name: 'fsynced_op' }],
      },
      createdAt: Date.now() - 1000,
      attempts: 0,
      status: 'pending',
    }
    const tmpFile = path.join(pendingDir, 'pre_rename_id.tmp')
    fs.writeFileSync(tmpFile, JSON.stringify(validTmpBatch), 'utf8')
    expect(fs.existsSync(tmpFile)).toBe(true)

    // Initializing WAL recovers this valid batch into pending/<id>.json automatically
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    expect(fs.existsSync(tmpFile)).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, 'pre_rename_id.json'))).toBe(true)

    const pending = await wal.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe('pre_rename_id')
    expect(pending[0].sessionName).toBe('survived_session')
    expect(pending[0].payload.spans[0].name).toBe('fsynced_op')

    // Also test explicit recover() call when another .tmp appears
    const secondTmp = path.join(pendingDir, 'second_batch.tmp')
    fs.writeFileSync(
      secondTmp,
      JSON.stringify({
        id: 'second_id',
        sessionName: 'sess2',
        payload: { spans: [] },
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending',
      }),
      'utf8',
    )
    const recoveredCount = await wal.recover()
    expect(recoveredCount).toBe(1)
    expect(fs.existsSync(secondTmp)).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, 'second_id.json'))).toBe(true)
  })

  it('quarantines malformed or truncated .tmp files rather than silently discarding them', async () => {
    const pendingDir = path.join(tempDir, 'pending')
    fs.mkdirSync(pendingDir, { recursive: true })

    const corruptTmp = path.join(pendingDir, 'corrupt_write.tmp')
    fs.writeFileSync(corruptTmp, '{"incomplete_json": true, "spans": [', 'utf8')

    // On initialization, corrupt files are quarantined
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    expect(fs.existsSync(corruptTmp)).toBe(false)

    // Verify it is preserved in quarantine directory
    const quarantineDir = path.join(tempDir, 'quarantine')
    const quarantinedFiles = fs.readdirSync(quarantineDir)
    expect(quarantinedFiles.length).toBe(1)
    expect(quarantinedFiles[0]).toContain('corrupt_tmp_')
    const content = fs.readFileSync(path.join(quarantineDir, quarantinedFiles[0]), 'utf8')
    expect(content).toBe('{"incomplete_json": true, "spans": [')

    // Now write another corrupt file while WAL is open and call recoverOrphanedTempFiles()
    const corruptTmp2 = path.join(pendingDir, 'corrupt2.tmp')
    fs.writeFileSync(corruptTmp2, 'EMPTY_OR_GARBAGE', 'utf8')
    const res = wal.recoverOrphanedTempFiles()
    expect(res.quarantined).toBe(1)
    expect(res.recovered).toBe(0)
    expect(fs.existsSync(corruptTmp2)).toBe(false)
  })

  it('rejects permanent failure with WALCapacityError when dead-letter store is full, preserving original batch and reverting sending status to pending', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir, maxDeadLetterEntries: 2 })

    // Fill dead-letter to capacity (2 entries)
    const id1 = await wal.enqueue({ session_name: 's1', spans: [] }, 's1')
    const id2 = await wal.enqueue({ session_name: 's2', spans: [] }, 's2')
    await wal.recordPermanentFailure(id1, 'HTTP 400 Bad Request')
    await wal.recordPermanentFailure(id2, 'HTTP 422 Unprocessable')
    expect(await wal.countDeadLetter()).toBe(2)
    expect(await wal.countPending()).toBe(0)

    // Enqueue 3rd batch and transition it to 'sending' (in-flight state)
    const id3 = await wal.enqueue({ session_name: 's3', spans: [] }, 's3')
    expect(await wal.countPending()).toBe(1)
    await wal.markSending([id3])

    // While in 'sending', getPending() would return 0
    expect((await wal.getPending()).length).toBe(0)

    // Attempting to archive 3rd permanent failure must throw WALCapacityError
    await expect(
      wal.recordPermanentFailure(id3, 'HTTP 400 Malformed Payload'),
    ).rejects.toThrow(WALCapacityError)

    // Invariant 1: dead letter store still has 2 records (zero eviction!)
    expect(await wal.countDeadLetter()).toBe(2)
    const dlEntries = await wal.getDeadLetter()
    const dlIds = dlEntries.map((e) => e.id)
    expect(dlIds).toContain(id1)
    expect(dlIds).toContain(id2)

    // Invariant 2: original batch id3 is NOT stranded in 'sending'; returned to 'pending'
    expect(await wal.countPending()).toBe(1)
    const pending = await wal.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(id3)
    expect(pending[0].status).toBe('pending')
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].lastError).toContain('Dead-letter store full')

    // Invariant 3: batch remains fully retryable and can be acknowledged
    await wal.acknowledge(id3)
    expect(await wal.countPending()).toBe(0)
  })

  it('exposes platform, dead-letter limits, and conservative Windows durability guarantees in getStats()', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir, maxDeadLetterEntries: 500 })
    const stats = await wal.getStats()

    expect(stats.isDurable).toBe(true)
    expect(stats.storageType).toBe('node-fs-atomic')
    expect(stats.platform).toBe(process.platform)
    expect(stats.maxDeadLetterEntries).toBe(500)
    expect(stats.guarantees).toBeDefined()
    expect(stats.guarantees?.processCrashDurable).toBe(true)
    if (process.platform === 'win32') {
      expect(stats.guarantees?.osCrashDurable).toBe(false)
      expect(stats.guarantees?.powerLossDurable).toBe(false)
    } else {
      expect(stats.guarantees?.osCrashDurable).toBe(true)
    }
    expect(typeof stats.guarantees?.notes).toBe('string')
  })

  it('recovers batches after actual Node.js process termination', async () => {
    const distPath = path.resolve(__dirname, '../dist/index.js')
    const subScript = `
      const { NodeFsWalStorage } = require(${JSON.stringify(distPath)});
      const wal = new NodeFsWalStorage({ storageDir: ${JSON.stringify(tempDir)} });
      wal.enqueue({ session_name: 'node_proc_crash', spans: [{ name: 'sub_span' }] }, 'node_proc_crash')
        .then(() => process.exit(77))
        .catch((err) => {
          console.error(err);
          process.exit(1);
        });
    `
    const subFile = path.join(tempDir, 'sub_test.js')
    fs.writeFileSync(subFile, subScript, 'utf8')

    // Execute node subprocess
    const proc = child_process.spawnSync(process.execPath, [subFile], {
      encoding: 'utf8',
    })
    if (proc.status !== 77) {
      console.error('Subprocess stderr:', proc.stderr)
      console.error('Subprocess stdout:', proc.stdout)
    }
    expect(proc.status).toBe(77)

    // Parent process reopens WAL and verifies batch survived
    const parentWal = new NodeFsWalStorage({ storageDir: tempDir })
    expect(await parentWal.countPending()).toBe(1)
    const pending = await parentWal.getPending()
    expect(pending[0].sessionName).toBe('node_proc_crash')
    expect(pending[0].payload.spans[0].name).toBe('sub_span')
  })

  it('handles corrupted JSON files gracefully without throwing', async () => {
    const wal = new NodeFsWalStorage({ storageDir: tempDir })
    const pendingDir = path.join(tempDir, 'pending')
    fs.mkdirSync(pendingDir, { recursive: true })

    // Create a corrupted file
    fs.writeFileSync(
      path.join(pendingDir, 'corrupt.json'),
      'NOT_VALID_JSON_GARBAGE',
      'utf8',
    )

    // Also add a valid entry
    const validId = await wal.enqueue({ session_name: 'valid', spans: [] }, 'valid')

    const pending = await wal.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(validId)
  })
})

describe('AgentDecode SDK Persistent WAL Integration', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdecode_sdk_wal_'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('persists spans across process restart when network is failing', async () => {
    // 1. First run: network is failing
    const mockFailingFetch = vi.fn().mockRejectedValue(new Error('Network offline'))

    const agent1 = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'https://example.com',
      walDir: tempDir,
    })

    const origSession1 = agent1.session.bind(agent1)
    vi.spyOn(agent1, 'session').mockImplementation((name, id) => {
      const runner = origSession1(name, id)
      runner._session._fetchFn = mockFailingFetch
      return runner
    })

    await expect(
      agent1.session('offline_run').run(async (sess) => {
        await sess.span('task1', 'agent').run(async () => {})
      }),
    ).rejects.toThrow('Network offline')

    // Spans are safely persisted in WAL
    expect(await agent1.wal.countPending()).toBe(1)
    const pendingBefore = await agent1.wal.getPending()
    expect(pendingBefore.length).toBe(1)
    const spanId = pendingBefore[0].payload.spans[0].client_span_id

    // 2. Second run: new AgentDecode instance (simulated process restart)
    const deliveredPayloads: any[] = []
    const mockSender = vi.fn().mockImplementation(async (payload) => {
      deliveredPayloads.push(payload)
      return { ok: true }
    })

    const agent2 = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'https://example.com',
      walDir: tempDir,
    })

    // Recovery runs and WAL still has 1 pending item
    expect(await agent2.wal.countPending()).toBe(1)

    // Flush delivers the recovered pending batch
    const acked = await agent2.flush(mockSender)
    expect(acked).toBe(1)
    expect(deliveredPayloads.length).toBe(1)
    expect(deliveredPayloads[0].session_name).toBe('offline_run')
    // Span ID is stable across retries
    expect(deliveredPayloads[0].spans[0].client_span_id).toBe(spanId)

    // WAL is now clean
    expect(await agent2.wal.countPending()).toBe(0)
  })

  it('preserves stable span IDs on retry for server-side idempotency', async () => {
    const deliveredSpanIds: string[] = []
    let callCount = 0

    const mockFlakySend = vi.fn().mockImplementation(async (payload: any) => {
      callCount++
      deliveredSpanIds.push(payload.spans[0].client_span_id)
      if (callCount === 1) {
        throw new Error('503 Service Unavailable')
      }
      return { ok: true }
    })

    const agent = new AgentDecode({
      apiKey: 'al_test',
      walDir: tempDir,
    })

    const batchId = await agent.wal.enqueue(
      {
        session_name: 'idempotent_test',
        spans: [{ client_span_id: 'stable_span_123', name: 'op' }],
      },
      'idempotent_test',
    )

    // First attempt fails
    await agent.flush(mockFlakySend)
    expect(deliveredSpanIds.length).toBe(1)
    expect(await agent.wal.countPending()).toBe(1)

    // Second attempt succeeds
    await agent.flush(mockFlakySend)
    expect(deliveredSpanIds.length).toBe(2)
    expect(deliveredSpanIds[0]).toBe('stable_span_123')
    expect(deliveredSpanIds[1]).toBe('stable_span_123')
    expect(await agent.wal.countPending()).toBe(0)
  })

  it('archives permanent client errors to dead-letter store without crash', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      walDir: tempDir,
    })

    await agent.wal.enqueue(
      { session_name: 'invalid_data', spans: [] },
      'invalid_data',
    )

    const mockClientError = vi.fn().mockRejectedValue({
      status: 400,
      isClientError: true,
      message: 'AgentDecode API error 400: schema validation failed',
    })

    const acked = await agent.flush(mockClientError)
    expect(acked).toBe(0)

    // Active pending queue empty, archived in dead letter
    expect(await agent.wal.countPending()).toBe(0)
    expect(await agent.wal.countDeadLetter()).toBe(1)
  })

  it('concurrently enqueues and flushes safely', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      walDir: tempDir,
    })

    const delivered: any[] = []
    const mockSender = vi.fn().mockImplementation(async (payload) => {
      delivered.push(payload)
      return { ok: true }
    })

    // Concurrently enqueue batches
    await Promise.all(
      Array.from({ length: 10 }).map((_, i) =>
        agent.wal.enqueue(
          { session_name: `batch_${i}`, spans: [{ name: `s_${i}` }] },
          `batch_${i}`,
        ),
      ),
    )

    expect(await agent.wal.countPending()).toBe(10)

    const acked = await agent.flush(mockSender)
    expect(acked).toBe(10)
    expect(delivered.length).toBe(10)
    expect(await agent.wal.countPending()).toBe(0)
  })
})

describe('MemoryWalStorage', () => {
  it('explicitly reports volatile storage and throws WALCapacityError on limit without eviction', async () => {
    const wal = new MemoryWalStorage({ maxEntries: 2, quiet: true })
    expect(wal.isDurable).toBe(false)
    expect(wal.storageType).toBe('in-memory-volatile')

    const stats = await wal.getStats()
    expect(stats.isDurable).toBe(false)
    expect(stats.storageType).toBe('in-memory-volatile')

    const id1 = await wal.enqueue({ session_name: 'm1', spans: [] }, 'm1')
    const id2 = await wal.enqueue({ session_name: 'm2', spans: [] }, 'm2')
    expect(await wal.countPending()).toBe(2)

    // 3rd enqueue must throw WALCapacityError
    await expect(
      wal.enqueue({ session_name: 'm3', spans: [] }, 'm3'),
    ).rejects.toThrow(WALCapacityError)

    expect(await wal.countPending()).toBe(2)

    await wal.markSending([id1])
    await wal.recordRetry(id1, 'transient')
    expect((await wal.getPending()).length).toBe(2)

    await wal.acknowledge(id1)
    expect(await wal.countPending()).toBe(1)

    await wal.recordPermanentFailure(id2, 'bad request')
    expect(await wal.countPending()).toBe(0)
    expect(await wal.countDeadLetter()).toBe(1)

    // Dead letter inspection & requeue
    const dl = await wal.getDeadLetter()
    expect(dl.length).toBe(1)
    expect(dl[0].id).toBe(id2)

    const requeued = await wal.requeueDeadLetter([id2])
    expect(requeued).toBe(1)
    expect(await wal.countPending()).toBe(1)
    expect(await wal.countDeadLetter()).toBe(0)
  })
})
