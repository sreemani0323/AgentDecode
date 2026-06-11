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

  const { id: projectId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify project access
  const { data: project } = await supabase
    .from('projects')
    .select('id, org_id')
    .eq('id', projectId)
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

  const { data: rules, error } = await supabase
    .from('alert_rules')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ rules: rules || [] })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  const { id: projectId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify project access
  const { data: project } = await supabase
    .from('projects')
    .select('id, org_id')
    .eq('id', projectId)
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

  const body = await request.json()
  const { name, metric, threshold, window_minutes, notify_email } = body

  // Validate
  if (!name || !metric || threshold == null || !window_minutes || !notify_email) {
    return NextResponse.json({ error: 'All fields are required: name, metric, threshold, window_minutes, notify_email' }, { status: 400 })
  }

  const validMetrics = ['error_rate', 'latency_p95', 'cost_spike']
  if (!validMetrics.includes(metric)) {
    return NextResponse.json({ error: 'Invalid metric. Must be: error_rate, latency_p95, or cost_spike' }, { status: 400 })
  }

  const { data: rule, error } = await supabase
    .from('alert_rules')
    .insert({
      project_id: projectId,
      name,
      metric,
      threshold: parseFloat(threshold),
      window_minutes: parseInt(window_minutes),
      notify_email,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ rule })
}
