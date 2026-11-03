import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = checkRateLimit(request, 'read')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  const { id: spanId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: evalScore } = await supabase
    .from('eval_scores')
    .select('*')
    .eq('span_id', spanId)
    .single()

  let finalScore = evalScore || null

  // Fallback to trace_evaluations if span-level evaluation row not found
  if (!finalScore) {
    const { data: span } = await supabase
      .from('spans')
      .select('project_id, trace_id')
      .eq('id', spanId)
      .single()

    if (span?.trace_id) {
      const { data: traceEval } = await supabase
        .from('trace_evaluations')
        .select('*')
        .eq('project_id', span.project_id)
        .eq('trace_id', span.trace_id)
        .order('trace_version', { ascending: false })
        .limit(1)
        .single()

      if (traceEval) {
        finalScore = {
          span_id: spanId,
          score: traceEval.score,
          reasoning: traceEval.reasoning,
          flagged: traceEval.flagged,
          generated_at: traceEval.generated_at,
        }
      }
    }
  }

  return NextResponse.json({ eval_score: finalScore })
}
