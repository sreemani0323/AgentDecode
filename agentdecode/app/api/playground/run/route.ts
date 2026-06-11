import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/playground/run
 *
 * Executes a prompt against the Groq free tier.
 * Used by the Prompt Playground to let users tweak and re-run
 * LLM calls without leaving AgentDecode.
 *
 * Body: { messages: [{role, content}], model?: string, temperature?: number, max_tokens?: number }
 * Auth: requires logged-in user.
 * Cost: $0 (Groq free tier).
 */
export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(request, 'ai')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  // Auth check
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { messages, model, temperature, max_tokens } = body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'messages array is required' }, { status: 400 })
  }

  const groqApiKey = process.env.GROQ_API_KEY
  if (!groqApiKey) {
    return NextResponse.json({ error: 'GROQ_API_KEY not configured' }, { status: 500 })
  }

  const startTime = Date.now()

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
      }),
    })

    const durationMs = Date.now() - startTime

    if (!response.ok) {
      const errorData = await response.text()
      return NextResponse.json({
        error: `Groq API error (${response.status}): ${errorData}`,
        duration_ms: durationMs,
      }, { status: 502 })
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    const usage = data.usage || {}

    return NextResponse.json({
      content,
      model: data.model || model || 'llama-3.3-70b-versatile',
      usage: {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      },
      duration_ms: durationMs,
      finish_reason: data.choices?.[0]?.finish_reason || 'stop',
    })
  } catch (err: any) {
    const durationMs = Date.now() - startTime
    return NextResponse.json({
      error: err.message || 'Failed to call Groq API',
      duration_ms: durationMs,
    }, { status: 500 })
  }
}
