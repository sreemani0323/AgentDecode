import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

// POST /api/invites/accept — Accept an organization invitation using the raw token
export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required. Please sign in to accept this invitation.' },
      { status: 401 }
    )
  }

  const body = await request.json().catch(() => ({}))
  const { token } = body

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return NextResponse.json({ error: 'Invitation token is required' }, { status: 400 })
  }

  try {
    // Atomically execute accept_org_invitation SECURITY DEFINER stored procedure
    // Computes SHA-256 hash server-side and verifies single-use, expiry, and email match
    const { data, error } = await supabase.rpc('accept_org_invitation', {
      p_token: token.trim(),
    })

    if (error) {
      logger.warn('Failed to accept organization invitation', {
        error: error.message,
        userId: user.id,
      })

      const msg = error.message || ''
      const status =
        msg.includes('expired') || msg.includes('already been used')
          ? 410 // Gone
          : msg.includes('different email')
          ? 403 // Forbidden (email mismatch)
          : msg.includes('Invalid')
          ? 404 // Not Found
          : 400

      return NextResponse.json({ error: msg }, { status })
    }

    return NextResponse.json({
      success: true,
      message: 'Successfully joined organization',
      membership: data,
    })
  } catch (err: any) {
    logger.error('Unexpected error accepting invitation', err as Error)
    return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 })
  }
}

