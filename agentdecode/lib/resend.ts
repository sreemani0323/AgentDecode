import { logger } from '@/lib/logger'

export async function sendAlertEmail(to: string, subject: string, body: string): Promise<void> {
  try {
    const resendApiKey = process.env.RESEND_API_KEY
    if (!resendApiKey) {
      logger.error('RESEND_API_KEY not set, skipping alert email')
      return
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AgentDecode Alerts <onboarding@resend.dev>',
        to: [to],
        subject,
        text: body,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error('Failed to send alert email via Resend', { status: response.status, errorText })
    }
  } catch (err) {
    logger.error('Alert email error', err as Error)
  }
}

export async function testEmailAlert(to: string): Promise<{ success: boolean; error?: string }> {
  try {
    const resendApiKey = process.env.RESEND_API_KEY
    if (!resendApiKey) {
      return { success: false, error: 'RESEND_API_KEY is not configured' }
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AgentDecode Alerts <onboarding@resend.dev>',
        to: [to],
        subject: 'AgentDecode Test Alert ✅',
        text: 'This is a test alert from AgentDecode. If you received this, your email alerts are configured correctly!\n\nYou can set up alert rules in your project settings to get notified about error rate spikes, high latency, and cost anomalies.',
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `Resend API error: ${response.status} ${errorText}` }
    }

    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}


export async function sendInvitationEmail(
  to: string,
  orgName: string,
  inviteUrl: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const resendApiKey = process.env.RESEND_API_KEY
    if (!resendApiKey) {
      logger.warn('RESEND_API_KEY not configured, skipping invitation email delivery', { to, orgName })
      return { success: false, error: 'RESEND_API_KEY is not configured' }
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AgentDecode Invitations <onboarding@resend.dev>',
        to: [to],
        subject: `You've been invited to join ${orgName} on AgentDecode`,
        text: `You have been invited to join ${orgName} on AgentDecode.\n\nAccept your invitation by clicking the link below:\n${inviteUrl}\n\nThis invitation link will expire in 7 days.\nIf you did not expect this invitation, you can safely ignore this email.`,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error('Failed to send invitation email via Resend', { status: response.status, errorText })
      return { success: false, error: `Resend API error: ${response.status} ${errorText}` }
    }

    return { success: true }
  } catch (err: any) {
    logger.error('Invitation email error', err as Error)
    return { success: false, error: err.message }
  }
}
