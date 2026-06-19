import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export async function scoreSpanWithGroq(spanId: string, input: any, output: any): Promise<void> {
  try {
    const groqApiKey = process.env.GROQ_API_KEY
    if (!groqApiKey) return

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
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) return

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return

    // Robust JSON parsing with full fallback
    let score: number
    let reasoning: string
    let flagged: boolean

    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned)

      score = typeof parsed.score === 'number' ? Math.min(10, Math.max(0, parsed.score)) : 5.0
      reasoning = (
        typeof parsed.reason === 'string' ? parsed.reason :
        typeof parsed.reasoning === 'string' ? parsed.reasoning :
        'No reasoning provided'
      ).slice(0, 500)
      flagged = typeof parsed.flagged === 'boolean' ? parsed.flagged : score < 6.0
    } catch {
      // Fallback on parse error — neutral score, don't crash
      score = 5.0
      reasoning = 'Parse error'
      flagged = false
    }

    const supabase = createServiceClient()
    await supabase.from('eval_scores').upsert({
      span_id: spanId,
      score,
      flagged,
      reasoning,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    // Silently fail — never crash ingest
    logger.error('Eval scoring failed with Groq', err as Error)
  }
}
