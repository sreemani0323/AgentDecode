import { describe, test, expect, beforeEach } from 'vitest'
import { IdentityAuthority, CanonicalIdentity } from '@/lib/identity'

describe('Identity Authority & Concurrency Suite', () => {
  let authority: IdentityAuthority

  beforeEach(() => {
    authority = new IdentityAuthority()
  })

  test('Test 1 (Duplicate Identity): Duplicate registration returns single canonical identity', async () => {
    const reg = {
      projectId: 'proj-123',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      startedAt: '2026-11-03T10:00:00.000Z',
    }

    const first = await authority.registerIdentity(reg)
    expect(first.wasInserted).toBe(true)
    expect(first.dbId).toBeDefined()

    const duplicate = await authority.registerIdentity(reg)
    expect(duplicate.wasInserted).toBe(false)
    expect(duplicate.dbId).toBe(first.dbId)
    expect(duplicate.firstStartedAt.toISOString()).toBe(first.firstStartedAt.toISOString())
  })

  test('Test 2 (Concurrent Registration): 10 parallel workers receive exact same canonical identity', async () => {
    const reg = {
      projectId: 'proj-concurrent',
      traceId: 'c12fed9280137a8e2d82d27312f0b766',
      spanId: 'a3f899ba0dfa5c9f',
      startedAt: '2026-11-03T12:00:00.000Z',
    }

    // Launch 10 simultaneous registration workers
    const promises: Promise<CanonicalIdentity>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(authority.registerIdentity(reg))
    }

    const results = await Promise.all(promises)
    expect(results).toHaveLength(10)

    const firstDbId = results[0].dbId
    const firstTimestamp = results[0].firstStartedAt.toISOString()

    // Every worker must receive the exact same dbId and timestamp
    for (const res of results) {
      expect(res.dbId).toBe(firstDbId)
      expect(res.firstStartedAt.toISOString()).toBe(firstTimestamp)
    }

    // Exactly one worker got wasInserted = true, other 9 got false
    const insertedCount = results.filter((r) => r.wasInserted).length
    expect(insertedCount).toBe(1)
  })

  test('Test 3 (Altered Retry Timestamp): Altered retry timestamp preserves original canonical timestamp', async () => {
    const originalTime = new Date('2026-11-03T08:00:00.000Z')
    const alteredTime = new Date('2026-11-03T08:05:00.000Z')

    const first = await authority.registerIdentity({
      projectId: 'proj-timestamp',
      traceId: '11112222333344445555666677778888',
      spanId: '9999aaaabbbbcccc',
      startedAt: originalTime,
    })

    expect(first.firstStartedAt.toISOString()).toBe(originalTime.toISOString())

    // Retry with different timestamp
    const second = await authority.registerIdentity({
      projectId: 'proj-timestamp',
      traceId: '11112222333344445555666677778888',
      spanId: '9999aaaabbbbcccc',
      startedAt: alteredTime,
    })

    // Timestamp must NOT be overwritten!
    expect(second.firstStartedAt.toISOString()).toBe(originalTime.toISOString())
    expect(second.dbId).toBe(first.dbId)
  })

  test('Test 4 & 5 (Cross-Boundary Parent Rejection): Parent and child must belong to same project and trace', async () => {
    // Register parent in Project A, Trace 1
    const parent = await authority.registerIdentity({
      projectId: 'proj-A',
      traceId: 'trace-1111111111111111111111111111',
      spanId: 'parent0000000001',
      startedAt: new Date(),
    })

    // Child in Project B attempting to reference parent in Project A
    const crossProject = await authority.resolveParentRelationship(
      'proj-B',
      'trace-1111111111111111111111111111',
      'parent0000000001',
      'child-uuid-1',
      new Date()
    )
    expect(crossProject.parentSpanId).toBeNull() // Not resolved across project

    // Child in Project A attempting to reference parent across different trace
    const crossTrace = await authority.resolveParentRelationship(
      'proj-A',
      'trace-2222222222222222222222222222',
      'parent0000000001',
      'child-uuid-2',
      new Date()
    )
    expect(crossTrace.parentSpanId).toBeNull() // Not resolved across trace
  })

  test('Test 6 (Child Before Parent): Out-of-order parent resolution via pending table', async () => {
    const projectId = 'proj-ooo'
    const traceId = 'trace-order-1234567890abcdef1234'
    const parentSpanIdHex = 'parent9988776655'
    const childDbId = 'child-db-uuid-100'

    // 1. Child arrives first
    const childRel = await authority.resolveParentRelationship(
      projectId,
      traceId,
      parentSpanIdHex,
      childDbId,
      new Date('2026-11-03T10:01:00Z')
    )

    expect(childRel.parentSpanId).toBeNull()
    expect(childRel.isPending).toBe(true)
    expect(authority.getPendingCount()).toBe(1)

    // 2. Parent arrives later and registers canonical identity with its true timestamp
    const parent = await authority.registerIdentity({
      projectId,
      traceId,
      spanId: parentSpanIdHex,
      startedAt: new Date('2026-11-03T10:00:00Z'),
    })

    // 3. Resolve pending children
    const resolvedChildren = await authority.resolvePendingChildren(
      projectId,
      traceId,
      parentSpanIdHex,
      parent.dbId
    )

    expect(resolvedChildren).toContain(childDbId)
    expect(authority.getPendingCount()).toBe(0)
  })

  test('Test 7 (Parent Never Arrives): Child remains valid with null parent', async () => {
    const childRel = await authority.resolveParentRelationship(
      'proj-orphan',
      'trace-orphan-1234567890abcdef12',
      'non-existent-parent',
      'child-db-orphan-1',
      new Date()
    )

    expect(childRel.parentSpanId).toBeNull()
    expect(childRel.isPending).toBe(true)
    // Child is valid; database column parent_span_id remains NULL (root of subtree)
  })
})
