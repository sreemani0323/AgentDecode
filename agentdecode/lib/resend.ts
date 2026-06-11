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
