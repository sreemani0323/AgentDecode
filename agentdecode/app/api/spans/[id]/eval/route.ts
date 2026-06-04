import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  return NextResponse.json({ eval_score: evalScore || null })
}
