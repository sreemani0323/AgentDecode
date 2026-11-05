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
      // 1. Try matching trace_evaluations by span_id to avoid multi-span collisions
      const { data: spanEvals } = await supabase
        .from('trace_evaluations')
        .select('*')
        .eq('project_id', span.project_id)
        .eq('span_id', spanId)
        .order('trace_version', { ascending: false })
        .limit(1)

      const spanTraceEval = Array.isArray(spanEvals)
        ? spanEvals[0]
        : (spanEvals as any)?.data?.[0] || (spanEvals as any)

      if (spanTraceEval && spanTraceEval.score !== undefined) {
        finalScore = {
          span_id: spanId,
          score: spanTraceEval.score,
          reasoning: spanTraceEval.reasoning,
          flagged: spanTraceEval.flagged,
          generated_at: spanTraceEval.generated_at,
        }
      } else {
        // 2. Legacy fallback for traces where span_id IS NULL
        const { data: traceEvals } = await supabase
          .from('trace_evaluations')
          .select('*')
          .eq('project_id', span.project_id)
          .eq('trace_id', span.trace_id)
          .order('trace_version', { ascending: false })
          .limit(1)

        const legacyTraceEval = Array.isArray(traceEvals)
          ? traceEvals[0]
          : (traceEvals as any)?.data?.[0] || (traceEvals as any)

        if (legacyTraceEval && legacyTraceEval.score !== undefined) {
          finalScore = {
            span_id: spanId,
            score: legacyTraceEval.score,
            reasoning: legacyTraceEval.reasoning,
            flagged: legacyTraceEval.flagged,
            generated_at: legacyTraceEval.generated_at,
          }
        }
      }
    }
  }

  return NextResponse.json({ eval_score: finalScore })
}
