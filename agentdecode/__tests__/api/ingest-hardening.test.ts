import { describe, test, expect, vi, beforeEach } from 'vitest'
import { MAX_REQUEST_BODY_BYTES, MAX_FIELD_BYTES, MAX_METADATA_BYTES } from '@/lib/validation'
import { POST } from '@/app/api/ingest/route'

vi.mock('@/lib/env', () => ({
  checkEnv: () => ({ ok: true, missing: [], warnings: [] }),
}))

vi.mock('@/lib/alerts', () => ({
  checkAndFireAlerts: vi.fn(() => Promise.resolve()),
}))

let mockRpcFn: any = vi.fn()
let mockApiKeyRecord: any = { id: 'key-1', project_id: 'proj-1' }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: mockApiKeyRecord, error: null }),
          }),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ data: null, error: null }),
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'test-id' }, error: null }),
        }),
      }),
      upsert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'test-id' }, error: null }),
        }),
      }),
    }),
    rpc: (...args: any[]) => mockRpcFn(...args),
  }),
}))

describe('Ingest API Route Hardening', () => {
  const VALID_AUTH_HEADER = 'Bearer test_api_key_12345'

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.GATEWAY_WRITE_MAINTENANCE
    delete process.env.ALLOW_INGEST_FALLBACK
  })

  describe('Request Body Size Limits (HTTP 413)', () => {
    test('enforces exact 4 MiB (4,194,304 bytes) boundary on Content-Length header', async () => {
      // 4 MiB + 1 byte -> 413
      const oversizedLength = 4 * 1024 * 1024 + 1
      const requestOver = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Length': oversizedLength.toString(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ spans: [] }),
      })

      const responseOver = await POST(requestOver)
      expect(responseOver.status).toBe(413)
      const dataOver = await responseOver.json()
      expect(dataOver.error).toContain('Payload Too Large')

      // Exactly 4 MiB -> passes size check (not 413)
      const exactLength = 4 * 1024 * 1024
      const requestExact = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Length': exactLength.toString(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ spans: [] }),
      })

      const responseExact = await POST(requestExact)
      expect(responseExact.status).not.toBe(413)
    })

    test('returns HTTP 413 when streamed payload exceeds 4 MiB', async () => {
      const hugeString = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1)
      const hugePayload = JSON.stringify({
        spans: [
          {
            name: 'huge-span',
            started_at: new Date().toISOString(),
            input: hugeString,
          },
        ],
      })

      const request = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: hugePayload,
      })

      const response = await POST(request)
      expect(response.status).toBe(413)
      const data = await response.json()
      expect(data.error).toContain('Payload Too Large')
    })
  })

  describe('Field-Level Validation & Limits (HTTP 400)', () => {
    test('rejects span with input exceeding 1MB with HTTP 400', async () => {
      const oversizedInput = 'a'.repeat(MAX_FIELD_BYTES + 10)
      const payload = {
        spans: [
          {
            name: 'oversized-input-span',
            started_at: new Date().toISOString(),
            input: oversizedInput,
          },
        ],
      }

      const request = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toContain('Validation failed')
    })

    test('rejects span with metadata exceeding 256KB with HTTP 400', async () => {
      const oversizedMetadata = {
        giantField: 'm'.repeat(MAX_METADATA_BYTES + 10),
      }
      const payload = {
        spans: [
          {
            name: 'oversized-metadata-span',
            started_at: new Date().toISOString(),
            metadata: oversizedMetadata,
          },
        ],
      }

      const request = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toContain('Validation failed')
    })

    test('rejects request with more than 500 spans with HTTP 400', async () => {
      const spans = Array.from({ length: 501 }, (_, i) => ({
        name: `span-${i}`,
        started_at: new Date().toISOString(),
      }))

      const request = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ spans }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toContain('Validation failed')
    })
  })

  describe('Transactional Fail-Closed Ingestion (HTTP 503)', () => {
    test('fails closed with HTTP 503 and Retry-After: 5 when transactional RPC fails in production/default', async () => {
      mockRpcFn.mockResolvedValueOnce({
        data: null,
        error: { message: 'relation public.spans does not exist' },
      })

      delete process.env.ALLOW_INGEST_FALLBACK

      const payload = {
        spans: [
          {
            name: 'test-span',
            started_at: new Date().toISOString(),
          },
        ],
      }

      const request = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: VALID_AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      const response = await POST(request)
      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe('5')

      const data = await response.json()
      expect(data.retryable).toBe(true)
      expect(data.error).toContain('Ingestion temporarily unavailable; please retry')
    })
  })
})
