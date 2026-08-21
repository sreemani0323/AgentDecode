import { Session, SessionOptions } from './session.js'
import { SpanType } from './span.js'

export interface AgentDecodeOptions {
  /** Your API key (starts with `al_`). */
  apiKey: string
  /** Your AgentDecode server URL. Defaults to `https://agent-decode.vercel.app`. */
  endpoint?: string
  /** HTTP timeout per request in seconds. Default: 10. */
  timeout?: number
  /** Number of retry attempts on failure. Default: 3. */
  maxRetries?: number
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

  constructor(options: AgentDecodeOptions) {
    if (!options.apiKey) throw new Error('apiKey is required')
    const endpoint =
      options.endpoint ?? 'https://agent-decode.vercel.app'
    if (!endpoint) throw new Error('endpoint is required')

    this.apiKey = options.apiKey
    this.endpoint = endpoint.replace(/\/$/, '')
    this.timeout = options.timeout ?? 10
    this.maxRetries = options.maxRetries ?? 3
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
    try {
      const result = await fn(this._session)
      await this._session.flush()
      return result
    } catch (error) {
      // Always try to flush, even on error
      await this._session.flush().catch(() => {})
      throw error
    }
  }
}
