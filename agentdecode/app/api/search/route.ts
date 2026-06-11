import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * GET /api/search?q=timeout&limit=10
 *
 * Global search across sessions, spans, and issues.
 * Returns grouped results by type.
 * Auth: requires logged-in user (RLS enforced).
 */
export async function GET(request: NextRequest) {
  const rateLimit = checkRateLimit(request, 'read')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim()
  const limit = Math.min(parseInt(searchParams.get('limit') || '8'), 20)

  if (!query || query.length < 2) {
    return NextResponse.json({ results: [], query: '' })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get user's org IDs for scoping
  const { data: memberships } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)

  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ results: [], query })
  }

  const orgIds = memberships.map(m => m.org_id)

  // Get user's project IDs
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name')
    .in('org_id', orgIds)

  if (!projects || projects.length === 0) {
    return NextResponse.json({ results: [], query })
  }

  const projectIds = projects.map(p => p.id)
  const projectMap = Object.fromEntries(projects.map(p => [p.id, p.name]))

  const searchPattern = `%${query}%`

  // Search sessions
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, name, status, project_id, started_at, span_count, error_count')
    .in('project_id', projectIds)
    .ilike('name', searchPattern)
    .order('started_at', { ascending: false })
    .limit(limit)

  // Search spans
  const { data: spans } = await supabase
    .from('spans')
    .select('id, name, span_type, status, session_id, project_id, model, error_message, duration_ms')
    .in('project_id', projectIds)
    .or(`name.ilike.${searchPattern},error_message.ilike.${searchPattern},model.ilike.${searchPattern}`)
    .order('started_at', { ascending: false })
    .limit(limit)

  // Search issues
  const { data: issues } = await supabase
    .from('issues')
    .select('id, title, status, project_id, occurrence_count, last_seen_at')
    .in('project_id', projectIds)
    .ilike('title', searchPattern)
    .order('last_seen_at', { ascending: false })
    .limit(limit)

  const results = [
    ...(sessions || []).map(s => ({
      type: 'session' as const,
      id: s.id,
      title: s.name || 'Unnamed Session',
      subtitle: `${s.span_count || 0} spans · ${projectMap[s.project_id] || 'Unknown'}`,
      status: s.status,
      href: `/sessions/${s.id}`,
      projectId: s.project_id,
    })),
    ...(spans || []).map(s => ({
      type: 'span' as const,
      id: s.id,
      title: s.name,
      subtitle: `${s.span_type} · ${s.model || 'no model'} · ${s.duration_ms ? `${s.duration_ms}ms` : ''} · ${projectMap[s.project_id] || ''}`,
      status: s.status,
      href: `/sessions/${s.session_id}`,
      projectId: s.project_id,
    })),
    ...(issues || []).map(i => ({
      type: 'issue' as const,
      id: i.id,
      title: i.title,
      subtitle: `${i.occurrence_count}× · ${i.status} · ${projectMap[i.project_id] || ''}`,
      status: i.status,
      href: `/projects/${i.project_id}/issues`,
      projectId: i.project_id,
    })),
  ]

  return NextResponse.json({ results, query })
}
