import { createServiceClient } from '@/lib/supabase/server'
import { sendAlertEmail } from '@/lib/resend'
import { logger } from '@/lib/logger'

export async function checkAndFireAlerts(projectId: string): Promise<void> {
  try {
    const supabase = createServiceClient()

    // Get project name
    const { data: project } = await supabase
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .single()

    if (!project) return

    // Get active alert rules for this project
    const { data: rules } = await supabase
      .from('alert_rules')
      .select('*')
      .eq('project_id', projectId)
      .eq('is_active', true)

    if (!rules || rules.length === 0) return

    for (const rule of rules) {
      const windowStart = new Date(Date.now() - rule.window_minutes * 60 * 1000).toISOString()

      try {
        if (rule.metric === 'error_rate') {
          // Count total sessions and error sessions in window
          const { data: sessions } = await supabase
            .from('sessions')
            .select('id, status')
            .eq('project_id', projectId)
            .gte('started_at', windowStart)

          if (!sessions || sessions.length === 0) continue

          const errorCount = sessions.filter((s: any) => s.status === 'error').length
          const errorRate = (errorCount / sessions.length) * 100

          if (errorRate > rule.threshold) {
            await sendAlertEmail(
              rule.notify_email,
              `AgentDecode Alert: ${rule.name} triggered for ${project.name}`,
              `Alert: ${rule.name}\n\nMetric: Error Rate\nCurrent Value: ${errorRate.toFixed(1)}%\nThreshold: ${rule.threshold}%\nWindow: ${rule.window_minutes} minutes\nProject: ${project.name}\n\nView dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/projects/${projectId}`
            )
          }
        } else if (rule.metric === 'latency_p95') {
          // Get span durations in window
          const { data: spans } = await supabase
            .from('spans')
            .select('duration_ms')
            .eq('project_id', projectId)
            .gte('started_at', windowStart)
            .not('duration_ms', 'is', null)
            .order('duration_ms', { ascending: true })

          if (!spans || spans.length === 0) continue

          const p95Index = Math.floor(spans.length * 0.95)
          const p95 = spans[p95Index]?.duration_ms || 0

          if (p95 > rule.threshold) {
            await sendAlertEmail(
              rule.notify_email,
              `AgentDecode Alert: ${rule.name} triggered for ${project.name}`,
              `Alert: ${rule.name}\n\nMetric: P95 Latency\nCurrent Value: ${p95}ms\nThreshold: ${rule.threshold}ms\nWindow: ${rule.window_minutes} minutes\nProject: ${project.name}\n\nView dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/projects/${projectId}`
            )
          }
        } else if (rule.metric === 'cost_spike') {
          // Sum cost in window
          const { data: spans } = await supabase
            .from('spans')
            .select('cost_usd')
            .eq('project_id', projectId)
            .gte('started_at', windowStart)
            .not('cost_usd', 'is', null)

          if (!spans || spans.length === 0) continue

          const totalCost = spans.reduce((sum: number, s: any) => sum + (s.cost_usd || 0), 0)

          if (totalCost > rule.threshold) {
            await sendAlertEmail(
              rule.notify_email,
              `AgentDecode Alert: ${rule.name} triggered for ${project.name}`,
              `Alert: ${rule.name}\n\nMetric: Cost Spike\nCurrent Value: $${totalCost.toFixed(4)}\nThreshold: $${rule.threshold}\nWindow: ${rule.window_minutes} minutes\nProject: ${project.name}\n\nView dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/projects/${projectId}`
            )
          }
        }
      } catch (ruleErr) {
        logger.error(`Alert rule ${rule.id} check failed`, ruleErr as Error)
      }
    }
  } catch (err) {
    logger.error('checkAndFireAlerts failed', err as Error)
  }
}
