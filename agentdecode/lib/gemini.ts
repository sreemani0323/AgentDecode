import type { Span } from '@/types'
import { logger } from '@/lib/logger'

export async function explainSpanFailure(
  span: Span
): Promise<{ diagnosis: string; suggested_fix: string }> {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey) {
    return {
      diagnosis: 'GEMINI_API_KEY is not configured. Cannot analyze this failure automatically.',
      suggested_fix: 'Add GEMINI_API_KEY to your .env.local file to enable AI explanations.',
    }
  }

  const prompt = `You are an expert AI engineer debugging a production AI agent failure.

Span name: ${span.name}
Span type: ${span.span_type}
Input: ${JSON.stringify(span.input)}
Output: ${JSON.stringify(span.output)}
Error: ${span.error_message}
Model used: ${span.model}

Respond in JSON only:
{
  "diagnosis": "2-3 sentences explaining what went wrong",
  "suggested_fix": "1-2 sentences on what to fix"
}`

  logger.debug('Sending span to Gemini for analysis', { span_id: span.id })

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`

    // 10s AbortController timeout
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const errorText = await res.text()
      logger.error('Gemini API error response', { errorText })
      throw new Error(`Gemini API returned ${res.status}`)
    }

    const data = await res.json()
    logger.debug('Gemini API response received', { data })

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      throw new Error('No text in Gemini response')
    }

    // Strip markdown code fences if present
    text = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim()

    // Robust JSON parsing with validation
    let diagnosis: string
    let suggested_fix: string

    try {
      const parsed = JSON.parse(text)
      diagnosis = typeof parsed.diagnosis === 'string' && parsed.diagnosis.length > 0
        ? parsed.diagnosis
        : 'Could not determine root cause.'
      suggested_fix = typeof parsed.suggested_fix === 'string' && parsed.suggested_fix.length > 0
        ? parsed.suggested_fix
        : 'Review the span input and output manually.'
    } catch {
      // JSON parse failed — use fallback
      diagnosis = 'Analysis unavailable'
      suggested_fix = 'Check the error message above'
    }

    return { diagnosis, suggested_fix }
  } catch (err) {
    logger.error('Error caught in Gemini analysis', err as Error)
    return {
      diagnosis: 'Analysis unavailable',
      suggested_fix: 'Check the error message above',
    }
  }
}
