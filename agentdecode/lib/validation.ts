import { z } from 'zod'

// ---------------------------------------------------------------------------
// OpenTelemetry / W3C Validation Constants & Helpers
// ---------------------------------------------------------------------------

export const W3C_TRACE_ID_REGEX = /^[0-9a-f]{32}$/
export const W3C_SPAN_ID_REGEX = /^[0-9a-f]{16}$/
export const ALL_ZEROS_TRACE_ID = '00000000000000000000000000000000'
export const ALL_ZEROS_SPAN_ID = '0000000000000000'

export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024 // 4 MiB (safe for Vercel Functions 4.5 MB limit)
export const MAX_FIELD_BYTES = 1 * 1024 * 1024 // 1 MB for individual input/output
export const MAX_METADATA_BYTES = 256 * 1024 // 256 KB for attributes and metadata
export const MAX_SPANS_PER_REQUEST = 500

function estimateJsonBytes(val: unknown): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'string') return Buffer.byteLength(val, 'utf8')
  try {
    return Buffer.byteLength(JSON.stringify(val), 'utf8')
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Span schema
// ---------------------------------------------------------------------------

export const SpanSchema = z.object({
  name: z.string().min(1, 'Span name is required'),
  span_type: z.enum(['llm', 'tool', 'chain', 'retrieval', 'agent', 'embedding', 'rerank', 'guardrail', 'other']).default('chain'),
  status: z.enum(['ok', 'error']).default('ok'),
  started_at: z.string().datetime({ message: 'started_at must be ISO 8601' }),
  ended_at: z.string().datetime({ message: 'ended_at must be ISO 8601' }).optional().nullable(),
  duration_ms: z.number().nonnegative().optional().nullable(),

  // Database internal parent UUID
  parent_span_id: z.string().uuid().optional().nullable(),

  // Client mapping IDs (for in-batch nesting)
  client_span_id: z.string().min(1).optional().nullable(),
  parent_client_span_id: z.string().min(1).optional().nullable(),

  // OpenTelemetry Canonical Identifiers
  trace_id: z.string().min(1).optional().nullable()
    .refine((val) => {
      if (!val) return true
      if (val.startsWith('legacy_')) return true
      return W3C_TRACE_ID_REGEX.test(val) && val !== ALL_ZEROS_TRACE_ID
    }, { message: 'trace_id must be a valid 32-hex W3C TraceId (non-zero) or legacy key' }),

  span_id: z.string().min(1).optional().nullable()
    .refine((val) => {
      if (!val) return true
      if (val.startsWith('legacy_')) return true
      return W3C_SPAN_ID_REGEX.test(val) && val !== ALL_ZEROS_SPAN_ID
    }, { message: 'span_id must be a valid 16-hex W3C SpanId (non-zero) or legacy key' }),

  parent_span_id_hex: z.string().min(1).optional().nullable()
    .refine((val) => {
      if (!val) return true
      return W3C_SPAN_ID_REGEX.test(val) && val !== ALL_ZEROS_SPAN_ID
    }, { message: 'parent_span_id_hex must be a valid 16-hex W3C parent SpanId' }),

  is_legacy: z.boolean().optional().default(false),
  attributes: z.record(z.string(), z.unknown()).optional().default({})
    .refine((v) => estimateJsonBytes(v) <= MAX_METADATA_BYTES, {
      message: `attributes exceed maximum allowed size of ${MAX_METADATA_BYTES / 1024}KB`,
    }),
  links: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  workflow_step: z.number().int().optional().nullable(),
  iteration_index: z.number().int().optional().nullable(),

  model: z.string().optional().nullable(),
  input: z.unknown().optional().nullable()
    .refine((v) => estimateJsonBytes(v) <= MAX_FIELD_BYTES, {
      message: `input exceeds maximum allowed size of ${MAX_FIELD_BYTES / (1024 * 1024)}MB`,
    }),
  output: z.unknown().optional().nullable()
    .refine((v) => estimateJsonBytes(v) <= MAX_FIELD_BYTES, {
      message: `output exceeds maximum allowed size of ${MAX_FIELD_BYTES / (1024 * 1024)}MB`,
    }),
  error_message: z.string().optional().nullable(),
  input_tokens: z.number().int().nonnegative().optional().nullable(),
  output_tokens: z.number().int().nonnegative().optional().nullable(),
  cost_usd: z.number().nonnegative().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().default({})
    .refine((v) => estimateJsonBytes(v) <= MAX_METADATA_BYTES, {
      message: `metadata exceeds maximum allowed size of ${MAX_METADATA_BYTES / 1024}KB`,
    }),
})

// ---------------------------------------------------------------------------
// Ingest payload schema
// ---------------------------------------------------------------------------

export const IngestPayloadSchema = z.object({
  session_id: z.string().min(1).optional(),
  session_name: z.string().min(1).max(200).optional(),
  batch_id: z.string().uuid().optional(),
  traceparent: z.string().optional(),
  spans: z
    .array(SpanSchema)
    .min(1, 'spans array must contain at least one span')
    .max(MAX_SPANS_PER_REQUEST, `Maximum ${MAX_SPANS_PER_REQUEST} spans per request`),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type IngestPayload = z.infer<typeof IngestPayloadSchema>
export type SpanInput = z.infer<typeof SpanSchema>

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate an ingest payload and return a clean result.
 * On failure, returns a human-readable error summary.
 */
export function validateIngestPayload(data: unknown): {
  success: true
  data: IngestPayload
} | {
  success: false
  error: string
  details: z.ZodIssue[]
} {
  const result = IngestPayloadSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }

  const firstError = result.error.issues[0]
  const message = firstError
    ? `Validation failed: ${firstError.path.join('.')}: ${firstError.message}`
    : 'Validation failed'

  return {
    success: false,
    error: message,
    details: result.error.issues,
  }
}
