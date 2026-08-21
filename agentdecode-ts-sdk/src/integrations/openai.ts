/**
 * OpenAI auto-instrumentation for AgentDecode.
 *
 * Patches the OpenAI client's `chat.completions.create()` method to
 * automatically produce spans inside an active session.
 *
 * @example
 * ```ts
 * import { AgentDecode } from '@agentdecode/sdk'
 * import { instrumentOpenAI } from '@agentdecode/sdk/integrations/openai'
 *
 * const agent = new AgentDecode({ apiKey: 'al_...' })
 * const openai = new OpenAI()
 * const cleanup = instrumentOpenAI(agent, openai)
 *
 * await agent.session('my_run').run(async (session) => {
 *   // This call is automatically traced
 *   const res = await openai.chat.completions.create({
 *     model: 'gpt-4o',
 *     messages: [{ role: 'user', content: 'Hello' }],
 *   })
 * })
 *
 * cleanup() // restore original
 * ```
 *
 * @module
 */

import type { AgentDecode } from '../client.js'
import { Span } from '../span.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

/**
 * Instrument an OpenAI client instance to auto-trace chat completion calls.
 *
 * @param agent - AgentDecode client instance
 * @param client - OpenAI client instance (`new OpenAI()`)
 * @returns A cleanup function that restores the original method.
 */
export function instrumentOpenAI(
  agent: AgentDecode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): () => void {
  if (!client?.chat?.completions?.create) {
    throw new Error(
      'Invalid OpenAI client. Expected an instance of OpenAI ' +
        'with client.chat.completions.create(). ' +
        'Install openai with: npm install openai',
    )
  }

  const completions = client.chat.completions
  const originalCreate: AnyFn = completions.create.bind(completions)

  completions.create = async function tracedCreate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) {
    // args[0] is the params object
    const params = args[0] ?? {}
    const model: string = params.model ?? 'unknown'
    const messages: Array<{ role?: string; content?: string }> =
      params.messages ?? []
    const isStreaming = params.stream === true

    // If we're not inside a session.span().run(), just call through
    // We use a special property on the agent to track the active session
    // For now, always trace and let the user decide scope
    const spanName = `openai.chat.${model}`
    const span = new Span(spanName, 'llm')
    span.model = model
    span.input = {
      messages: messages.slice(-3).map((m) => ({
        role: m.role ?? 'unknown',
        content: String(m.content ?? '').slice(0, 200),
      })),
    }

    if (isStreaming) {
      span.metadata = { streaming: true }
    }

    try {
      const response = await originalCreate(...args)

      if (!isStreaming) {
        // Extract output from non-streaming response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const choices = (response as any)?.choices
        if (choices?.[0]?.message?.content) {
          span.output = {
            content: String(choices[0].message.content).slice(0, 500),
          }
        }

        // Extract token usage
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usage = (response as any)?.usage
        if (usage) {
          if (usage.prompt_tokens != null) {
            span.inputTokens = usage.prompt_tokens
          }
          if (usage.completion_tokens != null) {
            span.outputTokens = usage.completion_tokens
          }

          // Rough cost estimation
          const total = usage.total_tokens ?? 0
          if (model.includes('gpt-4o') && !model.includes('mini')) {
            span.costUsd = total * 0.000005
          } else if (model.includes('gpt-4o-mini')) {
            span.costUsd = total * 0.0000002
          }
        }
      } else {
        span.output = { note: 'streaming response' }
      }

      return response
    } catch (error) {
      span.errorMessage =
        error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  // Return cleanup function
  return () => {
    completions.create = originalCreate
  }
}
