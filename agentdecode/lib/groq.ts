import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export interface QualityEvalResult {
  score: number
  reasoning: string
  flagged: boolean
  provenance: string
}

export class GroqTransientError extends Error {
  readonly status?: number
  readonly isTransient = true

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GroqTransientError'
    this.status = status
  }
}

export class GroqAuthenticationError extends Error {
  readonly status: number
  readonly isTransient = false

  constructor(message: string, status: number = 401) {
    super(message)
    this.name = 'GroqAuthenticationError'
    this.status = status
  }
}

export class GroqMalformedResponseError extends Error {
  readonly isTransient = false

  constructor(message: string) {
    super(message)
    this.name = 'GroqMalformedResponseError'
  }
}

/**
 * Evaluates LLM completion quality using Groq (llama-3.3-70b-versatile).
 * Distinguishes missing configuration, authentication errors, transient provider
 * failures (429, 5xx, timeouts), and malformed responses.
 */
export async function evaluateQualityWithGroq(
  input: unknown,
  output: unknown
): Promise<QualityEvalResult | null> {
  const groqApiKey = process.env.GROQ_API_KEY
  if (!groqApiKey) return null

  const prompt = `Rate this LLM response quality from 0 to 10.
10 = accurate, relevant, helpful, complete
0 = hallucinated, off-topic, empty, broken, or harmful

Input to LLM: ${JSON.stringify(input).slice(0, 500)}
Output from LLM: ${JSON.stringify(output).slice(0, 500)}

Respond with JSON only, no markdown:
{"score": 7.5, "flagged": false, "reason": "Response is accurate and helpful"}`

  // 10s AbortController timeout
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  let response: Response
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are an LLM output quality evaluator. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    })
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
      throw new GroqTransientError('Groq API request timed out after 10s')
    }
    throw new GroqTransientError(`Groq API network failure: ${err?.message || String(err)}`)
  } finally {
    clearTimeout(timeout)
  }

  // 1. Distinguish authentication failures (invalid credentials)
  if (response.status === 401 || response.status === 403) {
    throw new GroqAuthenticationError(`Invalid Groq API credentials (HTTP ${response.status})`, response.status)
  }

  // 2. Distinguish rate limiting (transient)
  if (response.status === 429) {
    throw new GroqTransientError('Groq API rate limit exceeded (HTTP 429)', 429)
  }

  // 3. Distinguish server errors (transient)
  if (response.status >= 500) {
    throw new GroqTransientError(`Groq API server error (HTTP ${response.status})`, response.status)
  }

  // 4. Other unexpected HTTP errors
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Groq API error HTTP ${response.status}: ${errorBody}`)
  }

  const data = await response.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new GroqTransientError('Empty response content received from Groq API')
  }

  // 5. Response JSON parsing
  try {
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const score = typeof parsed.score === 'number' ? Math.min(10, Math.max(0, parsed.score)) : 5.0
    const reasoning = (
      typeof parsed.reason === 'string' ? parsed.reason :
      typeof parsed.reasoning === 'string' ? parsed.reasoning :
      'No reasoning provided'
    ).slice(0, 500)
    const flagged = typeof parsed.flagged === 'boolean' ? parsed.flagged : score < 6.0

    return {
      score,
      reasoning,
      flagged,
      provenance: 'groq:llama-3.3-70b-versatile',
    }
  } catch {
    // Malformed response received
    if (process.env.ALLOW_HEURISTIC_ON_MALFORMED === 'true') {
      return {
        score: 5.0,
        reasoning: 'Malformed LLM response format; assigned neutral score',
        flagged: false,
        provenance: 'heuristic:malformed-llm-response',
      }
    }
    throw new GroqMalformedResponseError('Received malformed non-JSON response from Groq API')
  }
}

export async function scoreSpanWithGroq(spanId: string, input: any, output: any): Promise<void> {
  try {
    const result = await evaluateQualityWithGroq(input, output)
    if (!result) return

    const supabase = createServiceClient()
    await supabase.from('eval_scores').upsert({
      span_id: spanId,
      score: result.score,
      flagged: result.flagged,
      reasoning: `[${result.provenance}] ${result.reasoning}`,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    // Silently fail for legacy direct span hook — never crash ingestion
    logger.error('Eval scoring failed with Groq', err as Error)
  }
}
