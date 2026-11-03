import { Span, SpanData, SpanType } from './span.js'
import { IWalStorage } from './wal/types.js'

export interface SessionOptions {
  sessionId?: string
  sessionName: string
  apiKey: string
  endpoint: string
  timeout: number
  maxRetries: number
  wal?: IWalStorage
}

/**
 * A group of related spans. Collects spans and sends them in one
 * batch to the AgentDecode ingest API on flush.
 */
export class Session {
  private _spans: SpanData[] = []
  private _options: SessionOptions
  private _currentSpan?: Span

  /** Injectable fetch for testing. If set, replaces globalThis.fetch. */
  _fetchFn?: typeof fetch

  constructor(options: SessionOptions) {
    this._options = options
  }

  /**
   * Create a child span. Returns a `SpanContext` whose `.run()`
   * method handles timing and error capture automatically.
   *
   * If called inside another `SpanContext.run()`, the new span
   * automatically nests under the active span.
   */
  span(name: string, spanType: SpanType = 'agent'): SpanContext {
    const parentId = this._currentSpan?.clientSpanId
    const span = new Span(name, spanType, parentId)
    return new SpanContext(span, this)
  }

  /** @internal Push finished span data. */
  _pushSpan(spanData: SpanData): void {
    this._spans.push(spanData)
  }

  /** @internal Set the current active span for auto-nesting. */
  _setCurrentSpan(span: Span | undefined): void {
    this._currentSpan = span
  }

  /** Send all collected spans to `/api/ingest`. */
  async flush(): Promise<void> {
    if (this._spans.length === 0) return

    const spansToSend = [...this._spans]
    this._spans = []

    const payload = {
      session_id: this._options.sessionId,
      session_name: this._options.sessionName,
      spans: spansToSend,
    }

    // Persist to WAL before attempting transmission
    let batchId: string | undefined
    if (this._options.wal) {
      batchId = await this._options.wal.enqueue(
        payload,
        this._options.sessionName,
        this._options.sessionId,
      )
    }

    try {
      await this._sendWithRetry(payload)
      // Confirmed server acceptance: acknowledge and delete from WAL
      if (batchId && this._options.wal) {
        await this._options.wal.acknowledge(batchId)
      }
    } catch (error: any) {
      if (batchId && this._options.wal) {
        if (this._isClientError(error)) {
          await this._options.wal.recordPermanentFailure(
            batchId,
            error.message || String(error),
          )
        } else {
          await this._options.wal.recordRetry(
            batchId,
            error.message || String(error),
          )
        }
      }
      throw error
    }
  }

  private _isClientError(error: unknown): boolean {
    if (error && typeof error === 'object') {
      if ((error as any).isClientError) return true
      if (typeof (error as any).status === 'number') {
        const s = (error as any).status
        return s >= 400 && s < 500 && s !== 429
      }
      if (
        typeof (error as any).message === 'string' &&
        (error as any).message.includes('AgentDecode API error 4') &&
        !(error as any).message.includes('429')
      ) {
        return true
      }
    }
    return false
  }

  private async _sendWithRetry(payload: unknown): Promise<void> {
    const fetchImpl = this._fetchFn ?? globalThis.fetch
    let lastError: Error | undefined

    for (let attempt = 0; attempt < this._options.maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(
          () => controller.abort(),
          this._options.timeout * 1000,
        )

        try {
          const response = await fetchImpl(
            `${this._options.endpoint}/api/ingest`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this._options.apiKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'agentdecode-ts/0.1.0',
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            },
          )

          if (!response.ok) {
            const body = await response.text()
            // Don't retry 4xx client errors (except 429)
            if (
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 429
            ) {
              const err = new Error(
                `AgentDecode API error ${response.status}: ${body}`,
              )
              ;(err as any).status = response.status
              ;(err as any).isClientError = true
              throw err
            }
            const err = new Error(`HTTP ${response.status}: ${body}`)
            ;(err as any).status = response.status
            throw err
          }

          return // success
        } finally {
          clearTimeout(timer)
        }
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error))
        // Don't retry on 4xx (the error message pattern)
        if (
          lastError.message.includes('AgentDecode API error 4') &&
          !lastError.message.includes('429')
        ) {
          throw lastError
        }
        if (attempt < this._options.maxRetries - 1) {
          const backoff = Math.min(
            10000,
            Math.pow(2, attempt) * 500 * (0.8 + 0.4 * Math.random()),
          )
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      }
    }

    throw lastError!
  }
}

/**
 * Wraps a `Span` with automatic start/finish and error capture.
 *
 * ```ts
 * await session.span('llm_call', 'llm').run(async (span) => {
 *   span.model = 'gpt-4o'
 *   span.input = { prompt: 'Hello' }
 *   const result = await callLlm(...)
 *   span.output = result
 *   return result
 * })
 * ```
 */
export class SpanContext {
  private _span: Span
  private _session: Session

  constructor(span: Span, session: Session) {
    this._span = span
    this._session = session
  }

  /** The underlying span object. */
  get span(): Span {
    return this._span
  }

  /**
   * Execute a function inside this span context.
   * The span is automatically finished (with error if thrown).
   */
  async run<T>(fn: (span: Span) => Promise<T> | T): Promise<T> {
    this._session._setCurrentSpan(this._span)
    try {
      const result = await fn(this._span)
      this._session._pushSpan(this._span.finish())
      return result
    } catch (error) {
      this._session._pushSpan(
        this._span.finish(
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      throw error
    } finally {
      this._session._setCurrentSpan(undefined)
    }
  }
}
