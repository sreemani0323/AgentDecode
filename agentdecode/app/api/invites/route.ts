import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'
import { sendInvitationEmail } from '@/lib/resend'
import { logger } from '@/lib/logger'

// GET /api/invites?org_id=xxx — List all members & pending invitations for an organization
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

  // Verify the requesting user is a member of this organization
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
  const { data: members, error: membersError } = await supabase
    .from('org_members')
    .select('user_id, role, profiles(full_name, avatar_url)')
    .eq('org_id', orgId)

  if (membersError) {
    return NextResponse.json({ error: membersError.message }, { status: 500 })
  }

  const enrichedMembers = (members || []).map((m: any) => ({
    user_id: m.user_id,
    role: m.role,
    full_name: m.profiles?.full_name || 'Unknown',
    avatar_url: m.profiles?.avatar_url || null,
  }))

  // If caller is an owner, also fetch active pending invitations
  let pendingInvitations: any[] = []
  if (membership.role === 'owner') {
    const { data: invites } = await supabase
      .from('org_invitations')
      .select('id, email, role, created_at, expires_at')
      .eq('org_id', orgId)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })

    pendingInvitations = invites || []
  }

  return NextResponse.json({
    members: enrichedMembers,
    pendingInvitations,
    currentUserRole: membership.role,
  })
}

// POST /api/invites — Issue a cryptographically secure organization invitation
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

  const body = await request.json().catch(() => ({}))
  const { org_id, email, role = 'member' } = body

  if (!org_id || !email || typeof email !== 'string') {
    return NextResponse.json({ error: 'org_id and a valid email are required' }, { status: 400 })
  }

  const normalizedEmail = email.toLowerCase().trim()
  if (!normalizedEmail.includes('@') || normalizedEmail.length < 3) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  // 1. Verify caller is an owner of the organization
  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org_id)
    .eq('user_id', user.id)
    .single()

  if (!membership || membership.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only organization owners can create invitations' },
      { status: 403 }
    )
  }

  // 2. Prevent inviting own email
  if (user.email && normalizedEmail === user.email.toLowerCase()) {
    return NextResponse.json({ error: 'You cannot invite yourself' }, { status: 400 })
  }

  // 3. Fetch organization name for email branding
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', org_id)
    .single()

  const orgName = org?.name || 'Your Organization'

  // 4. Generate cryptographically secure random token (32 bytes = 256 bits of entropy)
  const rawToken = crypto.randomBytes(32).toString('hex')

  // 5. Compute SHA-256 hash of the token for secure storage
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

  // 6. Expiry: 7 days from now
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  // 7. Persist only the token_hash in org_invitations table
  const adminSupabase = createServiceClient()
  const { data: invitation, error: insertError } = await adminSupabase
    .from('org_invitations')
    .insert({
      org_id,
      email: normalizedEmail,
      invited_by: user.id,
      role: role === 'owner' ? 'owner' : 'member',
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select('id, org_id, email, role, expires_at, created_at')
    .single()

  if (insertError) {
    logger.error('Failed to create organization invitation', insertError as Error)
    return NextResponse.json(
      { error: 'Failed to create invitation: ' + insertError.message },
      { status: 500 }
    )
  }

  // 8. Deliver raw token ONLY to the intended recipient via email
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const inviteUrl = `${baseUrl}/invites/accept?token=${rawToken}`
  const emailResult = await sendInvitationEmail(normalizedEmail, orgName, inviteUrl)

  return NextResponse.json({
    success: true,
    message: `${normalizedEmail} has been invited.`,
    invitation: {
      id: invitation.id,
      org_id: invitation.org_id,
      email: invitation.email,
      role: invitation.role,
      expires_at: invitation.expires_at,
    },
    invite_url: inviteUrl,
    token: rawToken,
    email_sent: emailResult.success,
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

  const body = await request.json().catch(() => ({}))
  const { org_id, user_id } = body

  if (!org_id || !user_id) {
    return NextResponse.json({ error: 'org_id and user_id are required' }, { status: 400 })
  }

  if (user_id === user.id) {
    return NextResponse.json({ error: 'You cannot remove yourself from the organization' }, { status: 400 })
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org_id)
    .eq('user_id', user.id)
    .single()

  if (!membership || membership.role !== 'owner') {
    return NextResponse.json({ error: 'Only organization owners can remove members' }, { status: 403 })
  }

  const { data: targetMember } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org_id)
    .eq('user_id', user_id)
    .single()

  if (targetMember?.role === 'owner') {
    return NextResponse.json({ error: 'Cannot remove an organization owner' }, { status: 403 })
  }

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
