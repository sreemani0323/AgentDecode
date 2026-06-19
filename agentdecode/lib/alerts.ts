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
        // Cooldown check: skip if last_fired_at is within the window
        if (rule.last_fired_at) {
          const lastFired = new Date(rule.last_fired_at).getTime()
          const cooldownMs = rule.window_minutes * 60 * 1000
          if (Date.now() - lastFired < cooldownMs) continue
        }

        let shouldFire = false
        let alertBody = ''

        if (rule.metric === 'error_rate') {
          // Use head:true + count to get counts without fetching rows
          const { count: totalCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .gte('started_at', windowStart)

          if (!totalCount || totalCount === 0) continue

          const { count: errorCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'error')
            .gte('started_at', windowStart)

          const errorRate = ((errorCount || 0) / totalCount) * 100

          if (errorRate > rule.threshold) {
            shouldFire = true
            alertBody = `Alert: ${rule.name}\n\nMetric: Error Rate\nCurrent Value: ${errorRate.toFixed(1)}%\nThreshold: ${rule.threshold}%\nWindow: ${rule.window_minutes} minutes\nProject: ${project.name}\n\nView dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/projects/${projectId}`
          }
        } else if (rule.metric === 'latency_p95') {
          // Get total count of spans with duration in window
          const { count: totalCount } = await supabase
            .from('spans')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .gte('started_at', windowStart)
            .not('duration_ms', 'is', null)

          if (!totalCount || totalCount === 0) continue

          // Fetch exactly the P95 row
          const p95Offset = Math.floor(totalCount * 0.95)
          const { data: p95Row } = await supabase
            .from('spans')
            .select('duration_ms')
            .eq('project_id', projectId)
            .gte('started_at', windowStart)
            .not('duration_ms', 'is', null)
            .order('duration_ms', { ascending: true })
            .range(p95Offset, p95Offset)

          const p95 = p95Row?.[0]?.duration_ms || 0

          if (p95 > rule.threshold) {
            shouldFire = true
            alertBody = `Alert: ${rule.name}\n\nMetric: P95 Latency\nCurrent Value: ${p95}ms\nThreshold: ${rule.threshold}ms\nWindow: ${rule.window_minutes} minutes\nProject: ${project.name}\n\nView dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/projects/${projectId}`
          }
        } else if (rule.metric === 'cost_spike') {
          // Select only cost_usd column and sum client-side
          const { data: costs } = await supabase
            .from('spans')
            .select('cost_usd')
            .eq('project_id', projectId)
            .gte('started_at', windowStart)
            .not('cost_usd', 'is', null)

          if (!costs || costs.length === 0) continue

          const totalCost = costs.reduce((sum: number, s: any) => sum + (s.cost_usd || 0), 0)

          if (totalCost > rule.threshold) {
            shouldFire = true
            alertBody = `Alert: ${rule.name}\n\nMetric: Cost Spike\nCurrent Value: $${totalCost.toFixed(4)}\nThreshold: $${rule.threshold}\nWindow: ${rule.window_minutes} minutes\nProject: ${project.name}\n\nView dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/projects/${projectId}`
          }
        }

        if (shouldFire) {
          await sendAlertEmail(
            rule.notify_email,
            `AgentDecode Alert: ${rule.name} triggered for ${project.name}`,
            alertBody
          )

          // Persist last_fired_at to DB for durable cooldown across cold starts
          await supabase
            .from('alert_rules')
            .update({ last_fired_at: new Date().toISOString() })
            .eq('id', rule.id)
        }
      } catch (ruleErr) {
        logger.error(`Alert rule ${rule.id} check failed`, ruleErr as Error)
      }
    }
  } catch (err) {
    logger.error('checkAndFireAlerts failed', err as Error)
  }
}
