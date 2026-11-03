import { IWalStorage, WalStorageOptions } from './types.js'
import { MemoryWalStorage } from './memory-storage.js'
import { NodeFsWalStorage } from './node-storage.js'
import { IndexedDbWalStorage } from './idb-storage.js'

export * from './types.js'
export { MemoryWalStorage } from './memory-storage.js'
export { NodeFsWalStorage } from './node-storage.js'
export { IndexedDbWalStorage } from './idb-storage.js'

/**
 * Creates the appropriate WAL storage adapter based on runtime environment.
 * - In Node.js: returns `NodeFsWalStorage` (atomic filesystem)
 * - In Browsers: returns `IndexedDbWalStorage` (IndexedDB transactions)
 * - Otherwise / Fallback / Disabled: returns `MemoryWalStorage`
 */
export function createWalStorage(options?: WalStorageOptions): IWalStorage {
  if (options?.disabled) {
    return new MemoryWalStorage(options)
  }

  // Detect Node.js environment
  if (
    typeof process !== 'undefined' &&
    process.versions &&
    Boolean(process.versions.node)
  ) {
    try {
      return new NodeFsWalStorage(options)
    } catch {
      return new MemoryWalStorage(options)
    }
  }

  // Detect Browser IndexedDB
  if (
    typeof globalThis !== 'undefined' &&
    'indexedDB' in globalThis &&
    Boolean(globalThis.indexedDB)
  ) {
    try {
      return new IndexedDbWalStorage(options)
    } catch {
      return new MemoryWalStorage(options)
    }
  }

  return new MemoryWalStorage(options)
}
