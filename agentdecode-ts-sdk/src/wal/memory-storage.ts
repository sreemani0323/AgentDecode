import {
  DeadLetterEntry,
  IWalStorage,
  WALCapacityError,
  WalBatchPayload,
  WalEntry,
  WalStorageStats,
} from './types.js'

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * MemoryWalStorage: In-memory volatile queue for edge/serverless or fallback environments.
 *
 * Durability notice:
 * - This backend is strictly volatile (`isDurable = false`, `storageType = 'in-memory-volatile'`).
 * - Spans buffered in MemoryWalStorage WILL NOT survive process crashes, serverless cold starts,
 *   or container restarts.
 */
export class MemoryWalStorage implements IWalStorage {
  readonly isDurable = false
  readonly storageType = 'in-memory-volatile' as const

  private _batches = new Map<string, WalEntry>()
  private _deadLetter = new Map<string, DeadLetterEntry>()
  private _maxEntries: number
  private _maxDeadLetterEntries: number

  constructor(options?: { maxEntries?: number; maxDeadLetterEntries?: number; quiet?: boolean }) {
    this._maxEntries = options?.maxEntries ?? 10000
    this._maxDeadLetterEntries = options?.maxDeadLetterEntries ?? 2000
    if (!options?.quiet) {
      console.warn(
        '[agentdecode] Warning: MemoryWalStorage active. In-memory queue is volatile ' +
          'and will NOT survive process crashes or container restarts.',
      )
    }
  }

  async enqueue(
    payload: WalBatchPayload,
    sessionName: string,
    sessionId?: string,
  ): Promise<string> {
    const currentCount = await this.countPending()
    if (currentCount >= this._maxEntries) {
      throw new WALCapacityError(
        `WAL capacity limit reached (${currentCount}/${this._maxEntries} batches). ` +
          `Existing pending batches preserved; refusing new enqueue.`,
      )
    }

    const id = generateId()
    const entry: WalEntry = {
      id,
      sessionName,
      sessionId,
      payload,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending',
    }

    this._batches.set(id, entry)
    return id
  }

  async getPending(limit: number = 50): Promise<WalEntry[]> {
    const pending: WalEntry[] = []
    for (const entry of this._batches.values()) {
      if (entry.status === 'pending') {
        pending.push({ ...entry })
        if (pending.length >= limit) break
      }
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt)
  }

  async markSending(ids: string[]): Promise<void> {
    for (const id of ids) {
      const entry = this._batches.get(id)
      if (entry) {
        entry.status = 'sending'
      }
    }
  }

  async acknowledge(id: string): Promise<void> {
    this._batches.delete(id)
  }

  async recordRetry(id: string, errorMessage: string): Promise<void> {
    const entry = this._batches.get(id)
    if (entry) {
      entry.status = 'pending'
      entry.attempts += 1
      entry.lastError = errorMessage
    }
  }

  async recordPermanentFailure(id: string, errorMessage: string): Promise<void> {
    if (this._deadLetter.size >= this._maxDeadLetterEntries) {
      const entry = this._batches.get(id)
      if (entry) {
        entry.status = 'pending'
        entry.attempts += 1
        entry.lastError = `Dead-letter store full (${this._deadLetter.size}/${this._maxDeadLetterEntries}). Error: ${errorMessage}`
      }
      throw new WALCapacityError(
        `Dead-letter storage limit reached (${this._deadLetter.size}/${this._maxDeadLetterEntries}). ` +
          `Preserving original batch ${id} in active queue with status 'pending'; refusing dead-letter archive.`,
      )
    }

    const entry = this._batches.get(id)
    if (entry) {
      this._batches.delete(id)
      this._deadLetter.set(id, {
        id,
        sessionName: entry.sessionName,
        sessionId: entry.sessionId,
        payload: entry.payload,
        createdAt: entry.createdAt,
        attempts: entry.attempts + 1,
        errorMessage,
        failedAt: Date.now(),
      })
    }
  }

  async getDeadLetter(limit: number = 50): Promise<DeadLetterEntry[]> {
    const entries = Array.from(this._deadLetter.values()).sort(
      (a, b) => b.failedAt - a.failedAt,
    )
    return entries.slice(0, limit)
  }

  async requeueDeadLetter(ids?: string[]): Promise<number> {
    let count = 0
    for (const [id, dl] of Array.from(this._deadLetter.entries())) {
      if (!ids || ids.includes(id)) {
        this._batches.set(id, {
          id: dl.id,
          sessionName: dl.sessionName,
          sessionId: dl.sessionId,
          payload: dl.payload,
          createdAt: dl.createdAt,
          attempts: 0,
          status: 'pending',
        })
        this._deadLetter.delete(id)
        count++
      }
    }
    return count
  }

  async purgeDeadLetter(beforeTimestamp?: number): Promise<number> {
    let count = 0
    for (const [id, dl] of Array.from(this._deadLetter.entries())) {
      if (!beforeTimestamp || dl.failedAt < beforeTimestamp) {
        this._deadLetter.delete(id)
        count++
      }
    }
    return count
  }

  async recover(): Promise<number> {
    let recovered = 0
    for (const entry of this._batches.values()) {
      if (entry.status === 'sending') {
        entry.status = 'pending'
        recovered++
      }
    }
    return recovered
  }

  async countPending(): Promise<number> {
    let count = 0
    for (const entry of this._batches.values()) {
      if (entry.status === 'pending' || entry.status === 'sending') {
        count++
      }
    }
    return count
  }

  async countDeadLetter(): Promise<number> {
    return this._deadLetter.size
  }

  async getStats(): Promise<WalStorageStats> {
    let pending = 0
    let sending = 0
    for (const entry of this._batches.values()) {
      if (entry.status === 'pending') pending++
      if (entry.status === 'sending') sending++
    }
    return {
      pendingCount: pending,
      sendingCount: sending,
      deadLetterCount: this._deadLetter.size,
      maxEntries: this._maxEntries,
      maxDeadLetterEntries: this._maxDeadLetterEntries,
      isDurable: false,
      storageType: this.storageType,
      guarantees: {
        processCrashDurable: false,
        osCrashDurable: false,
        powerLossDurable: false,
        notes:
          'In-memory queue is volatile and does not survive process restarts, crashes, or container recreation.',
      },
    }
  }

  async clear(): Promise<void> {
    this._batches.clear()
    this._deadLetter.clear()
  }
}
