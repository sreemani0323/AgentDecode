import { z } from 'zod'

// ---------------------------------------------------------------------------
// Span schema
// ---------------------------------------------------------------------------

const SpanSchema = z.object({
  name: z.string().min(1, 'Span name is required'),
  span_type: z.enum(['llm', 'tool', 'chain', 'retrieval', 'agent', 'embedding', 'rerank', 'guardrail', 'other']).default('chain'),
  status: z.enum(['ok', 'error']).default('ok'),
  started_at: z.string().datetime({ message: 'started_at must be ISO 8601' }),
  ended_at: z.string().datetime({ message: 'ended_at must be ISO 8601' }).optional().nullable(),
  duration_ms: z.number().nonnegative().optional().nullable(),
  parent_span_id: z.string().uuid().optional().nullable(),
  client_span_id: z.string().min(1).optional().nullable(),
  parent_client_span_id: z.string().min(1).optional().nullable(),
  model: z.string().optional().nullable(),
  input: z.unknown().optional().nullable(),
  output: z.unknown().optional().nullable(),
  error_message: z.string().optional().nullable(),
  input_tokens: z.number().int().nonnegative().optional().nullable(),
  output_tokens: z.number().int().nonnegative().optional().nullable(),
  cost_usd: z.number().nonnegative().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})

// ---------------------------------------------------------------------------
// Ingest payload schema
// ---------------------------------------------------------------------------

export const IngestPayloadSchema = z.object({
  session_id: z.string().min(1).optional(),
  session_name: z.string().min(1).max(200).optional(),
  spans: z
    .array(SpanSchema)
    .min(1, 'spans array must contain at least one span')
    .max(500, 'Maximum 500 spans per request'),
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
  details: Array<{ path: string; message: string }>
} {
  const result = IngestPayloadSchema.safeParse(data)

  if (result.success) {
    return { success: true, data: result.data }
  }

  const details = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join('; ')}`,
    details,
  }
}
