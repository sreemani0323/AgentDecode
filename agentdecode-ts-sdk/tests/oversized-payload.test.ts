import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Session, MAX_SAFE_INGEST_PAYLOAD_BYTES, splitSpansIntoBoundedChunks } from '../src/session'
import { AgentDecode } from '../src/client'
import { MemoryWalStorage } from '../src/index'
import type { SpanData } from '../src/span'

describe('Oversized Payload Enforcement (4 MiB boundary)', () => {
  it('splitSpansIntoBoundedChunks partitions spans when total size exceeds threshold', () => {
    const basePayload = {
      session_name: 'Big Session',
      session_id: 'sess-1',
    }

    // Create 10 spans, each ~500 KB -> ~5 MB total
    const largeString = 'x'.repeat(500 * 1024)
    const spans: SpanData[] = Array.from({ length: 10 }, (_, i) => ({
      name: `span_${i}`,
      span_type: 'tool',
      status: 'ok',
      started_at: new Date().toISOString(),
      client_span_id: `span-${i}`,
      parent_client_span_id: i > 0 ? `span-${i - 1}` : undefined,
      input: { data: largeString },
    }))

    const totalPayloadBytes = Buffer.byteLength(
      JSON.stringify({ ...basePayload, spans }),
      'utf8',
    )
    expect(totalPayloadBytes).toBeGreaterThan(4 * 1024 * 1024) // > 4 MiB

    const chunks = splitSpansIntoBoundedChunks(
      spans,
      basePayload,
      MAX_SAFE_INGEST_PAYLOAD_BYTES,
    )

    expect(chunks.length).toBeGreaterThan(1)

    // Check each chunk serialized is <= MAX_SAFE_INGEST_PAYLOAD_BYTES
    let totalSpansCount = 0
    for (const chunk of chunks) {
      totalSpansCount += chunk.length
      const chunkBytes = Buffer.byteLength(
        JSON.stringify({ ...basePayload, spans: chunk }),
        'utf8',
      )
      expect(chunkBytes).toBeLessThanOrEqual(MAX_SAFE_INGEST_PAYLOAD_BYTES)
    }

    expect(totalSpansCount).toBe(10)
    // Verify span order and parent relationships preserved
    const flatSpanIds = chunks.flatMap((c) => c.map((s) => s.client_span_id))
    expect(flatSpanIds).toEqual(spans.map((s) => s.client_span_id))
  })

  it('Session.flush() splits oversized spans into multiple requests <= 3.5 MiB and acknowledges WAL batches', async () => {
    const wal = new MemoryWalStorage()
    const receivedRequests: any[] = []

    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      const parsed = JSON.parse(opts.body)
      const byteLength = Buffer.byteLength(opts.body, 'utf8')
      receivedRequests.push({ payload: parsed, byteLength })
      return {
        ok: true,
        status: 200,
        text: async () => '{"received":1}',
      }
    })

    const session = new Session({
      apiKey: 'al_test_key',
      sessionName: 'Big Batch Session',
      sessionId: 'sess-big-1',
      endpoint: 'https://agent-decode.vercel.app',
      wal,
    })
    session._fetchFn = mockFetch

    // Add 8 spans of 500 KB each = ~4 MB of input payload
    const largeData = 'a'.repeat(500 * 1024)
    for (let i = 0; i < 8; i++) {
      const span = session.startSpan(`large_span_${i}`, 'tool')
      span.input = { chunk: largeData }
      session._pushSpan(span.finish())
    }

    await session.flush()

    // Verify multiple requests sent
    expect(receivedRequests.length).toBeGreaterThanOrEqual(2)
    for (const req of receivedRequests) {
      expect(req.byteLength).toBeLessThanOrEqual(MAX_SAFE_INGEST_PAYLOAD_BYTES)
    }

    // Verify all spans accounted for
    const allSpans = receivedRequests.flatMap((r) => r.payload.spans)
    expect(allSpans.length).toBe(8)

    // Verify WAL has acknowledged all batches (0 pending)
    const pending = await wal.getPending()
    expect(pending.length).toBe(0)
  })

  it('Session.flush() partially acknowledges accepted chunks if later chunk fails', async () => {
    const wal = new MemoryWalStorage()
    let requestCount = 0

    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      requestCount++
      if (requestCount === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => '{"received":1}',
        }
      }
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }
    })

    const session = new Session({
      apiKey: 'al_test_key',
      sessionName: 'Partial Fail Session',
      sessionId: 'sess-partial-1',
      endpoint: 'https://agent-decode.vercel.app',
      wal,
    })
    session._fetchFn = mockFetch

    // Add 8 spans of 500 KB each = ~4 MB payload -> 2 chunks
    const largeData = 'b'.repeat(500 * 1024)
    for (let i = 0; i < 8; i++) {
      const span = session.startSpan(`fail_span_${i}`, 'tool')
      span.input = { chunk: largeData }
      session._pushSpan(span.finish())
    }

    await expect(session.flush()).rejects.toThrow('HTTP 500')

    // Chunk 1 was acknowledged, Chunk 2 failed and remained in WAL
    const pending = await wal.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0].payload.spans.length).toBeLessThan(8)
  })

  it('AgentDecode.flush() handles oversized batch previously written to WAL', async () => {
    const wal = new MemoryWalStorage()
    const receivedRequests: any[] = []

    const largeData = 'c'.repeat(500 * 1024)
    const spans: SpanData[] = Array.from({ length: 8 }, (_, i) => ({
      name: `recovered_span_${i}`,
      span_type: 'chain',
      status: 'ok',
      started_at: new Date().toISOString(),
      client_span_id: `rec-span-${i}`,
      input: { data: largeData },
    }))

    // Directly enqueue an oversized batch into WAL
    await wal.enqueue(
      {
        session_name: 'Recovered Session',
        session_id: 'rec-sess-1',
        spans,
      },
      'Recovered Session',
      'rec-sess-1',
    )

    const agent = new AgentDecode({
      apiKey: 'al_test_key',
      walStorage: wal,
    })

    const acked = await agent.flush(async (payload: any) => {
      const byteLength = Buffer.byteLength(JSON.stringify(payload), 'utf8')
      receivedRequests.push({ payload, byteLength })
    })

    expect(acked).toBe(1)
    expect(receivedRequests.length).toBeGreaterThanOrEqual(2)
    for (const req of receivedRequests) {
      expect(req.byteLength).toBeLessThanOrEqual(MAX_SAFE_INGEST_PAYLOAD_BYTES)
    }

    // Verify WAL has acknowledged the batch
    const pending = await wal.getPending()
    expect(pending.length).toBe(0)
  })
})
