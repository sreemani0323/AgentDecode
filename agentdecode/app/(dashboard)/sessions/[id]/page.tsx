"use client"

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatDuration, formatCost, formatTokens } from '@/lib/utils'
import StatusBadge from '@/components/sessions/StatusBadge'
import SpanTree, { getFirstErrorSpanId } from '@/components/trace/SpanTree'
import SpanDetailPanel from '@/components/trace/SpanDetailPanel'
import TraceTimeline from '@/components/trace/TraceTimeline'
import type { Session, Span, EvalScore, AiExplanation } from '@/types'
import { ArrowLeft, Activity, GitBranch, List } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import dynamic from 'next/dynamic'

const TraceFlowGraph = dynamic(() => import('@/components/trace/TraceFlowGraph'), { ssr: false })

export default function SessionPage() {
  const params = useParams()
  const sessionId = params.id as string
  const supabase = createClient()

  const [session, setSession] = useState<Session | null>(null)
  const [spans, setSpans] = useState<Span[]>([])
  const [evalScores, setEvalScores] = useState<Record<string, EvalScore>>({})
  const [explanations, setExplanations] = useState<Record<string, AiExplanation>>({})
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isLoadingExplanation, setIsLoadingExplanation] = useState(false)
  const [notFoundState, setNotFoundState] = useState(false)
  const [viewMode, setViewMode] = useState<'tree' | 'graph'>('tree')

  const fetchEvalScores = useCallback(async (spanIds: string[]) => {
    if (spanIds.length === 0) return

    const { data: evalData } = await supabase
      .from('eval_scores')
      .select('*')
      .in('span_id', spanIds)

    if (evalData) {
      const evalMap: Record<string, EvalScore> = {}
      evalData.forEach((e: EvalScore) => {
        evalMap[e.span_id] = e
      })
      setEvalScores(evalMap)
    }
  }, [supabase])

  useEffect(() => {
    const fetchData = async () => {
      // Fetch session
      const { data: sessionData, error: sessionError } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single()

      if (sessionError || !sessionData) {
        setNotFoundState(true)
        setLoading(false)
        return
      }

      setSession(sessionData)

      // Fetch spans
      const { data: spansData } = await supabase
        .from('spans')
        .select('*')
        .eq('session_id', sessionId)
        .order('started_at', { ascending: true })

      setSpans(spansData || [])

      // Auto-select first error span if session has errors
      if (spansData && spansData.length > 0) {
        const firstErrorId = getFirstErrorSpanId(spansData)
        if (firstErrorId) {
          setSelectedSpanId(firstErrorId)
        }
      }

      // Fetch eval scores for all spans
      if (spansData && spansData.length > 0) {
        const spanIds = spansData.map((s: Span) => s.id)

        await fetchEvalScores(spanIds)

        // Fetch AI explanations
        const { data: explanationData } = await supabase
          .from('ai_explanations')
          .select('*')
          .in('span_id', spanIds)

        if (explanationData) {
          const explMap: Record<string, AiExplanation> = {}
          explanationData.forEach((e: AiExplanation) => {
            explMap[e.span_id] = e
          })
          setExplanations(explMap)
        }
      }

      setLoading(false)
    }

    fetchData()
  }, [sessionId, fetchEvalScores])

  // Realtime subscription for new spans
  useEffect(() => {
    if (!session || session.status !== 'running') return

    const channel = supabase
      .channel(`spans-${sessionId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'spans',
        filter: `session_id=eq.${sessionId}`,
      }, (payload) => {
        const newSpan = payload.new as Span
        setSpans(prev => [...prev, newSpan])
        // Re-fetch eval scores including the new span
        fetchEvalScores([...spans.map(s => s.id), newSpan.id])
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [session?.status, sessionId, supabase, fetchEvalScores, spans])

  // Poll session data when running (for updated aggregates)
  useEffect(() => {
    if (!session || session.status !== 'running') return

    const interval = setInterval(async () => {
      const { data: sessionData } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single()

      if (sessionData) {
        setSession(sessionData)
        // If session completed, the realtime useEffect will clean up on re-render
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [session?.status, sessionId, supabase])

  const handleRequestExplanation = async () => {
    if (!selectedSpanId) return

    setIsLoadingExplanation(true)

    try {
      const res = await fetch(`/api/spans/${selectedSpanId}/explain`, {
        method: 'POST',
      })

      if (res.ok) {
        const data = await res.json()
        setExplanations((prev) => ({
          ...prev,
          [selectedSpanId]: {
            span_id: selectedSpanId,
            diagnosis: data.diagnosis,
            suggested_fix: data.suggested_fix,
            generated_at: new Date().toISOString(),
          },
        }))
      }
    } catch (err) {
      console.error('Failed to get explanation:', err)
    } finally {
      setIsLoadingExplanation(false)
    }
  }

  if (notFoundState) {
    notFound()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="text-muted-foreground">Loading session...</div>
      </div>
    )
  }

  if (!session) {
    return null
  }

  const selectedSpan = spans.find((s) => s.id === selectedSpanId) || null
  const totalDurationMs = session.ended_at && session.started_at
    ? new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()
    : null

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Top Bar */}
      <div className="flex-shrink-0 border-b border-border px-6 py-4">
        <div className="flex items-center justify-between max-w-full">
          <div className="flex items-center gap-4">
            <Link href={`/projects/${session.project_id}`}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-foreground truncate max-w-[300px]">
                {session.name || 'Unnamed Session'}
              </h1>
              <StatusBadge status={session.status} />
              {session.status === 'running' && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  Live
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/30 border border-border">
              <button
                onClick={() => setViewMode('tree')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewMode === 'tree' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                Tree
              </button>
              <button
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewMode === 'graph' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <GitBranch className="w-3.5 h-3.5" />
                Graph
              </button>
            </div>
            {totalDurationMs != null && (
              <div>
                <span className="text-xs uppercase tracking-wider font-medium">Duration</span>
                <p className="text-foreground font-medium">{formatDuration(totalDurationMs)}</p>
              </div>
            )}
            {session.total_tokens > 0 && (
              <div>
                <span className="text-xs uppercase tracking-wider font-medium">Tokens</span>
                <p className="text-foreground font-medium">{formatTokens(session.total_tokens)}</p>
              </div>
            )}
            {session.total_cost_usd > 0 && (
              <div>
                <span className="text-xs uppercase tracking-wider font-medium">Cost</span>
                <p className="text-foreground font-medium">{formatCost(session.total_cost_usd)}</p>
              </div>
            )}
            <div>
              <span className="text-xs uppercase tracking-wider font-medium">Spans</span>
              <p className="text-foreground font-medium">{session.span_count}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Trace Timeline */}
      {spans.length > 0 && session.started_at && (
        <div className="flex-shrink-0 border-b border-border px-6 py-3 bg-card/30">
          <TraceTimeline
            spans={spans}
            sessionStartedAt={session.started_at}
            totalDurationMs={totalDurationMs || 1000}
            selectedSpanId={selectedSpanId}
            onSelectSpan={setSelectedSpanId}
          />
        </div>
      )}

      {/* Two-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {viewMode === 'tree' ? (
          <>
            {/* Left panel — span tree (40%) */}
            <div className="w-[40%] border-r border-border overflow-y-auto p-4">
              {spans.length > 0 ? (
                <SpanTree
                  spans={spans}
                  evalScores={evalScores}
                  selectedSpanId={selectedSpanId}
                  onSelectSpan={setSelectedSpanId}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Activity className="w-8 h-8 mb-3 opacity-50" />
                  <p className="text-sm">No spans in this session</p>
                </div>
              )}
            </div>

            {/* Right panel — span details (60%) */}
            <div className="w-[60%] overflow-y-auto p-6">
              {selectedSpan ? (
                <SpanDetailPanel
                  span={selectedSpan}
                  evalScore={evalScores[selectedSpan.id]}
                  explanation={explanations[selectedSpan.id]}
                  onRequestExplanation={handleRequestExplanation}
                  isLoadingExplanation={isLoadingExplanation}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Activity className="w-10 h-10 mb-4 opacity-30" />
                  <p className="text-lg font-medium">Select a span to see details</p>
                  <p className="text-sm mt-1">Click on any span in the tree on the left</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Graph View — full width */}
            <div className="flex-1 relative">
              {spans.length > 0 ? (
                <TraceFlowGraph
                  spans={spans}
                  evalScores={evalScores}
                  selectedSpanId={selectedSpanId}
                  onSelectSpan={setSelectedSpanId}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Activity className="w-8 h-8 mb-3 opacity-50" />
                  <p className="text-sm">No spans in this session</p>
                </div>
              )}
            </div>

            {/* Slide-over detail panel in graph mode */}
            {selectedSpan && (
              <div className="w-[400px] border-l border-border overflow-y-auto p-6 bg-card">
                <SpanDetailPanel
                  span={selectedSpan}
                  evalScore={evalScores[selectedSpan.id]}
                  explanation={explanations[selectedSpan.id]}
                  onRequestExplanation={handleRequestExplanation}
                  isLoadingExplanation={isLoadingExplanation}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
