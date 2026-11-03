import { Session, SessionOptions } from './session.js'
import { SpanType } from './span.js'
import { createWalStorage, IWalStorage } from './wal/index.js'

export interface AgentDecodeOptions {
  /** Your API key (starts with `al_`). */
  apiKey: string
  /** Your AgentDecode server URL. Defaults to `https://agent-decode.vercel.app`. */
  endpoint?: string
  /** HTTP timeout per request in seconds. Default: 10. */
  timeout?: number
  /** Number of retry attempts on failure. Default: 3. */
  maxRetries?: number
  /** Directory for persistent WAL on Node.js. Defaults to `~/.agentdecode/wal`. */
  walDir?: string
  /** Maximum number of pending batches to retain in WAL. Default: 10000. */
  maxWalEntries?: number
  /** Maximum number of dead-letter batches to retain in WAL. Default: 2000. */
  maxDeadLetterEntries?: number
  /** If true, disable persistent disk/IDB storage and use in-memory queue. */
  disableWal?: boolean
  /** Optional custom WAL storage engine. */
  walStorage?: IWalStorage
}

/**
 * Top-level AgentDecode client. Create one per project.
 *
 * ```ts
 * const agent = new AgentDecode({
 *   apiKey: 'al_your_key',
 *   endpoint: 'https://agent-decode.vercel.app',
 * })
 *
 * await agent.session('My Agent Run').run(async (session) => {
 *   await session.span('llm_call', 'llm').run(async (span) => {
 *     span.model = 'gpt-4o'
 *     span.input = { prompt: 'Hello' }
 *     const result = await callLlm(...)
 *     span.output = result
 *   })
 * })
 * ```
 */
export class AgentDecode {
  readonly apiKey: string
  readonly endpoint: string
  readonly timeout: number
  readonly maxRetries: number
  readonly wal: IWalStorage

  constructor(options: AgentDecodeOptions) {
    if (!options.apiKey) throw new Error('apiKey is required')
    const endpoint =
      options.endpoint ?? 'https://agent-decode.vercel.app'
    if (!endpoint) throw new Error('endpoint is required')

    this.apiKey = options.apiKey
    this.endpoint = endpoint.replace(/\/$/, '')
    this.timeout = options.timeout ?? 10
    this.maxRetries = options.maxRetries ?? 3

    this.wal =
      options.walStorage ??
      createWalStorage({
        storageDir: options.walDir,
        maxEntries: options.maxWalEntries,
        maxDeadLetterEntries: options.maxDeadLetterEntries,
        disabled: options.disableWal,
      })

    // Recover pending spans left in-flight from previous crashes/restarts
    this.wal.recover().catch((err) => {
      console.warn('[agentdecode] WAL recovery warning:', err)
    })
  }

  /**
   * Create a trace session. Returns a `SessionRunner` whose
   * `.run()` method handles flushing automatically.
   */
  session(name: string, sessionId?: string): SessionRunner {
    const opts: SessionOptions = {
      sessionName: name,
      sessionId,
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      wal: this.wal,
    }
    return new SessionRunner(new Session(opts))
  }

  /**
   * Convenience: wraps a function in a single-span session.
   * The return value becomes `span.output`.
   */
  async trace<T>(
    name: string,
    spanType: SpanType = 'agent',
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const runner = this.session(name)
    return runner.run(async (session) => {
      return session.span(name, spanType).run(async (span) => {
        const result = await fn()
        span.output = result
        return result
      })
    })
  }

  /**
   * Flush pending WAL batches to the ingest endpoint.
   *
   * Telemetry Retry Model:
   * Sessions attempt immediate transmission upon completion with exponential backoff and jitter.
   * If delivery fails due to transient network or server errors (e.g. HTTP 429, 503, connection loss),
   * batches remain safely committed to the persistent WAL. Calling `agent.flush()` drains and retries
   * all pending batches with at-least-once delivery guarantees. Recovered batches from previous crashes
   * or restarts are automatically restored to 'pending' upon SDK initialization.
   *
   * @param sendFn Optional custom sender function (e.g. for testing).
   * @returns Number of successfully acknowledged batches.
   */
  async flush(
    sendFn?: (payload: unknown) => Promise<unknown>,
  ): Promise<number> {
    const pending = await this.wal.getPending()
    if (pending.length === 0) return 0

    await this.wal.markSending(pending.map((p) => p.id))
    let acked = 0

    for (const batch of pending) {
      try {
        if (sendFn) {
          await sendFn(batch.payload)
        } else {
          await this._sendPayload(batch.payload)
        }
        await this.wal.acknowledge(batch.id)
        acked++
      } catch (err: any) {
        const isClientErr =
          err?.isClientError ||
          (err?.status >= 400 && err?.status < 500 && err?.status !== 429) ||
          (typeof err?.message === 'string' &&
            err.message.includes('AgentDecode API error 4') &&
            !err.message.includes('429'))

        if (isClientErr) {
          await this.wal.recordPermanentFailure(
            batch.id,
            err.message || String(err),
          )
        } else {
          await this.wal.recordRetry(batch.id, err.message || String(err))
        }
      }
    }
    return acked
  }

  private async _sendPayload(payload: unknown): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.timeout * 1000,
    )

    try {
      const response = await fetch(`${this.endpoint}/api/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'agentdecode-ts/0.1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text()
        const isClient =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        const err = new Error(
          isClient
            ? `AgentDecode API error ${response.status}: ${body}`
            : `HTTP ${response.status}: ${body}`,
        )
        ;(err as any).status = response.status
        ;(err as any).isClientError = isClient
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Wraps a Session with automatic flush-on-completion.
 *
 * ```ts
 * await agent.session('My Run').run(async (session) => {
 *   // create spans here
 * })
 * // ^ flush is called automatically
 * ```
 */
export class SessionRunner {
  /** @internal */
  _session: Session

  constructor(session: Session) {
    this._session = session
  }

  async run<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    let ranFlush = false
    try {
      const result = await fn(this._session)
      ranFlush = true
      await this._session.flush()
      return result
    } catch (error) {
      if (!ranFlush) {
        // Only flush if user code threw before flush was called
        await this._session.flush().catch(() => {})
      }
      throw error
    }
  }
}
