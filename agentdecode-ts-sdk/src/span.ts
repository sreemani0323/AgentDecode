export type SpanType =
  | 'llm'
  | 'tool'
  | 'chain'
  | 'retrieval'
  | 'agent'
  | 'embedding'
  | 'rerank'
  | 'guardrail'
  | 'other'

export type SpanStatus = 'ok' | 'error'

/** Wire-format span data matching the server's Zod SpanSchema. */
export interface SpanData {
  name: string
  span_type: SpanType
  status: SpanStatus
  started_at: string
  ended_at?: string
  duration_ms?: number
  model?: string
  input?: unknown
  output?: unknown
  error_message?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  metadata?: Record<string, unknown>
  client_span_id: string
  parent_client_span_id?: string
}

/**
 * A single traced operation.
 *
 * Create via `session.span()`, set properties on the span object,
 * then call `finish()` (or let `SpanContext.run()` handle it).
 */
export class Span {
  private _data: Partial<SpanData>
  private _startTime: number
  readonly clientSpanId: string

  // Public settable properties
  input?: unknown
  output?: unknown
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  metadata?: Record<string, unknown>
  errorMessage?: string

  constructor(
    name: string,
    spanType: SpanType,
    parentClientSpanId?: string,
  ) {
    this.clientSpanId = randomId()
    this._startTime = Date.now()
    this._data = {
      name,
      span_type: spanType,
      status: 'ok',
      started_at: new Date().toISOString(),
      client_span_id: this.clientSpanId,
      parent_client_span_id: parentClientSpanId,
    }
  }

  /** Finalise the span and return the wire-format data. */
  finish(error?: Error): SpanData {
    const endTime = Date.now()
    const status: SpanStatus =
      error || this.errorMessage ? 'error' : 'ok'

    return {
      name: this._data.name!,
      span_type: this._data.span_type!,
      status,
      started_at: this._data.started_at!,
      ended_at: new Date().toISOString(),
      duration_ms: endTime - this._startTime,
      model: this.model,
      input: this.input,
      output: this.output,
      error_message: error ? error.message : this.errorMessage,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cost_usd: this.costUsd,
      metadata: this.metadata,
      client_span_id: this.clientSpanId,
      parent_client_span_id: this._data.parent_client_span_id,
    }
  }
}

/** Generate a 16-char hex ID (no crypto import needed on Node 18+). */
function randomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  }
  // Fallback for older runtimes
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('')
}
