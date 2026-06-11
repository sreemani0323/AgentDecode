import { describe, test, expect } from 'vitest'
import { validateIngestPayload } from '@/lib/validation'

describe('validateIngestPayload', () => {
  const validSpan = {
    name: 'test-span',
    span_type: 'llm',
    status: 'ok',
    started_at: '2024-01-01T00:00:00.000Z',
    ended_at: '2024-01-01T00:00:01.000Z',
    duration_ms: 1000,
    input: { message: 'hello' },
    output: { response: 'world' },
  }

  test('accepts a valid payload with all fields', () => {
    const result = validateIngestPayload({
      session_id: 'session_123',
      session_name: 'Test Session',
      spans: [validSpan],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.spans).toHaveLength(1)
      expect(result.data.session_id).toBe('session_123')
    }
  })

  test('accepts a minimal payload with only required fields', () => {
    const result = validateIngestPayload({
      spans: [{
        name: 'min-span',
        started_at: '2024-01-01T00:00:00.000Z',
      }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.spans[0].name).toBe('min-span')
      expect(result.data.spans[0].span_type).toBe('chain') // default
      expect(result.data.spans[0].status).toBe('ok') // default
    }
  })

  test('rejects payload with empty spans array', () => {
    const result = validateIngestPayload({ spans: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('at least one span')
    }
  })

  test('rejects payload with no spans field', () => {
    const result = validateIngestPayload({ session_id: 'abc' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.details.length).toBeGreaterThan(0)
    }
  })

  test('rejects payload with invalid span_type', () => {
    const result = validateIngestPayload({
      spans: [{ ...validSpan, span_type: 'invalid_type' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects payload with invalid started_at format', () => {
    const result = validateIngestPayload({
      spans: [{ ...validSpan, started_at: 'not-a-date' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ISO 8601')
    }
  })

  test('rejects span with empty name', () => {
    const result = validateIngestPayload({
      spans: [{ ...validSpan, name: '' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects payload with negative token count', () => {
    const result = validateIngestPayload({
      spans: [{ ...validSpan, input_tokens: -5 }],
    })
    expect(result.success).toBe(false)
  })

  test('accepts all valid span_type values', () => {
    const types = ['llm', 'tool', 'retrieval', 'chain', 'agent', 'embedding', 'rerank', 'guardrail', 'other']
    for (const type of types) {
      const result = validateIngestPayload({
        spans: [{ ...validSpan, span_type: type }],
      })
      expect(result.success).toBe(true)
    }
  })

  test('rejects non-object input', () => {
    expect(validateIngestPayload(null).success).toBe(false)
    expect(validateIngestPayload('string').success).toBe(false)
    expect(validateIngestPayload(42).success).toBe(false)
  })

  test('provides detailed error paths', () => {
    const result = validateIngestPayload({
      spans: [{ name: '', started_at: 'bad' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.details.length).toBeGreaterThanOrEqual(1)
      // Each detail should have path and message
      for (const detail of result.details) {
        expect(detail).toHaveProperty('path')
        expect(detail).toHaveProperty('message')
      }
    }
  })
})
