/**
 * @agentdecode/sdk — AI Agent Observability SDK
 *
 * Trace LLM calls, tool executions, and agent workflows
 * with a single line of code.
 *
 * @example
 * ```ts
 * import { AgentDecode } from '@agentdecode/sdk'
 *
 * const lens = new AgentDecode({
 *   apiKey: 'al_sk_...',
 *   projectId: 'your-project-id',
 *   endpoint: 'https://your-app.vercel.app/api/ingest',
 * })
 *
 * // Wrap any async function for automatic tracing
 * const classify = lens.trace('classify_intent', { type: 'llm', model: 'gpt-4o' },
 *   async (input: string) => {
 *     const result = await openai.chat.completions.create({ ... })
 *     return result
 *   }
 * )
 *
 * // Or use sessions for multi-step workflows
 * const session = lens.session('Customer Support Agent')
 * const span = session.startSpan('lookup_customer', { type: 'tool' })
 * // ... do work ...
 * span.end({ output: { name: 'Alex' } })
 * await session.end()
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────

export type SpanType = 'llm' | 'tool' | 'chain' | 'retrieval' | 'agent'
export type SpanStatus = 'ok' | 'error'

export interface AgentDecodeConfig {
  /** Your AgentDecode API key (starts with al_sk_) */
  apiKey: string
  /** The AgentDecode ingest endpoint URL */
  endpoint: string
  /** Enable debug logging to console */
  debug?: boolean
  /** Custom headers to include with every request */
  headers?: Record<string, string>
  /** Timeout in milliseconds for the ingest request (default: 10000) */
  timeout?: number
  /** Disable sending traces (useful for testing) */
  disabled?: boolean
}

export interface SpanOptions {
  /** The type of span */
  type?: SpanType
  /** The model used (for LLM spans) */
  model?: string
  /** Additional metadata to attach */
  metadata?: Record<string, unknown>
}

export interface SpanData {
  name: string
  span_type: SpanType
  status: SpanStatus
  started_at: string
  ended_at?: string
  duration_ms?: number
  model?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  error_message?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  metadata?: Record<string, unknown>
  parent_span_id?: string
}

export interface SessionOptions {
  /** External session ID for linking to your own systems */
  sessionId?: string
  /** Human-readable session name */
  name?: string
}

export interface EndSpanOptions {
  output?: Record<string, unknown>
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  status?: SpanStatus
  error_message?: string
}

// ─── Span Handle ─────────────────────────────────────────────────

export class SpanHandle {
  private _data: SpanData
  private _children: SpanData[] = []
  private _startTime: number

  /** @internal */
  constructor(name: string, options: SpanOptions = {}) {
    this._startTime = Date.now()
    this._data = {
      name,
      span_type: options.type || 'chain',
      status: 'ok',
      started_at: new Date(this._startTime).toISOString(),
      model: options.model,
      metadata: options.metadata || {},
    }
  }

  /** Set the input data for this span */
  setInput(input: Record<string, unknown>): this {
    this._data.input = input
    return this
  }

  /** Set the output data for this span */
  setOutput(output: Record<string, unknown>): this {
    this._data.output = output
    return this
  }

  /** Set the model used (for LLM spans) */
  setModel(model: string): this {
    this._data.model = model
    return this
  }

  /** Set token usage */
  setTokens(input_tokens: number, output_tokens: number): this {
    this._data.input_tokens = input_tokens
    this._data.output_tokens = output_tokens
    return this
  }

  /** Set the cost in USD */
  setCost(cost_usd: number): this {
    this._data.cost_usd = cost_usd
    return this
  }

  /** Add custom metadata */
  setMetadata(key: string, value: unknown): this {
    if (!this._data.metadata) this._data.metadata = {}
    this._data.metadata[key] = value
    return this
  }

  /** Mark this span as an error */
  setError(message: string): this {
    this._data.status = 'error'
    this._data.error_message = message
    return this
  }

  /** Start a child span */
  startSpan(name: string, options: SpanOptions = {}): SpanHandle {
    const child = new SpanHandle(name, options)
    this._children.push(child._data)
    return child
  }

  /** End this span and finalize timing */
  end(options: EndSpanOptions = {}): SpanData {
    const endTime = Date.now()
    this._data.ended_at = new Date(endTime).toISOString()
    this._data.duration_ms = endTime - this._startTime

    if (options.output) this._data.output = options.output
    if (options.input_tokens) this._data.input_tokens = options.input_tokens
    if (options.output_tokens) this._data.output_tokens = options.output_tokens
    if (options.cost_usd) this._data.cost_usd = options.cost_usd
    if (options.status) this._data.status = options.status
    if (options.error_message) {
      this._data.status = 'error'
      this._data.error_message = options.error_message
    }

    return this._data
  }

  /** @internal */
  getData(): SpanData {
    return this._data
  }

  /** @internal */
  getChildren(): SpanData[] {
    return this._children
  }
}

// ─── Session ─────────────────────────────────────────────────────

export class Session {
  private _lens: AgentDecode
  private _name: string
  private _sessionId?: string
  private _spans: SpanData[] = []
  private _debug: boolean

  /** @internal */
  constructor(lens: AgentDecode, options: SessionOptions = {}) {
    this._lens = lens
    this._name = options.name || 'Unnamed Session'
    this._sessionId = options.sessionId
    this._debug = lens['_config'].debug || false
  }

  /** Start a new top-level span in this session */
  startSpan(name: string, options: SpanOptions = {}): SpanHandle {
    return new SpanHandle(name, options)
  }

  /** Record a completed span */
  addSpan(span: SpanHandle): void {
    this._spans.push(span.getData())
  }

  /**
   * Wrap an async function in a traced span.
   * The function receives the span handle for adding metadata.
   */
  trace<TArgs extends unknown[], TReturn>(
    name: string,
    options: SpanOptions,
    fn: (span: SpanHandle, ...args: TArgs) => Promise<TReturn>,
  ): (...args: TArgs) => Promise<TReturn> {
    const session = this

    return async (...args: TArgs): Promise<TReturn> => {
      const span = new SpanHandle(name, options)
      span.setInput({ args: args.length === 1 ? args[0] : args } as Record<string, unknown>)

      try {
        const result = await fn(span, ...args)

        // Auto-extract output if it's an object
        if (result && typeof result === 'object') {
          span.setOutput(result as Record<string, unknown>)
        } else if (result !== undefined) {
          span.setOutput({ result } as Record<string, unknown>)
        }

        span.end()
        session._spans.push(span.getData())
        return result
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        span.end({ error_message: message })
        session._spans.push(span.getData())
        throw error
      }
    }
  }

  /**
   * End the session and flush all spans to AgentDecode.
   * Call this when your agent workflow is complete.
   */
  async end(): Promise<{ session_id: string; span_ids: string[] }> {
    if (this._spans.length === 0) {
      if (this._debug) console.log('[AgentDecode] No spans to flush')
      return { session_id: '', span_ids: [] }
    }

    return this._lens['_flush']({
      session_id: this._sessionId,
      session_name: this._name,
      spans: this._spans,
    })
  }
}

// ─── Main Client ─────────────────────────────────────────────────

export class AgentDecode {
  private _config: Required<Pick<AgentDecodeConfig, 'apiKey' | 'endpoint'>> & AgentDecodeConfig

  constructor(config: AgentDecodeConfig) {
    if (!config.apiKey) throw new Error('[AgentDecode] apiKey is required')
    if (!config.endpoint) throw new Error('[AgentDecode] endpoint is required')

    this._config = {
      ...config,
      timeout: config.timeout ?? 10000,
      debug: config.debug ?? false,
      disabled: config.disabled ?? false,
    }

    if (this._config.debug) {
      console.log('[AgentDecode] Initialized', {
        endpoint: this._config.endpoint,
        debug: true,
      })
    }
  }

  /**
   * Create a new tracing session.
   *
   * @example
   * ```ts
   * const session = lens.session({ name: 'Customer Support Agent' })
   * // ... add spans ...
   * await session.end()
   * ```
   */
  session(options: SessionOptions | string = {}): Session {
    if (typeof options === 'string') {
      return new Session(this, { name: options })
    }
    return new Session(this, options)
  }

  /**
   * Wrap an async function for automatic tracing.
   * Creates a session, traces the function, and flushes automatically.
   *
   * @example
   * ```ts
   * const classify = lens.trace('classify_intent', { type: 'llm', model: 'gpt-4o' },
   *   async (input: string) => {
   *     return await openai.chat.completions.create({ ... })
   *   }
   * )
   *
   * const result = await classify('Cancel my subscription')
   * ```
   */
  trace<TArgs extends unknown[], TReturn>(
    name: string,
    options: SpanOptions,
    fn: (...args: TArgs) => Promise<TReturn>,
  ): (...args: TArgs) => Promise<TReturn> {
    const lens = this

    return async (...args: TArgs): Promise<TReturn> => {
      if (lens._config.disabled) return fn(...args)

      const span = new SpanHandle(name, options)
      span.setInput({ args: args.length === 1 ? args[0] : args } as Record<string, unknown>)

      try {
        const result = await fn(...args)

        if (result && typeof result === 'object') {
          span.setOutput(result as Record<string, unknown>)
        } else if (result !== undefined) {
          span.setOutput({ result } as Record<string, unknown>)
        }

        span.end()

        // Fire-and-forget flush
        lens._flush({
          session_name: name,
          spans: [span.getData()],
        }).catch((err) => {
          if (lens._config.debug) console.error('[AgentDecode] Flush failed:', err)
        })

        return result
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        span.end({ error_message: message })

        lens._flush({
          session_name: name,
          spans: [span.getData()],
        }).catch((err) => {
          if (lens._config.debug) console.error('[AgentDecode] Flush failed:', err)
        })

        throw error
      }
    }
  }

  /** @internal Send spans to the AgentDecode ingest API */
  private async _flush(payload: {
    session_id?: string
    session_name?: string
    spans: SpanData[]
  }): Promise<{ session_id: string; span_ids: string[] }> {
    if (this._config.disabled) {
      return { session_id: '', span_ids: [] }
    }

    if (this._config.debug) {
      console.log(`[AgentDecode] Flushing ${payload.spans.length} span(s)`, {
        session: payload.session_name,
      })
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this._config.timeout || 10000)

    try {
      const response = await fetch(this._config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._config.apiKey}`,
          ...this._config.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`AgentDecode ingest failed (${response.status}): ${body}`)
      }

      const data = await response.json()

      if (this._config.debug) {
        console.log('[AgentDecode] Flushed successfully', {
          session_id: data.session_id,
          spans: data.span_ids?.length || 0,
        })
      }

      return data
    } catch (error: unknown) {
      clearTimeout(timeoutId)
      if (this._config.debug) {
        console.error('[AgentDecode] Flush error:', error)
      }
      throw error
    }
  }
}

// ─── Default export ──────────────────────────────────────────────

export default AgentDecode
