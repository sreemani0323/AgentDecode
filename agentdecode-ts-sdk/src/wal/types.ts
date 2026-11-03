export class WALError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WALError'
  }
}

export class WALCapacityError extends WALError {
  constructor(message: string) {
    super(message)
    this.name = 'WALCapacityError'
  }
}

export class WALStorageError extends WALError {
  constructor(message: string) {
    super(message)
    this.name = 'WALStorageError'
  }
}

export interface WalBatchPayload {
  session_name: string
  session_id?: string
  spans: any[]
}

export interface WalEntry {
  id: string
  sessionName: string
  sessionId?: string
  payload: WalBatchPayload
  createdAt: number
  attempts: number
  lastError?: string
  status: 'pending' | 'sending'
}

export interface DeadLetterEntry {
  id: string
  sessionName: string
  sessionId?: string
  payload: WalBatchPayload
  createdAt: number
  attempts: number
  errorMessage: string
  failedAt: number
}

export interface WalDurabilityGuarantees {
  processCrashDurable: boolean
  osCrashDurable: boolean
  powerLossDurable: boolean
  notes: string
}

export interface WalStorageStats {
  pendingCount: number
  sendingCount: number
  deadLetterCount: number
  maxEntries: number
  maxDeadLetterEntries?: number
  isDurable: boolean
  storageType: 'node-fs-atomic' | 'indexeddb-best-effort' | 'in-memory-volatile'
  platform?: string
  guarantees?: WalDurabilityGuarantees
  isPersisted?: boolean
  hasOrphanedFiles?: boolean
  quarantinedCount?: number
}

export interface WalStorageOptions {
  storageDir?: string
  dbName?: string
  maxEntries?: number
  maxDeadLetterEntries?: number
  disabled?: boolean
}

export interface IWalStorage {
  readonly isDurable: boolean
  readonly storageType: 'node-fs-atomic' | 'indexeddb-best-effort' | 'in-memory-volatile'
  enqueue(payload: WalBatchPayload, sessionName: string, sessionId?: string): Promise<string>
  getPending(limit?: number): Promise<WalEntry[]>
  markSending(ids: string[]): Promise<void>
  acknowledge(id: string): Promise<void>
  recordRetry(id: string, errorMessage: string): Promise<void>
  recordPermanentFailure(id: string, errorMessage: string): Promise<void>
  getDeadLetter(limit?: number): Promise<DeadLetterEntry[]>
  requeueDeadLetter(ids?: string[]): Promise<number>
  purgeDeadLetter(beforeTimestamp?: number): Promise<number>
  recover(): Promise<number>
  countPending(): Promise<number>
  countDeadLetter(): Promise<number>
  getStats(): Promise<WalStorageStats>
  clear(): Promise<void>
  close?(): Promise<void>
}
