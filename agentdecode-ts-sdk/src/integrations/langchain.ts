/**
 * LangChain callback handler for AgentDecode.
 *
 * Captures LLM, tool, and chain events as spans in an AgentDecode session.
 *
 * @example
 * ```ts
 * import { AgentDecode } from '@agentdecode/sdk'
 * import { AgentDecodeCallbackHandler } from '@agentdecode/sdk/integrations/langchain'
 *
 * const agent = new AgentDecode({ apiKey: 'al_...' })
 * const handler = new AgentDecodeCallbackHandler(agent, 'my_chain')
 *
 * const result = await chain.invoke(input, {
 *   callbacks: [handler],
 * })
 *
 * await handler.flush() // send all collected spans
 * ```
 *
 * @module
 */

import type { AgentDecode } from '../client.js'
import type { Session } from '../session.js'
import { Span } from '../span.js'
import type { SpanData } from '../span.js'

/**
 * LangChain callback handler that sends trace data to AgentDecode.
 *
 * Implements the LangChain `BaseCallbackHandler` interface by duck-typing.
 * This avoids requiring `@langchain/core` as a hard dependency.
 */
export class AgentDecodeCallbackHandler {
  name = 'AgentDecodeCallbackHandler'

  private _agent: AgentDecode
  private _sessionName: string
  private _session: Session | null = null
  private _spans: Map<string, Span> = new Map()
  private _collectedSpans: SpanData[] = []
  /** @internal Injectable fetch for testing. */
  _fetchFn?: typeof fetch

  constructor(agent: AgentDecode, sessionName: string = 'langchain_run') {
    this._agent = agent
    this._sessionName = sessionName
  }

  // ── LLM ──────────────────────────────────────────────────────────

  handleLLMStart(
    serialized: { name?: string } | undefined,
    prompts: string[],
    runId: string,
  ): void {
    const modelName = serialized?.name ?? 'unknown'
    const span = new Span(`llm.${modelName}`, 'llm')
    span.model = modelName
    span.input = {
      prompts: prompts.slice(-3).map((p) => p.slice(0, 200)),
    }
    this._spans.set(runId, span)
  }

  handleLLMEnd(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output: any,
    runId: string,
  ): void {
    const span = this._spans.get(runId)
    if (!span) return

    // Extract output text
    const generations = output?.generations
    if (generations?.[0]?.[0]) {
      const gen = generations[0][0]
      span.output = { text: String(gen.text ?? gen.message?.content ?? '').slice(0, 500) }
    }

    // Extract token usage
    const tokenUsage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.token_usage
    if (tokenUsage) {
      if (tokenUsage.promptTokens != null || tokenUsage.prompt_tokens != null) {
        span.inputTokens = tokenUsage.promptTokens ?? tokenUsage.prompt_tokens
      }
      if (tokenUsage.completionTokens != null || tokenUsage.completion_tokens != null) {
        span.outputTokens = tokenUsage.completionTokens ?? tokenUsage.completion_tokens
      }
    }

    this._collectedSpans.push(span.finish())
    this._spans.delete(runId)
  }

  handleLLMError(error: Error, runId: string): void {
    const span = this._spans.get(runId)
    if (!span) return
    span.errorMessage = error.message
    this._collectedSpans.push(span.finish(error))
    this._spans.delete(runId)
  }

  // ── Tool ─────────────────────────────────────────────────────────

  handleToolStart(
    serialized: { name?: string } | undefined,
    input: string,
    runId: string,
  ): void {
    const toolName = serialized?.name ?? 'unknown'
    const span = new Span(`tool.${toolName}`, 'tool')
    span.input = { input: input.slice(0, 500) }
    this._spans.set(runId, span)
  }

  handleToolEnd(output: string, runId: string): void {
    const span = this._spans.get(runId)
    if (!span) return
    span.output = { output: String(output).slice(0, 500) }
    this._collectedSpans.push(span.finish())
    this._spans.delete(runId)
  }

  handleToolError(error: Error, runId: string): void {
    const span = this._spans.get(runId)
    if (!span) return
    span.errorMessage = error.message
    this._collectedSpans.push(span.finish(error))
    this._spans.delete(runId)
  }

  // ── Chain ────────────────────────────────────────────────────────

  handleChainStart(
    serialized: { name?: string } | undefined,
    inputs: Record<string, unknown>,
    runId: string,
  ): void {
    const chainName = serialized?.name ?? 'chain'
    const span = new Span(`chain.${chainName}`, 'chain')
    try {
      span.input = Object.fromEntries(
        Object.entries(inputs)
          .slice(0, 5)
          .map(([k, v]) => [k, String(v).slice(0, 200)]),
      )
    } catch {
      span.input = { raw: String(inputs).slice(0, 500) }
    }
    this._spans.set(runId, span)
  }

  handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
  ): void {
    const span = this._spans.get(runId)
    if (!span) return
    try {
      span.output = Object.fromEntries(
        Object.entries(outputs)
          .slice(0, 5)
          .map(([k, v]) => [k, String(v).slice(0, 200)]),
      )
    } catch {
      span.output = { raw: String(outputs).slice(0, 500) }
    }
    this._collectedSpans.push(span.finish())
    this._spans.delete(runId)
  }

  handleChainError(error: Error, runId: string): void {
    const span = this._spans.get(runId)
    if (!span) return
    span.errorMessage = error.message
    this._collectedSpans.push(span.finish(error))
    this._spans.delete(runId)
  }

  // ── Flush ────────────────────────────────────────────────────────

  /**
   * Send all collected spans to AgentDecode.
   * Call this after your chain/agent finishes.
   */
  async flush(): Promise<void> {
    if (this._collectedSpans.length === 0) return

    const payload = {
      session_name: this._sessionName,
      spans: this._collectedSpans,
    }

    const fetchImpl = this._fetchFn ?? globalThis.fetch

    try {
      await fetchImpl(`${this._agent.endpoint}/api/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this._agent.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'agentdecode-ts/0.1.0',
        },
        body: JSON.stringify(payload),
      })
    } catch (error) {
      console.error('[agentdecode] Failed to flush LangChain spans:', error)
    }

    this._collectedSpans = []
  }
}
