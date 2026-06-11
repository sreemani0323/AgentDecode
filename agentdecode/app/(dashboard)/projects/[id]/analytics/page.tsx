import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import AnalyticsCharts from '@/components/analytics/AnalyticsCharts'
import { format, subDays } from 'date-fns'

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Verify project access
  const { data: project } = await supabase
    .from('projects')
    .select('*, organizations!inner(id)')
    .eq('id', id)
    .single()

  if (!project) notFound()

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('org_id', project.org_id)
    .eq('user_id', user.id)
    .single()

  if (!membership) notFound()

  // ── Fetch all spans for the project (last 30 days) ─────────────
  const thirtyDaysAgo = subDays(new Date(), 30).toISOString()

  const { data: spans } = await supabase
    .from('spans')
    .select('id, span_type, status, duration_ms, model, cost_usd, input_tokens, output_tokens, started_at')
    .eq('project_id', id)
    .gte('started_at', thirtyDaysAgo)
    .order('started_at', { ascending: true })

  const allSpans = spans || []

  // ── Fetch eval scores for these spans ─────────────────────────
  const spanIds = allSpans.map(s => s.id)
  const evalScores: Array<{ span_id: string; score: number; flagged: boolean }> = []

  if (spanIds.length > 0) {
    // Fetch in batches of 500 to avoid query limits
    for (let i = 0; i < spanIds.length; i += 500) {
      const batch = spanIds.slice(i, i + 500)
      const { data: scores } = await supabase
        .from('eval_scores')
        .select('span_id, score, flagged')
        .in('span_id', batch)

      if (scores) evalScores.push(...scores)
    }
  }

  // ── Compute analytics data ────────────────────────────────────

  // 1. Cost by model (for donut chart)
  const costByModel: Record<string, number> = {}
  for (const span of allSpans) {
    if (span.model && span.cost_usd) {
      costByModel[span.model] = (costByModel[span.model] || 0) + span.cost_usd
    }
  }
  const costByModelData = Object.entries(costByModel)
    .map(([model, cost]) => ({ model, cost: Math.round(cost * 10000) / 10000 }))
    .sort((a, b) => b.cost - a.cost)

  // 2. Span type distribution (for bar chart)
  const spanTypeCounts: Record<string, number> = {}
  for (const span of allSpans) {
    spanTypeCounts[span.span_type] = (spanTypeCounts[span.span_type] || 0) + 1
  }
  const spanTypeData = Object.entries(spanTypeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)

  // 3. Latency P50/P95 per day (last 14 days)
  const latencyByDay: Record<string, number[]> = {}
  for (const span of allSpans) {
    if (span.duration_ms == null) continue
    const day = format(new Date(span.started_at), 'yyyy-MM-dd')
    if (!latencyByDay[day]) latencyByDay[day] = []
    latencyByDay[day].push(span.duration_ms)
  }

  const latencyTrendData = Array.from({ length: 14 }, (_, i) => {
    const date = format(subDays(new Date(), 13 - i), 'yyyy-MM-dd')
    const durations = latencyByDay[date] || []
    durations.sort((a, b) => a - b)
    const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : 0
    const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0
    return {
      date,
      label: format(new Date(date), 'MMM d'),
      p50: Math.round(p50),
      p95: Math.round(p95),
      count: durations.length,
    }
  })

  // 4. Eval score distribution (histogram buckets 0-1, 1-2, ..., 9-10)
  const scoreBuckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i}-${i + 1}`,
    count: 0,
    label: `${i}`,
  }))
  for (const es of evalScores) {
    const bucket = Math.min(Math.floor(es.score), 9)
    scoreBuckets[bucket].count++
  }

  // 5. Daily cost trend (last 14 days)
  const costByDay: Record<string, number> = {}
  for (const span of allSpans) {
    if (!span.cost_usd) continue
    const day = format(new Date(span.started_at), 'yyyy-MM-dd')
    costByDay[day] = (costByDay[day] || 0) + span.cost_usd
  }

  const costTrendData = Array.from({ length: 14 }, (_, i) => {
    const date = format(subDays(new Date(), 13 - i), 'yyyy-MM-dd')
    return {
      date,
      label: format(new Date(date), 'MMM d'),
      cost: Math.round((costByDay[date] || 0) * 10000) / 10000,
    }
  })

  // 6. Summary stats
  const totalSpans = allSpans.length
  const totalCost = allSpans.reduce((sum, s) => sum + (s.cost_usd || 0), 0)
  const totalTokens = allSpans.reduce((sum, s) => sum + (s.input_tokens || 0) + (s.output_tokens || 0), 0)
  const errorCount = allSpans.filter(s => s.status === 'error').length
  const errorRate = totalSpans > 0 ? (errorCount / totalSpans) * 100 : 0
  const avgEvalScore = evalScores.length > 0
    ? evalScores.reduce((sum, e) => sum + e.score, 0) / evalScores.length
    : 0
  const flaggedCount = evalScores.filter(e => e.flagged).length

  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground" style={{ fontFamily: "'Clash Display', sans-serif" }}>
            Analytics
          </h1>
          <p className="text-muted-foreground mt-1">{project.name} — Last 30 days</p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <SummaryCard label="Total Spans" value={totalSpans.toLocaleString()} />
        <SummaryCard label="Total Cost" value={`$${totalCost.toFixed(4)}`} />
        <SummaryCard label="Total Tokens" value={totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens.toString()} />
        <SummaryCard label="Error Rate" value={`${errorRate.toFixed(1)}%`} accent={errorRate > 5 ? 'red' : 'green'} />
        <SummaryCard label="Avg Eval Score" value={avgEvalScore > 0 ? `${avgEvalScore.toFixed(1)}/10` : '—'} accent={avgEvalScore >= 7 ? 'green' : avgEvalScore >= 5 ? 'amber' : 'red'} />
        <SummaryCard label="Flagged" value={flaggedCount.toString()} accent={flaggedCount > 0 ? 'amber' : 'green'} />
      </div>

      {/* Charts */}
      <AnalyticsCharts
        costByModel={costByModelData}
        spanTypeData={spanTypeData}
        latencyTrend={latencyTrendData}
        scoreBuckets={scoreBuckets}
        costTrend={costTrendData}
      />
    </div>
  )
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: 'red' | 'green' | 'amber' }) {
  const accentColor = accent === 'red' ? 'text-red-500' : accent === 'green' ? 'text-emerald-600' : accent === 'amber' ? 'text-amber-500' : 'text-foreground'

  return (
    <div className="p-4 rounded-xl border border-border bg-card">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-bold mt-1 ${accentColor}`}>{value}</p>
    </div>
  )
}
