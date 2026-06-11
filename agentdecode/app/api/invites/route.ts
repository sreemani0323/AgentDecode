import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

// GET /api/invites?org_id=xxx — List all members of an organization
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

  const { searchParams } = new URL(request.url)
  const orgId = searchParams.get('org_id')

  if (!orgId) {
    return NextResponse.json({ error: 'org_id is required' }, { status: 400 })
  }

  // Verify the requesting user is a member
  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 })
  }

  // Fetch all members with profile info
  const { data: members, error } = await supabase
    .from('org_members')
    .select('user_id, role, profiles(full_name, avatar_url)')
    .eq('org_id', orgId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Get emails from auth — we need to look up each user's email via their profile
  // Since we can't directly query auth.users, we'll fetch user emails from supabase auth admin
  // For now, we return what we have and the client can display names
  const enrichedMembers = (members || []).map((m: any) => ({
    user_id: m.user_id,
    role: m.role,
    full_name: m.profiles?.full_name || 'Unknown',
    avatar_url: m.profiles?.avatar_url || null,
  }))

  return NextResponse.json({
    members: enrichedMembers,
    currentUserRole: membership.role,
  })
}

// POST /api/invites — Invite a user by email
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

  const body = await request.json()
  const { org_id, email } = body

  if (!org_id || !email) {
    return NextResponse.json({ error: 'org_id and email are required' }, { status: 400 })
  }

  // Verify the requesting user is an owner
  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org_id)
    .eq('user_id', user.id)
    .single()

  if (!membership || membership.role !== 'owner') {
    return NextResponse.json({ error: 'Only organization owners can invite members' }, { status: 403 })
  }

  // Find the user by email — look up in profiles joined with auth
  // We need to find if a user with this email exists
  // Since we can't query auth.users directly with the anon client, 
  // we use a workaround: check if there's a profile with a matching user
  // The proper way is via Supabase admin API, but for the authenticated client
  // we'll search profiles where auth.users email matches

  // Alternative: look up the user via the auth admin API
  // For now, let's use a simple approach — try to find the user via RPC or direct lookup

  // First, check if the email belongs to the current user
  if (email === user.email) {
    return NextResponse.json({ error: 'You cannot invite yourself' }, { status: 400 })
  }

  // We'll look for users who have signed up with this email
  // by checking Supabase auth.users via a server-side query
  // Since we're using the user's client (not service role), we need a different approach.
  // Let's use an RPC function or just try to find the user in profiles.
  
  // Simplified approach: use the Supabase admin/service client to look up the user
  const { createServiceClient } = await import('@/lib/supabase/server')
  const adminSupabase = createServiceClient()

  // Search for user by email using the auth admin API
  const { data: authUsers, error: authError } = await adminSupabase.auth.admin.listUsers()

  if (authError) {
    return NextResponse.json({ error: 'Failed to look up user' }, { status: 500 })
  }

  const targetUser = authUsers?.users?.find(u => u.email === email)

  if (!targetUser) {
    return NextResponse.json({
      error: `No account found for ${email}. They need to sign up first.`
    }, { status: 404 })
  }

  // Check if already a member
  const { data: existingMember } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', org_id)
    .eq('user_id', targetUser.id)
    .single()

  if (existingMember) {
    return NextResponse.json({ error: 'This user is already a member' }, { status: 409 })
  }

  // Add them as a member
  const { error: insertError } = await adminSupabase
    .from('org_members')
    .insert({
      org_id,
      user_id: targetUser.id,
      role: 'member',
    })

  if (insertError) {
    return NextResponse.json({ error: 'Failed to add member: ' + insertError.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    member: {
      user_id: targetUser.id,
      role: 'member',
      full_name: targetUser.user_metadata?.full_name || email,
    },
  })
}

// DELETE /api/invites — Remove a member from the organization
export async function DELETE(request: Request) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { org_id, user_id } = body

  if (!org_id || !user_id) {
    return NextResponse.json({ error: 'org_id and user_id are required' }, { status: 400 })
  }

  // Cannot remove yourself
  if (user_id === user.id) {
    return NextResponse.json({ error: 'You cannot remove yourself from the organization' }, { status: 400 })
  }

  // Verify the requesting user is an owner
  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org_id)
    .eq('user_id', user.id)
    .single()

  if (!membership || membership.role !== 'owner') {
    return NextResponse.json({ error: 'Only organization owners can remove members' }, { status: 403 })
  }

  // Cannot remove another owner
  const { data: targetMember } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org_id)
    .eq('user_id', user_id)
    .single()

  if (targetMember?.role === 'owner') {
    return NextResponse.json({ error: 'Cannot remove an organization owner' }, { status: 403 })
  }

  // Remove the member
  const { error: deleteError } = await supabase
    .from('org_members')
    .delete()
    .eq('org_id', org_id)
    .eq('user_id', user_id)

  if (deleteError) {
    return NextResponse.json({ error: 'Failed to remove member: ' + deleteError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
