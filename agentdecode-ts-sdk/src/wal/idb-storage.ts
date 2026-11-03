import {
  DeadLetterEntry,
  IWalStorage,
  WALCapacityError,
  WALStorageError,
  WalBatchPayload,
  WalEntry,
  WalStorageOptions,
  WalStorageStats,
} from './types.js'

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * IndexedDbWalStorage: Browser IndexedDB persistent Write-Ahead Log.
 *
 * Durability notice:
 * - Browser IndexedDB provides client-side persistence that survives page reloads and tab closures.
 * - However, browser storage may be evicted by the browser under extreme disk pressure unless
 *   persistent storage is granted via `navigator.storage.persist()`.
 * - Marked with `isDurable = false` / `storageType = 'indexeddb-best-effort'` to reflect that
 *   OS/hardware power loss or browser cache evictions can clear un-persisted browser data.
 */
export class IndexedDbWalStorage implements IWalStorage {
  readonly isDurable = false
  readonly storageType = 'indexeddb-best-effort' as const

  private _dbName: string
  private _maxEntries: number
  private _maxDeadLetterEntries: number
  private _dbPromise: Promise<IDBDatabase> | null = null
  private _isPersisted: boolean = false

  constructor(options?: WalStorageOptions) {
    this._dbName = options?.dbName ?? 'agentdecode_wal'
    this._maxEntries = options?.maxEntries ?? 10000
    this._maxDeadLetterEntries = options?.maxDeadLetterEntries ?? 2000

    this._checkPersistence()
  }

  private async _checkPersistence(): Promise<void> {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.persisted === 'function'
    ) {
      try {
        this._isPersisted = await navigator.storage.persisted()
        if (!this._isPersisted && typeof navigator.storage.persist === 'function') {
          this._isPersisted = await navigator.storage.persist()
        }
      } catch {
        this._isPersisted = false
      }
    }
  }

  private _getDb(): Promise<IDBDatabase> {
    if (this._dbPromise) return this._dbPromise

    this._dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new WALStorageError('IndexedDB is not available in this environment'))
        return
      }

      const req = indexedDB.open(this._dbName, 1)

      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('wal_batches')) {
          const store = db.createObjectStore('wal_batches', { keyPath: 'id' })
          store.createIndex('status', 'status', { unique: false })
          store.createIndex('createdAt', 'createdAt', { unique: false })
        }
        if (!db.objectStoreNames.contains('dead_letter_batches')) {
          db.createObjectStore('dead_letter_batches', { keyPath: 'id' })
        }
      }

      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(new WALStorageError(`IndexedDB open error: ${req.error?.message}`))
    })

    return this._dbPromise
  }

  private _createTransaction(
    db: IDBDatabase,
    storeNames: string[],
    mode: IDBTransactionMode,
  ): IDBTransaction {
    // Attempt strict transaction durability where supported (Chrome/Safari/Firefox modern)
    try {
      return (db as any).transaction(storeNames, mode, { durability: 'strict' })
    } catch {
      // Fallback for browsers not supporting transaction durability options
      return db.transaction(storeNames, mode)
    }
  }

  async enqueue(
    payload: WalBatchPayload,
    sessionName: string,
    sessionId?: string,
  ): Promise<string> {
    const db = await this._getDb()

    // Enforce bounds without silent eviction
    const count = await this.countPending()
    if (count >= this._maxEntries) {
      throw new WALCapacityError(
        `WAL capacity limit reached (${count}/${this._maxEntries} batches). ` +
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

    return new Promise((resolve, reject) => {
      try {
        const tx = this._createTransaction(db, ['wal_batches'], 'readwrite')
        const store = tx.objectStore('wal_batches')
        const addReq = store.add(entry)

        addReq.onsuccess = () => resolve(id)
        addReq.onerror = () => {
          const err = addReq.error
          if (err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
            reject(new WALCapacityError(`Browser storage quota exceeded: ${err.message}`))
          } else {
            reject(new WALStorageError(`Failed to enqueue to IndexedDB: ${err?.message}`))
          }
        }
      } catch (err: any) {
        if (err.name === 'QuotaExceededError') {
          reject(new WALCapacityError(`Browser storage quota exceeded: ${err.message}`))
        } else {
          reject(new WALStorageError(`IndexedDB transaction error: ${err.message}`))
        }
      }
    })
  }

  async getPending(limit: number = 50): Promise<WalEntry[]> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['wal_batches'], 'readonly')
      const store = tx.objectStore('wal_batches')
      const index = store.index('status')
      const req = index.openCursor(IDBKeyRange.only('pending'))
      const results: WalEntry[] = []

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor && results.length < limit) {
          results.push(cursor.value)
          cursor.continue()
        } else {
          resolve(results.sort((a, b) => a.createdAt - b.createdAt))
        }
      }
      req.onerror = () => reject(new WALStorageError(`IndexedDB read error: ${req.error?.message}`))
    })
  }

  async markSending(ids: string[]): Promise<void> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches'], 'readwrite')
      const store = tx.objectStore('wal_batches')

      for (const id of ids) {
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          if (getReq.result) {
            const updated = { ...getReq.result, status: 'sending' }
            store.put(updated)
          }
        }
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new WALStorageError(`IndexedDB markSending error: ${tx.error?.message}`))
    })
  }

  async acknowledge(id: string): Promise<void> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches'], 'readwrite')
      const store = tx.objectStore('wal_batches')
      const req = store.delete(id)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(new WALStorageError(`IndexedDB delete error: ${req.error?.message}`))
    })
  }

  async recordRetry(id: string, errorMessage: string): Promise<void> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches'], 'readwrite')
      const store = tx.objectStore('wal_batches')
      const getReq = store.get(id)

      getReq.onsuccess = () => {
        if (getReq.result) {
          const entry = getReq.result as WalEntry
          entry.status = 'pending'
          entry.attempts += 1
          entry.lastError = errorMessage
          store.put(entry)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new WALStorageError(`IndexedDB retry update error: ${tx.error?.message}`))
    })
  }

  async recordPermanentFailure(id: string, errorMessage: string): Promise<void> {
    const currentDead = await this.countDeadLetter()
    if (currentDead >= this._maxDeadLetterEntries) {
      // Ensure batch returns to 'pending' status so it remains retryable, not stranded in 'sending'
      const db = await this._getDb()
      await new Promise<void>((resolve, reject) => {
        const tx = this._createTransaction(db, ['wal_batches'], 'readwrite')
        const walStore = tx.objectStore('wal_batches')
        const getReq = walStore.get(id)
        getReq.onsuccess = () => {
          if (getReq.result) {
            const entry = getReq.result as WalEntry
            entry.status = 'pending'
            entry.attempts += 1
            entry.lastError = `Dead-letter store full (${currentDead}/${this._maxDeadLetterEntries}). Error: ${errorMessage}`
            walStore.put(entry)
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(new WALStorageError(`IndexedDB status update error: ${tx.error?.message}`))
      })

      throw new WALCapacityError(
        `Dead-letter storage limit reached (${currentDead}/${this._maxDeadLetterEntries}). ` +
          `Preserving original batch ${id} in active queue with status 'pending'; refusing dead-letter archive.`,
      )
    }

    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches', 'dead_letter_batches'], 'readwrite')
      const walStore = tx.objectStore('wal_batches')
      const deadLetterStore = tx.objectStore('dead_letter_batches')

      const getReq = walStore.get(id)
      getReq.onsuccess = () => {
        if (getReq.result) {
          const entry = getReq.result as WalEntry
          const deadLetter: DeadLetterEntry = {
            id: entry.id,
            sessionName: entry.sessionName,
            sessionId: entry.sessionId,
            payload: entry.payload,
            createdAt: entry.createdAt,
            attempts: entry.attempts + 1,
            errorMessage,
            failedAt: Date.now(),
          }
          deadLetterStore.add(deadLetter)
          walStore.delete(id)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new WALStorageError(`IndexedDB permanent failure record error: ${tx.error?.message}`))
    })
  }

  async getDeadLetter(limit: number = 50): Promise<DeadLetterEntry[]> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['dead_letter_batches'], 'readonly')
      const store = tx.objectStore('dead_letter_batches')
      const req = store.openCursor()
      const results: DeadLetterEntry[] = []

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor && results.length < limit) {
          results.push(cursor.value)
          cursor.continue()
        } else {
          resolve(results.sort((a, b) => b.failedAt - a.failedAt))
        }
      }
      req.onerror = () => reject(new WALStorageError(`IndexedDB read dead letter error: ${req.error?.message}`))
    })
  }

  async requeueDeadLetter(ids?: string[]): Promise<number> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches', 'dead_letter_batches'], 'readwrite')
      const walStore = tx.objectStore('wal_batches')
      const deadStore = tx.objectStore('dead_letter_batches')
      const req = deadStore.openCursor()
      let count = 0

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const dl = cursor.value as DeadLetterEntry
          if (!ids || ids.includes(dl.id)) {
            const entry: WalEntry = {
              id: dl.id,
              sessionName: dl.sessionName,
              sessionId: dl.sessionId,
              payload: dl.payload,
              createdAt: dl.createdAt,
              attempts: 0,
              status: 'pending',
            }
            walStore.put(entry)
            cursor.delete()
            count++
          }
          cursor.continue()
        } else {
          resolve(count)
        }
      }
      req.onerror = () => reject(new WALStorageError(`IndexedDB requeue dead letter error: ${req.error?.message}`))
    })
  }

  async purgeDeadLetter(beforeTimestamp?: number): Promise<number> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['dead_letter_batches'], 'readwrite')
      const store = tx.objectStore('dead_letter_batches')
      const req = store.openCursor()
      let count = 0

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const dl = cursor.value as DeadLetterEntry
          if (!beforeTimestamp || dl.failedAt < beforeTimestamp) {
            cursor.delete()
            count++
          }
          cursor.continue()
        } else {
          resolve(count)
        }
      }
      req.onerror = () => reject(new WALStorageError(`IndexedDB purge dead letter error: ${req.error?.message}`))
    })
  }

  async recover(): Promise<number> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches'], 'readwrite')
      const store = tx.objectStore('wal_batches')
      const index = store.index('status')
      const req = index.openCursor(IDBKeyRange.only('sending'))
      let count = 0

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const updated = { ...cursor.value, status: 'pending' }
          cursor.update(updated)
          count++
          cursor.continue()
        } else {
          resolve(count)
        }
      }
      req.onerror = () => reject(new WALStorageError(`IndexedDB recovery error: ${req.error?.message}`))
    })
  }

  async countPending(): Promise<number> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['wal_batches'], 'readonly')
      const store = tx.objectStore('wal_batches')
      const req = store.count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(new WALStorageError(`IndexedDB count error: ${req.error?.message}`))
    })
  }

  async countDeadLetter(): Promise<number> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['dead_letter_batches'], 'readonly')
      const store = tx.objectStore('dead_letter_batches')
      const req = store.count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(new WALStorageError(`IndexedDB dead letter count error: ${req.error?.message}`))
    })
  }

  async getStats(): Promise<WalStorageStats> {
    const pending = await this.countPending()
    const deadLetter = await this.countDeadLetter()
    return {
      pendingCount: pending,
      sendingCount: 0,
      deadLetterCount: deadLetter,
      maxEntries: this._maxEntries,
      maxDeadLetterEntries: this._maxDeadLetterEntries,
      isDurable: false,
      storageType: this.storageType,
      isPersisted: this._isPersisted,
      guarantees: {
        processCrashDurable: true,
        osCrashDurable: false,
        powerLossDurable: false,
        notes:
          'Browser IndexedDB survives page reloads and tab closures, but may be evicted by the browser under extreme disk pressure unless navigator.storage.persist() is granted.',
      },
    }
  }

  async clear(): Promise<void> {
    const db = await this._getDb()
    return new Promise((resolve, reject) => {
      const tx = this._createTransaction(db, ['wal_batches', 'dead_letter_batches'], 'readwrite')
      tx.objectStore('wal_batches').clear()
      tx.objectStore('dead_letter_batches').clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new WALStorageError(`IndexedDB clear error: ${tx.error?.message}`))
    })
  }
}
