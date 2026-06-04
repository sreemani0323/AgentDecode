"use client"

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowLeft, GitCompareArrows, ArrowUpDown, Clock, Cpu, DollarSign, Sparkles, AlertTriangle } from 'lucide-react'
import type { Session, Span, EvalScore } from '@/types'

interface SessionWithSpans extends Session {
  spans: Span[]
  evalScores: Record<string, EvalScore>
}

function MetricCard({ label, valueA, valueB, format: fmt, lowerIsBetter }: {
  label: string
  valueA: number
  valueB: number
  format: (v: number) => string
  lowerIsBetter?: boolean
}) {
  const diff = valueB - valueA
  const pctChange = valueA > 0 ? ((diff / valueA) * 100) : 0
  const improved = lowerIsBetter ? diff < 0 : diff > 0
  const changed = Math.abs(pctChange) > 0.5

  return (
    <div className="p-4 rounded-xl border border-border bg-card">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">{label}</p>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] text-muted-foreground mb-0.5">Session A</p>
          <p className="text-lg font-bold text-foreground">{fmt(valueA)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground mb-0.5">Session B</p>
          <p className="text-lg font-bold text-foreground">{fmt(valueB)}</p>
        </div>
      </div>
      {changed && (
        <div className={`mt-2 text-xs font-medium flex items-center gap-1 ${improved ? 'text-emerald-600' : 'text-red-500'}`}>
          <ArrowUpDown className="w-3 h-3" />
          {pctChange > 0 ? '+' : ''}{pctChange.toFixed(1)}%
          <span className="text-muted-foreground font-normal ml-1">
            ({improved ? 'improved' : 'regressed'})
          </span>
        </div>
      )}
    </div>
  )
}

function SpanRow({ spanA, spanB, evalA, evalB }: {
  spanA?: Span
  spanB?: Span
  evalA?: EvalScore
  evalB?: EvalScore
}) {
  const name = spanA?.name || spanB?.name || ''
  const type = spanA?.span_type || spanB?.span_type || ''
  const hasA = !!spanA
  const hasB = !!spanB

  const typeColors: Record<string, string> = {
    llm: '#197066', tool: '#d97706', agent: '#7c3aed', chain: '#2563eb', retrieval: '#db2777',
  }

  return (
    <div className="flex items-stretch border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors">
      {/* Span name */}
      <div className="w-[30%] px-4 py-3 flex items-center gap-2 border-r border-border">
        <span
          className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded"
          style={{ background: `${typeColors[type] || '#6b6960'}15`, color: typeColors[type] || '#6b6960' }}
        >
          {type}
        </span>
        <span className="text-sm font-medium text-foreground truncate">{name}</span>
      </div>

      {/* Session A */}
      <div className="w-[35%] px-4 py-3 border-r border-border">
        {hasA ? (
          <div className="flex items-center gap-4 text-xs">
            <span className={`font-mono ${spanA.status === 'error' ? 'text-red-500' : 'text-foreground'}`}>
              {spanA.duration_ms != null ? `${spanA.duration_ms}ms` : '—'}
            </span>
            {spanA.model && <span className="text-muted-foreground">{spanA.model}</span>}
            {evalA && (
              <span className={`font-semibold ${evalA.score >= 7 ? 'text-emerald-600' : evalA.score >= 5 ? 'text-amber-500' : 'text-red-500'}`}>
                {evalA.score}/10
              </span>
            )}
            {spanA.status === 'error' && (
              <span className="text-red-500 text-[10px] font-medium">✗ error</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground italic">not present</span>
        )}
      </div>

      {/* Session B */}
      <div className="w-[35%] px-4 py-3">
        {hasB ? (
          <div className="flex items-center gap-4 text-xs">
            <span className={`font-mono ${spanB.status === 'error' ? 'text-red-500' : 'text-foreground'}`}>
              {spanB.duration_ms != null ? `${spanB.duration_ms}ms` : '—'}
            </span>
            {spanB.model && <span className="text-muted-foreground">{spanB.model}</span>}
            {evalB && (
              <span className={`font-semibold ${evalB.score >= 7 ? 'text-emerald-600' : evalB.score >= 5 ? 'text-amber-500' : 'text-red-500'}`}>
                {evalB.score}/10
              </span>
            )}
            {spanB.status === 'error' && (
              <span className="text-red-500 text-[10px] font-medium">✗ error</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground italic">not present</span>
        )}
      </div>
    </div>
  )
}

export default function ComparePage() {
  const params = useParams()
  const projectId = params.id as string
  const supabase = createClient()

  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedA, setSelectedA] = useState<string>('')
  const [selectedB, setSelectedB] = useState<string>('')
  const [sessionA, setSessionA] = useState<SessionWithSpans | null>(null)
  const [sessionB, setSessionB] = useState<SessionWithSpans | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch all sessions for this project
  useEffect(() => {
    async function fetchSessions() {
      const { data } = await supabase
        .from('sessions')
        .select('*')
        .eq('project_id', projectId)
        .order('started_at', { ascending: false })
        .limit(50)

      if (data) {
        setSessions(data)
        if (data.length >= 2) {
          setSelectedA(data[0].id)
          setSelectedB(data[1].id)
        }
      }
      setLoading(false)
    }
    fetchSessions()
  }, [projectId])

  // Fetch full session data when selection changes
  useEffect(() => {
    async function fetchSessionData(sessionId: string): Promise<SessionWithSpans | null> {
      const [sessionRes, spansRes] = await Promise.all([
        supabase.from('sessions').select('*').eq('id', sessionId).single(),
        supabase.from('spans').select('*').eq('session_id', sessionId).order('started_at', { ascending: true }),
      ])

      if (!sessionRes.data) return null

      const spans = spansRes.data || []
      const spanIds = spans.map(s => s.id)
      let evalScores: Record<string, EvalScore> = {}

      if (spanIds.length > 0) {
        const { data: evals } = await supabase
          .from('eval_scores')
          .select('*')
          .in('span_id', spanIds)

        if (evals) {
          evalScores = Object.fromEntries(evals.map(e => [e.span_id, e]))
        }
      }

      return { ...sessionRes.data, spans, evalScores }
    }

    if (selectedA) fetchSessionData(selectedA).then(setSessionA)
    if (selectedB) fetchSessionData(selectedB).then(setSessionB)
  }, [selectedA, selectedB])

  // Compute merged span comparison
  const comparedSpans = useMemo(() => {
    if (!sessionA || !sessionB) return []

    const spanMapA = new Map(sessionA.spans.map(s => [s.name, s]))
    const spanMapB = new Map(sessionB.spans.map(s => [s.name, s]))

    const allNames = new Set([...spanMapA.keys(), ...spanMapB.keys()])

    return Array.from(allNames).map(name => ({
      name,
      spanA: spanMapA.get(name),
      spanB: spanMapB.get(name),
      evalA: spanMapA.get(name) ? sessionA.evalScores[spanMapA.get(name)!.id] : undefined,
      evalB: spanMapB.get(name) ? sessionB.evalScores[spanMapB.get(name)!.id] : undefined,
    }))
  }, [sessionA, sessionB])

  // Compute aggregate metrics
  const metricsA = useMemo(() => {
    if (!sessionA) return { latency: 0, tokens: 0, cost: 0, errors: 0, avgScore: 0 }
    const spans = sessionA.spans
    const evals = Object.values(sessionA.evalScores)
    return {
      latency: spans.reduce((sum, s) => sum + (s.duration_ms || 0), 0),
      tokens: spans.reduce((sum, s) => sum + (s.input_tokens || 0) + (s.output_tokens || 0), 0),
      cost: spans.reduce((sum, s) => sum + (s.cost_usd || 0), 0),
      errors: spans.filter(s => s.status === 'error').length,
      avgScore: evals.length > 0 ? evals.reduce((sum, e) => sum + e.score, 0) / evals.length : 0,
    }
  }, [sessionA])

  const metricsB = useMemo(() => {
    if (!sessionB) return { latency: 0, tokens: 0, cost: 0, errors: 0, avgScore: 0 }
    const spans = sessionB.spans
    const evals = Object.values(sessionB.evalScores)
    return {
      latency: spans.reduce((sum, s) => sum + (s.duration_ms || 0), 0),
      tokens: spans.reduce((sum, s) => sum + (s.input_tokens || 0) + (s.output_tokens || 0), 0),
      cost: spans.reduce((sum, s) => sum + (s.cost_usd || 0), 0),
      errors: spans.filter(s => s.status === 'error').length,
      avgScore: evals.length > 0 ? evals.reduce((sum, e) => sum + e.score, 0) / evals.length : 0,
    }
  }, [sessionB])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
        </Link>
        <div>
          <h1
            className="text-3xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "'Clash Display', sans-serif" }}
          >
            Compare Sessions
          </h1>
          <p className="text-muted-foreground mt-1">Side-by-side session analysis for A/B testing</p>
        </div>
      </div>

      {/* Session Pickers */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
        <div className="p-4 rounded-xl border border-border bg-card">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Session A</label>
          <select
            value={selectedA}
            onChange={(e) => setSelectedA(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name || 'Unnamed'} — {new Date(s.started_at).toLocaleDateString()} ({s.span_count} spans)
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-center">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <GitCompareArrows className="w-5 h-5 text-primary" />
          </div>
        </div>

        <div className="p-4 rounded-xl border border-border bg-card">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Session B</label>
          <select
            value={selectedB}
            onChange={(e) => setSelectedB(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name || 'Unnamed'} — {new Date(s.started_at).toLocaleDateString()} ({s.span_count} spans)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Metric Comparison Cards */}
      {sessionA && sessionB && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <MetricCard
              label="Total Latency"
              valueA={metricsA.latency}
              valueB={metricsB.latency}
              format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`}
              lowerIsBetter
            />
            <MetricCard
              label="Total Tokens"
              valueA={metricsA.tokens}
              valueB={metricsB.tokens}
              format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : `${v}`}
              lowerIsBetter
            />
            <MetricCard
              label="Cost"
              valueA={metricsA.cost}
              valueB={metricsB.cost}
              format={(v) => `$${v.toFixed(4)}`}
              lowerIsBetter
            />
            <MetricCard
              label="Errors"
              valueA={metricsA.errors}
              valueB={metricsB.errors}
              format={(v) => `${v}`}
              lowerIsBetter
            />
            <MetricCard
              label="Avg Eval Score"
              valueA={metricsA.avgScore}
              valueB={metricsB.avgScore}
              format={(v) => v > 0 ? `${v.toFixed(1)}/10` : '—'}
            />
          </div>

          {/* Span-by-span Comparison Table */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            {/* Table header */}
            <div className="flex items-center bg-muted/30 border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <div className="w-[30%] px-4 py-3 border-r border-border">Span</div>
              <div className="w-[35%] px-4 py-3 border-r border-border">
                Session A
                <span className="ml-1 font-normal">({sessionA.spans.length} spans)</span>
              </div>
              <div className="w-[35%] px-4 py-3">
                Session B
                <span className="ml-1 font-normal">({sessionB.spans.length} spans)</span>
              </div>
            </div>

            {/* Rows */}
            {comparedSpans.length > 0 ? (
              comparedSpans.map((row) => (
                <SpanRow
                  key={row.name}
                  spanA={row.spanA}
                  spanB={row.spanB}
                  evalA={row.evalA}
                  evalB={row.evalB}
                />
              ))
            ) : (
              <div className="p-8 text-center text-muted-foreground text-sm">
                Select two sessions to compare
              </div>
            )}
          </div>
        </>
      )}

      {sessions.length < 2 && (
        <div className="text-center py-16 text-muted-foreground">
          <GitCompareArrows className="w-12 h-12 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium">Need at least 2 sessions to compare</p>
          <p className="text-sm mt-1">Generate demo traffic to create sample sessions.</p>
        </div>
      )}
    </div>
  )
}
