import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { explainSpanFailure } from '@/lib/gemini'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY is not configured in .env.local. AI explanation is disabled.' },
      { status: 412 }
    )
  }

  // Call Gemini API
  const result = await explainSpanFailure(span)

  // Store in ai_explanations table
  await supabase
    .from('ai_explanations')
    .insert({
      span_id: spanId,
      diagnosis: result.diagnosis,
      suggested_fix: result.suggested_fix,
    })

  return NextResponse.json(result)
}
