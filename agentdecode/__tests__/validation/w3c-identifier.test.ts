import { describe, test, expect } from 'vitest'
import {
  isValidW3CTraceId,
  isValidW3CSpanId,
  generateW3CTraceId,
  generateW3CSpanId,
  parseW3CTraceparent,
  formatLegacyTraceKey,
  formatLegacySpanKey,
  ALL_ZEROS_TRACE_ID,
  ALL_ZEROS_SPAN_ID,
} from '@/lib/identity'
import { validateIngestPayload } from '@/lib/validation'

describe('OpenTelemetry & W3C Trace Context Validation Suite', () => {
  test('Test 13 (Native W3C TraceId): 32 lowercase hex chars valid, all-zeros rejected', () => {
    const valid = generateW3CTraceId()
    expect(valid).toHaveLength(32)
    expect(isValidW3CTraceId(valid)).toBe(true)

    // Rejection cases
    expect(isValidW3CTraceId(ALL_ZEROS_TRACE_ID)).toBe(false)
    expect(isValidW3CTraceId('4bf92f3577b34da6a3ce929d0e0e473')).toBe(false) // 31 chars
    expect(isValidW3CTraceId('4bf92f3577b34da6a3ce929d0e0e47361')).toBe(false) // 33 chars
    expect(isValidW3CTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(false) // Uppercase invalid
    expect(isValidW3CTraceId('4bf92f35-77b3-4da6-a3ce-929d0e0e4736')).toBe(false) // UUID with hyphens invalid
  })

  test('Test 14 (Native W3C SpanId): 16 lowercase hex chars valid, all-zeros rejected', () => {
    const valid = generateW3CSpanId()
    expect(valid).toHaveLength(16)
    expect(isValidW3CSpanId(valid)).toBe(true)

    // Rejection cases
    expect(isValidW3CSpanId(ALL_ZEROS_SPAN_ID)).toBe(false)
    expect(isValidW3CSpanId('00f067aa0ba902b')).toBe(false) // 15 chars
    expect(isValidW3CSpanId('00f067aa0ba902b71')).toBe(false) // 17 chars
    expect(isValidW3CSpanId('00F067AA0BA902B7')).toBe(false) // Uppercase invalid
    expect(isValidW3CSpanId('replace_uuid_32_characters_here_')).toBe(false) // 32 hex chars invalid for SpanId!
  })

  test('Test 15 (Traceparent Header Parsing): Upstream parent-id is separated from current span', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const parsed = parseW3CTraceparent(header)

    expect(parsed).not.toBeNull()
    expect(parsed?.version).toBe('00')
    expect(parsed?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(parsed?.parentId).toBe('00f067aa0ba902b7') // This is the UPSTREAM parent, not the span's own ID!
    expect(parsed?.traceFlags).toBe('01')

    // Invalid headers
    expect(parseW3CTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull() // ff version forbidden
    expect(parseW3CTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull() // all zero traceId
    expect(parseW3CTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull() // all zero parentId
  })

  test('Test 16 (Synthetic Legacy Trace & Span Mapping): Legacy keys formatted and distinguished', () => {
    const sessionUuid = '12345678-1234-5678-1234-567812345678'
    const spanUuid = '87654321-4321-8765-4321-876543210987'

    const legacyTraceKey = formatLegacyTraceKey(sessionUuid)
    const legacySpanKey = formatLegacySpanKey(spanUuid)

    expect(legacyTraceKey).toBe('legacy_12345678123456781234567812345678')
    expect(legacySpanKey).toBe('legacy_87654321432187654321876543210987')

    // Ingest payload schema accepts legacy keys with is_legacy = true
    const result = validateIngestPayload({
      spans: [{
        name: 'legacy-span',
        started_at: '2026-11-03T10:00:00.000Z',
        trace_id: legacyTraceKey,
        span_id: legacySpanKey,
        is_legacy: true,
      }],
    })

    expect(result.success).toBe(true)
  })

  test('Test 17 (Reject Non-Conforming OTel IDs): Malformed native IDs fail validation', () => {
    // 32-character string passed as native span_id (without legacy prefix) is rejected!
    const result = validateIngestPayload({
      spans: [{
        name: 'invalid-span',
        started_at: '2026-11-03T10:00:00.000Z',
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        span_id: '12345678123456781234567812345678', // 32 hex chars! Invalid for native OTel SpanId (must be 16)
        is_legacy: false,
      }],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('span_id')
    }
  })
})
