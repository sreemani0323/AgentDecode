import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { explainSpanFailure } from '@/lib/gemini'
import { checkRateLimit } from '@/lib/rate-limit'

const FALLBACK_RESPONSE = {
  diagnosis: 'Unable to analyze this failure automatically.',
  suggested_fix: 'Review the input/output above for clues, or check that GEMINI_API_KEY is configured.',
  fallback: true,
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = checkRateLimit(request, 'ai')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  try {
    const { id: spanId } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get span
    const { data: span, error: spanError } = await supabase
      .from('spans')
      .select('*')
      .eq('id', spanId)
      .single()

    if (spanError || !span) {
      return NextResponse.json({ error: 'Span not found' }, { status: 404 })
    }

    // Verify user has access via project → org_members
    const { data: project } = await supabase
      .from('projects')
      .select('id, org_id')
      .eq('id', span.project_id)
      .single()

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const { data: membership } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('org_id', project.org_id)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Check if explanation already exists
    const { data: existing } = await supabase
      .from('ai_explanations')
      .select('*')
      .eq('span_id', spanId)
      .single()

    if (existing) {
      return NextResponse.json({
        diagnosis: existing.diagnosis,
        suggested_fix: existing.suggested_fix,
      })
    }

    // Check for missing API key BEFORE calling the API
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({
        diagnosis: 'AI explanations require GEMINI_API_KEY. Get a free key at aistudio.google.com.',
        suggested_fix: 'Add GEMINI_API_KEY to your .env.local file, then restart the server.',
        fallback: true,
      })
    }

    // Call Gemini API — wrapped in its own try/catch for graceful degradation
    let result: { diagnosis: string; suggested_fix: string }
    try {
      result = await explainSpanFailure(span)
    } catch {
      // Gemini API failure, parse error, network timeout — return fallback
      return NextResponse.json(FALLBACK_RESPONSE)
    }

    // Store in ai_explanations table
    await supabase
      .from('ai_explanations')
      .insert({
        span_id: spanId,
        diagnosis: result.diagnosis,
        suggested_fix: result.suggested_fix,
      })

    return NextResponse.json(result)
  } catch {
    // Catch-all for any unexpected error in the entire handler
    return NextResponse.json(FALLBACK_RESPONSE)
  }
}
