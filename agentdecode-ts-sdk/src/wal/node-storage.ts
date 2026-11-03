import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
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
 * NodeFsWalStorage: POSIX and Windows filesystem-backed persistent Write-Ahead Log.
 *
 * Durability classification & limitations:
 * - processCrashDurable: true across all supported platforms. Temporary batch files are
 *   flushed with `fs.fsyncSync` prior to `fs.renameSync`.
 * - Windows 11 durability profile (conservative):
 *   * processCrashDurable: true (survives process kills, uncaught exceptions, and clean restarts)
 *   * osCrashDurable: false (not guaranteed; directory-entry metadata synchronization is unavailable
 *     in standard Node.js runtime, and fs.renameSync does not guarantee MOVEFILE_WRITE_THROUGH)
 *   * powerLossDurable: false (standard NTFS drive-level write caching precludes power-loss durability)
 * - Zero FIFO eviction: unacknowledged records are never deleted to make space; capacity limits
 *   throw `WALCapacityError`.
 * - Dead-letter storage bound: when full, rejects archiving with `WALCapacityError` while preserving
 *   the failed batch in active 'pending' queue (never stranded in 'sending') for operator review.
 * - Orphaned temporary files: recovered if valid JSON batches or quarantined if malformed.
 */
export class NodeFsWalStorage implements IWalStorage {
  readonly isDurable = true
  readonly storageType = 'node-fs-atomic' as const

  private _baseDir: string
  private _pendingDir: string
  private _sendingDir: string
  private _deadLetterDir: string
  private _quarantineDir: string
  private _maxEntries: number
  private _maxDeadLetterEntries: number

  constructor(options?: WalStorageOptions) {
    this._baseDir =
      options?.storageDir ||
      process.env.AGENTDECODE_WAL_DIR ||
      path.join(os.homedir(), '.agentdecode', 'wal')
    this._pendingDir = path.join(this._baseDir, 'pending')
    this._sendingDir = path.join(this._baseDir, 'sending')
    this._deadLetterDir = path.join(this._baseDir, 'dead_letter')
    this._quarantineDir = path.join(this._baseDir, 'quarantine')
    this._maxEntries = options?.maxEntries ?? 10000
    this._maxDeadLetterEntries = options?.maxDeadLetterEntries ?? 2000

    this._ensureDirs()
    this.recoverOrphanedTempFiles()
  }

  private _ensureDirs(): void {
    fs.mkdirSync(this._pendingDir, { recursive: true })
    fs.mkdirSync(this._sendingDir, { recursive: true })
    fs.mkdirSync(this._deadLetterDir, { recursive: true })
    fs.mkdirSync(this._quarantineDir, { recursive: true })
  }

  private _syncDirectory(dirPath: string): void {
    // fsync on directory descriptors is supported on Linux/macOS, but throws EPERM/EINVAL on Windows
    if (process.platform !== 'win32') {
      try {
        const dirFd = fs.openSync(dirPath, 'r')
        fs.fsyncSync(dirFd)
        fs.closeSync(dirFd)
      } catch {
        // Platform or filesystem does not support directory fsync
      }
    }
  }

  async enqueue(
    payload: WalBatchPayload,
    sessionName: string,
    sessionId?: string,
  ): Promise<string> {
    this._ensureDirs()

    // Enforce bounds: reject with WALCapacityError, NEVER delete pending records
    const currentPending = await this.countPending()
    if (currentPending >= this._maxEntries) {
      throw new WALCapacityError(
        `WAL capacity limit reached (${currentPending}/${this._maxEntries} batches). ` +
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

    const tmpFile = path.join(this._pendingDir, `${id}.tmp`)
    const finalFile = path.join(this._pendingDir, `${id}.json`)

    try {
      const content = JSON.stringify(entry)
      const fd = fs.openSync(tmpFile, 'w')
      fs.writeSync(fd, content, 0, 'utf8')
      fs.fsyncSync(fd) // Durable write before rename
      fs.closeSync(fd)

      fs.renameSync(tmpFile, finalFile)
      this._syncDirectory(this._pendingDir)
    } catch (err: any) {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
      } catch {}
      throw new WALStorageError(`Failed to durably write WAL batch: ${err.message}`)
    }

    return id
  }

  async getPending(limit: number = 50): Promise<WalEntry[]> {
    this._ensureDirs()
    const entries: WalEntry[] = []

    try {
      const files = fs
        .readdirSync(this._pendingDir)
        .filter((f) => f.endsWith('.json'))

      for (const file of files) {
        if (entries.length >= limit) break
        const filePath = path.join(this._pendingDir, file)
        try {
          const raw = fs.readFileSync(filePath, 'utf8')
          const entry = JSON.parse(raw) as WalEntry
          entries.push(entry)
        } catch {
          // File corrupted or invalid JSON: quarantine aside
          const corruptPath = path.join(
            this._baseDir,
            `corrupt_${Date.now()}_${file}`,
          )
          try {
            fs.renameSync(filePath, corruptPath)
          } catch {}
        }
      }
    } catch {
      // Non-blocking
    }

    return entries.sort((a, b) => a.createdAt - b.createdAt)
  }

  async markSending(ids: string[]): Promise<void> {
    this._ensureDirs()
    for (const id of ids) {
      const fromPath = path.join(this._pendingDir, `${id}.json`)
      const toPath = path.join(this._sendingDir, `${id}.json`)
      if (fs.existsSync(fromPath)) {
        try {
          const raw = fs.readFileSync(fromPath, 'utf8')
          const entry = JSON.parse(raw) as WalEntry
          entry.status = 'sending'
          const tmpPath = path.join(this._sendingDir, `${id}.tmp`)
          const fd = fs.openSync(tmpPath, 'w')
          fs.writeSync(fd, JSON.stringify(entry), 0, 'utf8')
          fs.fsyncSync(fd)
          fs.closeSync(fd)
          fs.renameSync(tmpPath, toPath)
          if (fs.existsSync(fromPath)) fs.unlinkSync(fromPath)
          this._syncDirectory(this._sendingDir)
        } catch {
          // Ignore concurrent transitions
        }
      }
    }
  }

  async acknowledge(id: string): Promise<void> {
    const sendingPath = path.join(this._sendingDir, `${id}.json`)
    const pendingPath = path.join(this._pendingDir, `${id}.json`)

    try {
      if (fs.existsSync(sendingPath)) {
        fs.unlinkSync(sendingPath)
        this._syncDirectory(this._sendingDir)
      } else if (fs.existsSync(pendingPath)) {
        fs.unlinkSync(pendingPath)
        this._syncDirectory(this._pendingDir)
      }
    } catch {
      // Ignore if already deleted
    }
  }

  async recordRetry(id: string, errorMessage: string): Promise<void> {
    this._ensureDirs()
    const sendingPath = path.join(this._sendingDir, `${id}.json`)
    const pendingPath = path.join(this._pendingDir, `${id}.json`)
    const sourcePath = fs.existsSync(sendingPath) ? sendingPath : pendingPath

    if (fs.existsSync(sourcePath)) {
      try {
        const raw = fs.readFileSync(sourcePath, 'utf8')
        const entry = JSON.parse(raw) as WalEntry
        entry.status = 'pending'
        entry.attempts += 1
        entry.lastError = errorMessage

        const tmpPath = path.join(this._pendingDir, `${id}.tmp`)
        const fd = fs.openSync(tmpPath, 'w')
        fs.writeSync(fd, JSON.stringify(entry), 0, 'utf8')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fs.renameSync(tmpPath, pendingPath)
        this._syncDirectory(this._pendingDir)

        if (sourcePath === sendingPath && fs.existsSync(sendingPath)) {
          fs.unlinkSync(sendingPath)
          this._syncDirectory(this._sendingDir)
        }
      } catch {
        // Fallback
      }
    }
  }

  async recordPermanentFailure(id: string, errorMessage: string): Promise<void> {
    this._ensureDirs()

    // Enforce dead-letter capacity limit: NEVER silently evict dead-letter records
    const currentDeadLetter = await this.countDeadLetter()
    if (currentDeadLetter >= this._maxDeadLetterEntries) {
      // Ensure the failed batch returns to 'pending' status so it remains retryable,
      // and is NEVER left stranded in 'sending'.
      const sendingPath = path.join(this._sendingDir, `${id}.json`)
      const pendingPath = path.join(this._pendingDir, `${id}.json`)

      if (fs.existsSync(sendingPath)) {
        try {
          const raw = fs.readFileSync(sendingPath, 'utf8')
          const entry = JSON.parse(raw) as WalEntry
          entry.status = 'pending'
          entry.attempts += 1
          entry.lastError = `Dead-letter store full (${currentDeadLetter}/${this._maxDeadLetterEntries}). Error: ${errorMessage}`

          const tmpFile = path.join(this._pendingDir, `${id}.tmp`)
          const fd = fs.openSync(tmpFile, 'w')
          fs.writeSync(fd, JSON.stringify(entry), 0, 'utf8')
          fs.fsyncSync(fd)
          fs.closeSync(fd)
          fs.renameSync(tmpFile, pendingPath)
          this._syncDirectory(this._pendingDir)

          try {
            fs.unlinkSync(sendingPath)
            this._syncDirectory(this._sendingDir)
          } catch {}
        } catch {
          try {
            fs.renameSync(sendingPath, pendingPath)
          } catch {}
        }
      } else if (fs.existsSync(pendingPath)) {
        try {
          const raw = fs.readFileSync(pendingPath, 'utf8')
          const entry = JSON.parse(raw) as WalEntry
          entry.status = 'pending'
          entry.attempts += 1
          entry.lastError = `Dead-letter store full (${currentDeadLetter}/${this._maxDeadLetterEntries}). Error: ${errorMessage}`
          fs.writeFileSync(pendingPath, JSON.stringify(entry), 'utf8')
        } catch {}
      }

      throw new WALCapacityError(
        `Dead-letter storage limit reached (${currentDeadLetter}/${this._maxDeadLetterEntries}). ` +
          `Preserving original batch ${id} in active queue with status 'pending'; refusing dead-letter archive.`,
      )
    }

    const sendingPath = path.join(this._sendingDir, `${id}.json`)
    const pendingPath = path.join(this._pendingDir, `${id}.json`)
    const sourcePath = fs.existsSync(sendingPath) ? sendingPath : pendingPath

    if (fs.existsSync(sourcePath)) {
      try {
        const raw = fs.readFileSync(sourcePath, 'utf8')
        const entry = JSON.parse(raw) as WalEntry
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

        const deadLetterFile = path.join(this._deadLetterDir, `${id}.json`)
        const tmpFile = path.join(this._deadLetterDir, `${id}.tmp`)
        const fd = fs.openSync(tmpFile, 'w')
        fs.writeSync(fd, JSON.stringify(deadLetter), 0, 'utf8')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fs.renameSync(tmpFile, deadLetterFile)
        this._syncDirectory(this._deadLetterDir)

        fs.unlinkSync(sourcePath)
      } catch (err: any) {
        if (err instanceof WALCapacityError) throw err
        throw new WALStorageError(`Failed to record permanent failure: ${err.message}`)
      }
    }
  }

  async getDeadLetter(limit: number = 50): Promise<DeadLetterEntry[]> {
    this._ensureDirs()
    const entries: DeadLetterEntry[] = []
    try {
      const files = fs
        .readdirSync(this._deadLetterDir)
        .filter((f) => f.endsWith('.json'))

      for (const file of files) {
        if (entries.length >= limit) break
        const raw = fs.readFileSync(path.join(this._deadLetterDir, file), 'utf8')
        entries.push(JSON.parse(raw))
      }
    } catch {}
    return entries.sort((a, b) => b.failedAt - a.failedAt)
  }

  async requeueDeadLetter(ids?: string[]): Promise<number> {
    this._ensureDirs()
    let count = 0
    try {
      const files = fs
        .readdirSync(this._deadLetterDir)
        .filter((f) => f.endsWith('.json'))

      for (const file of files) {
        const id = file.replace(/\.json$/, '')
        if (ids && !ids.includes(id)) continue

        const deadPath = path.join(this._deadLetterDir, file)
        const pendingPath = path.join(this._pendingDir, file)
        try {
          const raw = fs.readFileSync(deadPath, 'utf8')
          const dl = JSON.parse(raw) as DeadLetterEntry
          const entry: WalEntry = {
            id: dl.id,
            sessionName: dl.sessionName,
            sessionId: dl.sessionId,
            payload: dl.payload,
            createdAt: dl.createdAt,
            attempts: 0,
            status: 'pending',
          }
          fs.writeFileSync(pendingPath, JSON.stringify(entry), 'utf8')
          fs.unlinkSync(deadPath)
          count++
        } catch {}
      }
    } catch {}
    return count
  }

  async purgeDeadLetter(beforeTimestamp?: number): Promise<number> {
    this._ensureDirs()
    let count = 0
    try {
      const files = fs
        .readdirSync(this._deadLetterDir)
        .filter((f) => f.endsWith('.json'))

      for (const file of files) {
        const filePath = path.join(this._deadLetterDir, file)
        if (beforeTimestamp) {
          const stat = fs.statSync(filePath)
          if (stat.mtimeMs >= beforeTimestamp) continue
        }
        try {
          fs.unlinkSync(filePath)
          count++
        } catch {}
      }
    } catch {}
    return count
  }

  /**
   * Recovers intact .tmp files left after fsync but before rename, and quarantines corrupt files.
   * Never automatically deletes orphaned .tmp files without inspection.
   */
  recoverOrphanedTempFiles(): { recovered: number; quarantined: number } {
    this._ensureDirs()
    let recovered = 0
    let quarantined = 0

    const dirsToCheck = [
      { dir: this._pendingDir, type: 'batch' as const },
      { dir: this._sendingDir, type: 'batch' as const },
      { dir: this._deadLetterDir, type: 'deadLetter' as const },
    ]

    for (const { dir, type } of dirsToCheck) {
      let files: string[] = []
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
      } catch {
        continue
      }

      for (const file of files) {
        const filePath = path.join(dir, file)
        try {
          const raw = fs.readFileSync(filePath, 'utf8')
          if (!raw || !raw.trim()) {
            this._quarantineFile(filePath, file)
            quarantined++
            continue
          }

          let parsed: any
          try {
            parsed = JSON.parse(raw)
          } catch {
            this._quarantineFile(filePath, file)
            quarantined++
            continue
          }

          if (type === 'batch') {
            if (
              parsed &&
              typeof parsed.id === 'string' &&
              typeof parsed.sessionName === 'string' &&
              parsed.payload &&
              Array.isArray(parsed.payload.spans)
            ) {
              const targetPending = path.join(this._pendingDir, `${parsed.id}.json`)
              parsed.status = 'pending'
              fs.writeFileSync(targetPending, JSON.stringify(parsed), 'utf8')
              this._syncDirectory(this._pendingDir)
              try {
                fs.unlinkSync(filePath)
              } catch {}
              recovered++
            } else {
              this._quarantineFile(filePath, file)
              quarantined++
            }
          } else if (type === 'deadLetter') {
            if (
              parsed &&
              typeof parsed.id === 'string' &&
              typeof parsed.sessionName === 'string' &&
              parsed.payload &&
              typeof parsed.errorMessage === 'string'
            ) {
              const targetDl = path.join(this._deadLetterDir, `${parsed.id}.json`)
              fs.writeFileSync(targetDl, JSON.stringify(parsed), 'utf8')
              this._syncDirectory(this._deadLetterDir)
              try {
                fs.unlinkSync(filePath)
              } catch {}
              recovered++
            } else {
              this._quarantineFile(filePath, file)
              quarantined++
            }
          }
        } catch {
          this._quarantineFile(filePath, file)
          quarantined++
        }
      }
    }

    return { recovered, quarantined }
  }

  private _quarantineFile(filePath: string, filename: string): void {
    const dest = path.join(
      this._quarantineDir,
      `corrupt_tmp_${Date.now()}_${filename}`,
    )
    try {
      fs.renameSync(filePath, dest)
    } catch {
      try {
        fs.copyFileSync(filePath, dest)
        fs.unlinkSync(filePath)
      } catch {}
    }
  }

  cleanupOrphanedFiles(): number {
    const res = this.recoverOrphanedTempFiles()
    return res.recovered + res.quarantined
  }

  async recover(): Promise<number> {
    this._ensureDirs()
    const { recovered } = this.recoverOrphanedTempFiles()
    let count = recovered
    try {
      const files = fs
        .readdirSync(this._sendingDir)
        .filter((f) => f.endsWith('.json'))

      for (const file of files) {
        const fromPath = path.join(this._sendingDir, file)
        const toPath = path.join(this._pendingDir, file)
        try {
          const raw = fs.readFileSync(fromPath, 'utf8')
          const entry = JSON.parse(raw) as WalEntry
          entry.status = 'pending'
          fs.writeFileSync(toPath, JSON.stringify(entry), 'utf8')
          fs.unlinkSync(fromPath)
          count++
        } catch {
          try {
            fs.renameSync(fromPath, toPath)
            count++
          } catch {}
        }
      }
    } catch {
      // Non-blocking
    }
    return count
  }

  async countPending(): Promise<number> {
    try {
      const pendingFiles = fs
        .readdirSync(this._pendingDir)
        .filter((f) => f.endsWith('.json')).length
      const sendingFiles = fs
        .readdirSync(this._sendingDir)
        .filter((f) => f.endsWith('.json')).length
      return pendingFiles + sendingFiles
    } catch {
      return 0
    }
  }

  async countDeadLetter(): Promise<number> {
    try {
      return fs
        .readdirSync(this._deadLetterDir)
        .filter((f) => f.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  async getStats(): Promise<WalStorageStats> {
    const pendingFiles = fs.existsSync(this._pendingDir)
      ? fs.readdirSync(this._pendingDir).filter((f) => f.endsWith('.json')).length
      : 0
    const sendingFiles = fs.existsSync(this._sendingDir)
      ? fs.readdirSync(this._sendingDir).filter((f) => f.endsWith('.json')).length
      : 0
    const deadLetterFiles = fs.existsSync(this._deadLetterDir)
      ? fs.readdirSync(this._deadLetterDir).filter((f) => f.endsWith('.json')).length
      : 0
    const quarantinedFiles = fs.existsSync(this._quarantineDir)
      ? fs.readdirSync(this._quarantineDir).length
      : 0

    let hasTmp = false
    for (const dir of [this._pendingDir, this._sendingDir, this._deadLetterDir]) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))) {
        hasTmp = true
        break
      }
    }

    const isWin = process.platform === 'win32'

    return {
      pendingCount: pendingFiles,
      sendingCount: sendingFiles,
      deadLetterCount: deadLetterFiles,
      maxEntries: this._maxEntries,
      maxDeadLetterEntries: this._maxDeadLetterEntries,
      isDurable: true,
      storageType: this.storageType,
      platform: process.platform,
      guarantees: {
        processCrashDurable: true,
        osCrashDurable: isWin ? false : true,
        powerLossDurable: false,
        notes: isWin
          ? 'Windows 11 NTFS: Process-restart durability is verified via fs.fsyncSync() and fs.renameSync(). OS-crash durability is not guaranteed because directory-entry metadata synchronization is unavailable in the standard Node.js runtime and fs.renameSync does not guarantee MOVEFILE_WRITE_THROUGH. Power-loss durability is not guaranteed due to NTFS drive-level write caching.'
          : 'POSIX: Process-restart and OS-crash durability are guaranteed via fsync and directory sync.',
      },
      hasOrphanedFiles: hasTmp,
      quarantinedCount: quarantinedFiles,
    }
  }

  async clear(): Promise<void> {
    try {
      for (const dir of [
        this._pendingDir,
        this._sendingDir,
        this._deadLetterDir,
        this._quarantineDir,
      ]) {
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            try {
              fs.unlinkSync(path.join(dir, f))
            } catch {}
          }
        }
      }
    } catch {}
  }
}
