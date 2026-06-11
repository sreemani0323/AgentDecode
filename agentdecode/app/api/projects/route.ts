import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

export async function GET(request: Request) {
  const rateLimit = checkRateLimit(request, 'read')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: orgMember } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!orgMember) {
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })
  }

  const { data: projects, error } = await supabase
    .from('projects')
    .select(`
      *,
      sessions (id, error_count)
    `)
    .eq('org_id', orgMember.org_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const projectsWithStats = projects.map(p => {
    const session_count = p.sessions?.length || 0
    const error_count = p.sessions?.reduce((acc: number, s: any) => acc + (s.error_count || 0), 0) || 0
    
    // Remove the raw sessions array from output
    const { sessions, ...rest } = p
    return {
      ...rest,
      session_count,
      error_count
    }
  })

  return NextResponse.json({ projects: projectsWithStats })
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { name, description } = body

    if (!name || name.length < 3 || name.length > 50) {
      return NextResponse.json({ error: 'Name must be between 3 and 50 characters' }, { status: 400 })
    }

    const { data: orgMember } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    if (!orgMember) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 })
    }

    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        org_id: orgMember.org_id,
        name,
        description: description || null
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ project })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
