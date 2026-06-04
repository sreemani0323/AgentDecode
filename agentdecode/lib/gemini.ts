import type { Span } from '@/types'

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

  console.log('1. Sending span to Gemini:', JSON.stringify(span, null, 2))

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    })

    if (!res.ok) {
      const errorText = await res.text()
      console.error('Gemini API error:', errorText)
      throw new Error(`Gemini API returned ${res.status}`)
    }

    const data = await res.json()
    console.log('2. Raw Gemini API response:', JSON.stringify(data, null, 2))

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      throw new Error('No text in Gemini response')
    }

    // Strip markdown code fences if present
    text = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim()

    const parsed = JSON.parse(text)

    return {
      diagnosis: parsed.diagnosis || 'Could not determine root cause.',
      suggested_fix: parsed.suggested_fix || 'Review the span input and output manually.',
    }
  } catch (err) {
    console.error('3. Error caught in Gemini analysis:', err)
    return {
      diagnosis: 'Could not analyze this failure automatically.',
      suggested_fix: 'Check the input/output above for clues.',
    }
  }
}
