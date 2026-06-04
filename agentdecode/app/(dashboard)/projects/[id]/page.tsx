import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Settings, ArrowLeft, AlertCircle, Bell, Download, BarChart3, GitCompareArrows } from 'lucide-react'
import StatCard from '@/components/dashboard/StatCard'
import SessionsTable from '@/components/sessions/SessionsTable'
import ErrorRateChart from '@/components/charts/ErrorRateChart'
import { Activity, AlertTriangle, DollarSign, Calendar } from 'lucide-react'
import { format, subDays } from 'date-fns'

const PAGE_SIZE = 20

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { id } = await params
  const { page: pageParam } = await searchParams
  const currentPage = Math.max(1, parseInt(pageParam || '1', 10))
  const offset = (currentPage - 1) * PAGE_SIZE

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single()

  if (!project) {
    notFound()
  }

  // Verify user has access
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('org_id', project.org_id)
    .eq('user_id', user.id)
    .single()

  if (!membership) {
    notFound()
  }

  // Get total session count for pagination
  const { count: totalCount } = await supabase
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', id)

  const totalPages = Math.ceil((totalCount || 0) / PAGE_SIZE)

  // Fetch paginated sessions
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('project_id', id)
    .order('started_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  // Fetch eval quality data for sessions
  const sessionsWithQuality = await Promise.all(
    (sessions || []).map(async (session: any) => {
      // Check if session has LLM spans
      const { data: llmSpans } = await supabase
        .from('spans')
        .select('id')
        .eq('session_id', session.id)
        .eq('span_type', 'llm')
        .limit(1)

      const hasLlmSpans = (llmSpans?.length || 0) > 0

      let hasLowQuality = false
      if (hasLlmSpans) {
        // Check if any eval scores are flagged
        const { data: flagged } = await supabase
          .from('eval_scores')
          .select('span_id')
          .in('span_id', (await supabase
            .from('spans')
            .select('id')
            .eq('session_id', session.id)
            .eq('span_type', 'llm')
          ).data?.map((s: any) => s.id) || [])
          .eq('flagged', true)
          .limit(1)

        hasLowQuality = (flagged?.length || 0) > 0
      }

      return { ...session, hasLlmSpans, hasLowQuality }
    })
  )

  // Fetch all sessions for stats
  const { data: allSessions } = await supabase
    .from('sessions')
    .select('id, status, error_count, total_cost_usd, started_at')
    .eq('project_id', id)

  // Calculate stats
  const totalSessions = allSessions?.length || 0

  const oneWeekAgo = new Date()
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
  const weekSessions = allSessions?.filter(
    (s) => new Date(s.started_at) >= oneWeekAgo
  ) || []

  const sessionsThisWeek = weekSessions.length
  const errorsThisWeek = weekSessions.filter((s) => s.status === 'error').length
  const errorRateThisWeek = sessionsThisWeek > 0
    ? ((errorsThisWeek / sessionsThisWeek) * 100).toFixed(1)
    : '0.0'
  const costThisWeek = weekSessions.reduce(
    (sum, s) => sum + (s.total_cost_usd || 0),
    0
  )

  // 7-day error rate chart data
  const chartData = Array.from({ length: 7 }, (_, i) => {
    const date = subDays(new Date(), 6 - i)
    const dateStr = format(date, 'yyyy-MM-dd')
    const dayStart = new Date(dateStr + 'T00:00:00Z')
    const dayEnd = new Date(dateStr + 'T23:59:59Z')

    const daySessions = allSessions?.filter((s) => {
      const t = new Date(s.started_at)
      return t >= dayStart && t <= dayEnd
    }) || []

    const dayErrors = daySessions.filter((s) => s.status === 'error').length
    const errorRate = daySessions.length > 0 ? (dayErrors / daySessions.length) * 100 : 0

    return {
      date: dateStr,
      errorRate: Math.round(errorRate * 10) / 10,
      totalSessions: daySessions.length,
    }
  })

  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{project.name}</h1>
            {project.description && (
              <p className="text-muted-foreground mt-1">{project.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/projects/${id}/issues`}>
            <Button variant="outline">
              <AlertCircle className="w-4 h-4 mr-2" />
              Issues
            </Button>
          </Link>
          <Link href={`/projects/${id}/analytics`}>
            <Button variant="outline">
              <BarChart3 className="w-4 h-4 mr-2" />
              Analytics
            </Button>
          </Link>
          <Link href={`/projects/${id}/compare`}>
            <Button variant="outline">
              <GitCompareArrows className="w-4 h-4 mr-2" />
              Compare
            </Button>
          </Link>
          <Link href={`/projects/${id}/alerts`}>
            <Button variant="outline">
              <Bell className="w-4 h-4 mr-2" />
              Alerts
            </Button>
          </Link>
          <a href={`/api/export/finetune?project_id=${id}&min_score=8`} download>
            <Button variant="outline">
              <Download className="w-4 h-4 mr-2" />
              Export for Fine-Tuning
            </Button>
          </a>
          <Link href={`/projects/${id}/settings`}>
            <Button variant="outline">
              <Settings className="w-4 h-4 mr-2" />
              API Keys
            </Button>
          </Link>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Sessions"
          value={totalSessions}
          icon={Activity}
        />
        <StatCard
          title="Sessions This Week"
          value={sessionsThisWeek}
          icon={Calendar}
        />
        <StatCard
          title="Error Rate This Week"
          value={`${errorRateThisWeek}%`}
          icon={AlertTriangle}
          trend={parseFloat(errorRateThisWeek) > 5 ? 'down' : 'up'}
        />
        <StatCard
          title="Cost This Week"
          value={`$${costThisWeek.toFixed(4)}`}
          icon={DollarSign}
        />
      </div>

      {/* 7-Day Error Rate Chart */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">7-Day Error Rate</h2>
        <ErrorRateChart data={chartData} />
      </div>

      {/* Sessions Table */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground">Recent Sessions</h2>
        {sessionsWithQuality && sessionsWithQuality.length > 0 ? (
          <>
            <SessionsTable sessions={sessionsWithQuality} />

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-4 pt-4">
                {currentPage > 1 ? (
                  <Link href={`/projects/${id}?page=${currentPage - 1}`}>
                    <Button variant="outline" size="sm">
                      Previous
                    </Button>
                  </Link>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    Previous
                  </Button>
                )}

                <span className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </span>

                {currentPage < totalPages ? (
                  <Link href={`/projects/${id}?page=${currentPage + 1}`}>
                    <Button variant="outline" size="sm">
                      Next
                    </Button>
                  </Link>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    Next
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="space-y-6">
            {/* Quickstart Hero */}
            <div className="text-center py-10 px-8 rounded-2xl border border-border bg-gradient-to-b from-primary/5 to-transparent">
              <Activity className="w-10 h-10 text-primary mx-auto mb-4" />
              <h3 className="text-xl font-bold text-foreground mb-2">Ready to trace your first agent</h3>
              <p className="text-muted-foreground max-w-lg mx-auto">
                Follow the steps below to connect your AI agent to this project. It takes under 2 minutes.
              </p>
            </div>

            {/* Step 1: Get API Key */}
            <div className="p-6 rounded-xl border border-border bg-card space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center border border-primary/20 shrink-0">1</div>
                <h4 className="text-base font-semibold text-foreground">Generate an API Key</h4>
              </div>
              <p className="text-sm text-muted-foreground ml-10">
                Go to your project settings and create an API key. You&apos;ll need this to authenticate telemetry from your agent.
              </p>
              <div className="ml-10">
                <Link href={`/projects/${id}/settings`}>
                  <Button variant="outline" size="sm">
                    <Settings className="w-4 h-4 mr-2" />
                    Go to API Keys
                  </Button>
                </Link>
              </div>
            </div>

            {/* Step 2: Send your first trace */}
            <div className="p-6 rounded-xl border border-border bg-card space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center border border-primary/20 shrink-0">2</div>
                <h4 className="text-base font-semibold text-foreground">Send your first trace</h4>
              </div>
              <p className="text-sm text-muted-foreground ml-10">
                Add this to your agent code after an LLM call. Replace the API key and endpoint with your own values.
              </p>
              <div className="ml-10">
                <pre className="p-4 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
                  <code>{`// After your LLM call completes, send the trace to AgentDecode
await fetch('${process.env.NEXT_PUBLIC_SITE_URL || 'https://your-app.vercel.app'}/api/ingest', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer al_sk_your_api_key_here',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    session_name: 'My Agent Session',
    spans: [{
      name: 'classify_intent',
      span_type: 'llm',
      model: 'gpt-4o',
      status: 'ok',
      started_at: new Date(Date.now() - 1200).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 1200,
      input: { messages: [{ role: 'user', content: 'Hello' }] },
      output: { response: 'Hi! How can I help?' },
      input_tokens: 12,
      output_tokens: 8,
      cost_usd: 0.001,
    }],
  }),
})`}</code>
                </pre>
              </div>
            </div>

            {/* Step 3: Check your dashboard */}
            <div className="p-6 rounded-xl border border-border bg-card space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center border border-primary/20 shrink-0">3</div>
                <h4 className="text-base font-semibold text-foreground">Check your dashboard</h4>
              </div>
              <p className="text-sm text-muted-foreground ml-10">
                Refresh this page after sending a trace. You&apos;ll see your session appear with the full span tree, token counts, latency, and auto-generated eval scores.
              </p>
            </div>

            {/* SDK alternative */}
            <div className="p-4 rounded-xl border border-border bg-card/50">
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground">Want automatic tracing?</strong>{' '}
                Install the <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">@agentdecode/sdk</code> package
                from <Link href="/dashboard/docs" className="text-primary hover:underline">the docs</Link> to wrap your functions and get zero-config tracing.
              </p>
            </div>

            {/* Or Demo */}
            <div className="text-center py-6 rounded-xl border border-dashed border-border bg-card/50">
              <p className="text-sm text-muted-foreground mb-3">
                Want to see how it looks first? Generate demo data from Project Settings.
              </p>
              <Link href={`/projects/${id}/settings`}>
                <Button variant="outline" size="sm">
                  Generate Demo Traffic
                </Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
