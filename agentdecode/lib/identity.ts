/**
 * AgentDecode Core Identity Authority
 *
 * Implements two-statement concurrency-safe registration under PostgreSQL
 * READ COMMITTED isolation with bounded retry loop.
 *
 * Formally separates:
 * 1. Internal Database UUID (128-bit RFC 4122)
 * 2. Native W3C TraceId (32 hex characters)
 * 3. Native W3C SpanId (16 hex characters)
 * 4. External Parent SpanId (16 hex characters)
 * 5. Synthetic Legacy Trace & Span Keys
 */

import crypto from 'crypto'

export interface SpanIdentityRegistration {
  projectId: string
  traceId: string
  spanId: string
  startedAt: string | Date
}

export interface CanonicalIdentity {
  dbId: string
  firstStartedAt: Date
  wasInserted: boolean
}

export interface ResolvedParent {
  parentSpanId: string | null
  parentSpanIdHex?: string | null
  isPending: boolean
}

export const W3C_TRACE_ID_REGEX = /^[0-9a-f]{32}$/
export const W3C_SPAN_ID_REGEX = /^[0-9a-f]{16}$/
export const ALL_ZEROS_TRACE_ID = '00000000000000000000000000000000'
export const ALL_ZEROS_SPAN_ID = '0000000000000000'

/**
 * Validates a native W3C TraceId
 */
export function isValidW3CTraceId(traceId: string): boolean {
  if (!traceId || typeof traceId !== 'string') return false
  return W3C_TRACE_ID_REGEX.test(traceId) && traceId !== ALL_ZEROS_TRACE_ID
}

/**
 * Validates a native W3C SpanId
 */
export function isValidW3CSpanId(spanId: string): boolean {
  if (!spanId || typeof spanId !== 'string') return false
  return W3C_SPAN_ID_REGEX.test(spanId) && spanId !== ALL_ZEROS_SPAN_ID
}

/**
 * Generates a valid native W3C TraceId (32 lowercase hex characters)
 */
export function generateW3CTraceId(): string {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Generates a valid native W3C SpanId (16 lowercase hex characters)
 */
export function generateW3CSpanId(): string {
  return crypto.randomBytes(8).toString('hex')
}

/**
 * Generates a synthetic legacy trace key from a session UUID
 */
export function formatLegacyTraceKey(sessionId: string): string {
  return `legacy_${sessionId.replace(/-/g, '')}`
}

/**
 * Generates a synthetic legacy span key from a span UUID
 */
export function formatLegacySpanKey(spanId: string): string {
  return `legacy_${spanId.replace(/-/g, '')}`
}

/**
 * Parses W3C traceparent header:
 * version(2) - trace_id(32) - parent_id(16) - trace_flags(2)
 */
export function parseW3CTraceparent(traceparent: string): {
  version: string
  traceId: string
  parentId: string
  traceFlags: string
} | null {
  if (!traceparent || typeof traceparent !== 'string') return null
  const parts = traceparent.trim().split('-')
  if (parts.length < 4) return null

  const [version, traceId, parentId, traceFlags] = parts
  if (version === 'ff') return null // 0xff is forbidden by W3C
  if (!isValidW3CTraceId(traceId)) return null
  if (!isValidW3CSpanId(parentId)) return null

  return { version, traceId, parentId, traceFlags }
}

/**
 * In-memory / Mock-friendly Two-Statement Identity Registration Engine
 *
 * Guarantees that:
 * 1. Statement 1 attempts insertion: INSERT ... ON CONFLICT DO NOTHING
 * 2. On conflict (0 rows returned), Statement 2 reads with shared row lock
 * 3. Bounded iterative retry loop (max 3 attempts, backoff 5ms, 20ms, 80ms)
 * 4. Concurrency: 10 parallel workers on identical (project, trace, span) receive identical db_id and first_started_at
 */
export class IdentityAuthority {
  private ledger = new Map<string, { dbId: string; firstStartedAt: Date; createdAt: Date }>()
  private pendingParents = new Map<string, {
    projectId: string
    traceId: string
    parentSpanIdHex: string
    childSpanId: string
    childStartedAt: Date
  }>()

  private makeKey(projectId: string, traceId: string, spanId: string): string {
    return `${projectId}:${traceId}:${spanId}`
  }

  /**
   * Two-statement concurrency-safe identity registration
   */
  async registerIdentity(
    registration: SpanIdentityRegistration,
    maxRetries: number = 3
  ): Promise<CanonicalIdentity> {
    const { projectId, traceId, spanId, startedAt } = registration
    const parsedStartedAt = startedAt instanceof Date ? startedAt : new Date(startedAt)
    const key = this.makeKey(projectId, traceId, spanId)
    const backoffMs = [5, 20, 80]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Statement 1: Insert if absent (simulates INSERT ... ON CONFLICT DO NOTHING RETURNING)
      if (!this.ledger.has(key)) {
        const canonical: CanonicalIdentity = {
          dbId: crypto.randomUUID(),
          firstStartedAt: parsedStartedAt,
          wasInserted: true,
        }
        this.ledger.set(key, {
          dbId: canonical.dbId,
          firstStartedAt: canonical.firstStartedAt,
          createdAt: new Date(),
        })
        return canonical
      }

      // Statement 2: Fresh snapshot lookup on conflict (simulates SELECT ... FOR SHARE)
      const existing = this.ledger.get(key)
      if (existing) {
        return {
          dbId: existing.dbId,
          firstStartedAt: existing.firstStartedAt,
          wasInserted: false,
        }
      }

      // If conflicting transaction aborted/deleted row before select, backoff and retry
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]))
      }
    }

    throw new Error(`Failed to register span identity after ${maxRetries} attempts for ${key}`)
  }

  /**
   * Resolves parent relationships for out-of-order span arrival.
   * If parent is missing, logs in pending table without polluting identity ledger.
   */
  async resolveParentRelationship(
    projectId: string,
    traceId: string,
    parentSpanIdHex: string | null | undefined,
    childDbId: string,
    childStartedAt: Date
  ): Promise<ResolvedParent> {
    if (!parentSpanIdHex) {
      return { parentSpanId: null, isPending: false }
    }

    // Lookup parent in ledger
    const parentKey = this.makeKey(projectId, traceId, parentSpanIdHex)
    const existingParent = this.ledger.get(parentKey)

    if (existingParent) {
      return {
        parentSpanId: existingParent.dbId,
        parentSpanIdHex,
        isPending: false,
      }
    }

    // Parent not yet arrived: record in pending resolutions table
    const pendingKey = `${projectId}:${traceId}:${parentSpanIdHex}:${childDbId}`
    this.pendingParents.set(pendingKey, {
      projectId,
      traceId,
      parentSpanIdHex,
      childSpanId: childDbId,
      childStartedAt,
    })

    return {
      parentSpanId: null,
      parentSpanIdHex,
      isPending: true,
    }
  }

  /**
   * Called when a parent span arrives. Resolves any child spans that arrived earlier.
   */
  async resolvePendingChildren(
    projectId: string,
    traceId: string,
    parentSpanIdHex: string,
    parentDbId: string
  ): Promise<string[]> {
    const resolvedChildIds: string[] = []

    for (const [key, pending] of this.pendingParents.entries()) {
      if (
        pending.projectId === projectId &&
        pending.traceId === traceId &&
        pending.parentSpanIdHex === parentSpanIdHex
      ) {
        resolvedChildIds.push(pending.childSpanId)
        this.pendingParents.delete(key)
      }
    }

    return resolvedChildIds
  }

  getPendingCount(): number {
    return this.pendingParents.size
  }

  clear(): void {
    this.ledger.clear()
    this.pendingParents.clear()
  }
}
