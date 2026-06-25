"use client"

import { useState, useEffect, useCallback } from 'react'
import { formatDuration, formatCost, formatTokens, getStatusBgColor, getSpanTypeColor, cn } from '@/lib/utils'
import StatusBadge from '@/components/sessions/StatusBadge'
import AIExplanationCard from '@/components/trace/AIExplanationCard'
import { ChevronDown, ChevronRight, Loader2, Sparkles, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Span, EvalScore, AiExplanation } from '@/types'
import PromptPlayground from '@/components/trace/PromptPlayground'

interface SpanDetailPanelProps {
  span: Span
  evalScore?: EvalScore
  explanation?: AiExplanation
  onRequestExplanation: () => void
  isLoadingExplanation: boolean
  onEvalScoreUpdate?: (spanId: string, evalScore: EvalScore) => void
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-3 text-left text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/[0.02] transition-colors"
      >
        {open ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        {title}
      </button>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  )
}

/**
 * Safe recursive JSON viewer — renders each value as React elements.
 * Never uses dangerouslySetInnerHTML. Objects/arrays have expand/collapse toggles.
 */
function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth > 2)

  if (value === null || value === undefined) {
    return <span style={{ color: '#9ca3af' }}>null</span>
  }

  if (typeof value === 'string') {
    return <span style={{ color: '#86efac' }}>&quot;{value}&quot;</span>
  }

  if (typeof value === 'number') {
    return <span style={{ color: '#60a5fa' }}>{String(value)}</span>
  }

  if (typeof value === 'boolean') {
    return <span style={{ color: '#fb923c' }}>{String(value)}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span style={{ color: '#9ca3af' }}>{'[]'}</span>

    if (collapsed) {
      return (
        <span>
          <button
            onClick={() => setCollapsed(false)}
            className="text-muted-foreground hover:text-foreground mr-1 font-mono text-xs"
          >▶</button>
          <span style={{ color: '#9ca3af' }}>{'['} {value.length} items {']'}</span>
        </span>
      )
    }

    return (
      <span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-muted-foreground hover:text-foreground mr-1 font-mono text-xs"
        >▼</button>
        <span>{'['}</span>
        <span className="block">
          {value.map((item, i) => (
            <span key={i} className="block" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
              <JsonNode value={item} depth={depth + 1} />
              {i < value.length - 1 && <span style={{ color: '#9ca3af' }}>,</span>}
            </span>
          ))}
        </span>
        <span style={{ paddingLeft: `${depth * 16}px` }}>{']'}</span>
      </span>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span style={{ color: '#9ca3af' }}>{'{}'}</span>

    if (collapsed) {
      return (
        <span>
          <button
            onClick={() => setCollapsed(false)}
            className="text-muted-foreground hover:text-foreground mr-1 font-mono text-xs"
          >▶</button>
          <span style={{ color: '#9ca3af' }}>{'{'} {entries.length} keys {'}'}</span>
        </span>
      )
    }

    return (
      <span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-muted-foreground hover:text-foreground mr-1 font-mono text-xs"
        >▼</button>
        <span>{'{'}</span>
        <span className="block">
          {entries.map(([key, val], i) => (
            <span key={key} className="block" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
              <span style={{ color: '#93c5fd' }}>&quot;{key}&quot;</span>
              <span style={{ color: '#9ca3af' }}>: </span>
              <JsonNode value={val} depth={depth + 1} />
              {i < entries.length - 1 && <span style={{ color: '#9ca3af' }}>,</span>}
            </span>
          ))}
        </span>
        <span style={{ paddingLeft: `${depth * 16}px` }}>{'}'}</span>
      </span>
    )
  }

  // Fallback for unknown types
  return <span style={{ color: '#9ca3af' }}>{String(value)}</span>
}

function JsonDisplay({ data }: { data: unknown }) {
  if (data === null || data === undefined) {
    return <div className="p-4 text-sm text-muted-foreground">null</div>
  }

  // If data is a string, try to parse it as JSON for structured viewing
  let parsed: unknown = data
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch {
      // Not valid JSON — render as plain string
      return (
        <pre className="p-4 bg-background/80 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto text-foreground">
          {data}
        </pre>
      )
    }
  }

  return (
    <pre className="p-4 bg-background/80 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto">
      <JsonNode value={parsed} depth={0} />
    </pre>
  )
}

export default function SpanDetailPanel({
  span,
  evalScore,
  explanation,
  onRequestExplanation,
  isLoadingExplanation,
  onEvalScoreUpdate,
}: SpanDetailPanelProps) {
  const dotColor = getSpanTypeColor(span.span_type)
  const isError = span.status === 'error'
  const isLlm = span.span_type === 'llm'
  const isFlagged = evalScore?.flagged === true
  const showExplainButton = !explanation && (isError || isFlagged)
  const [polling, setPolling] = useState(false)
  const [showPlayground, setShowPlayground] = useState(false)
  const [evalScoringEnabled, setEvalScoringEnabled] = useState<boolean | null>(null)
  const [explanationsEnabled, setExplanationsEnabled] = useState<boolean | null>(null)
  const [pollingTimedOut, setPollingTimedOut] = useState(false)

  // Fetch feature flags on mount
  useEffect(() => {
    fetch('/api/features')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setEvalScoringEnabled(data.evalScoringEnabled)
          setExplanationsEnabled(data.explanationsEnabled)
        }
      })
      .catch(() => {
        // If /api/features fails, assume features are enabled
        setEvalScoringEnabled(true)
        setExplanationsEnabled(true)
      })
  }, [])

  // Auto-poll for eval score on LLM spans that don't have one yet
  useEffect(() => {
    if (!isLlm || evalScore || evalScoringEnabled === false) {
      setPolling(false)
      return
    }

    // Don't poll until we know feature status
    if (evalScoringEnabled === null) return

    setPolling(true)
    const startTime = Date.now()
    const TIMEOUT_MS = 30000 // Stop polling after 30 seconds

    const interval = setInterval(async () => {
      // Timeout — stop polling
      if (Date.now() - startTime > TIMEOUT_MS) {
        setPolling(false)
        setPollingTimedOut(true)
        clearInterval(interval)
        return
      }

      try {
        const res = await fetch(`/api/spans/${span.id}/eval`)
        if (res.ok) {
          const data = await res.json()
          if (data.eval_score) {
            setPolling(false)
            onEvalScoreUpdate?.(span.id, data.eval_score)
            clearInterval(interval)
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [span.id, isLlm, evalScore, onEvalScoreUpdate, evalScoringEnabled])

  return (
    <div className="space-y-6">
      {/* 1. HEADER */}
      <div className="space-y-3">
        <h2 className="text-2xl font-bold text-foreground">{span.name}</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <span className={cn('text-xs uppercase tracking-wider font-medium px-2 py-1 rounded-full border border-border', dotColor.replace('bg-', 'text-').replace('-500', '-400'), 'bg-white/5')}>
            {span.span_type}
          </span>
          <StatusBadge status={span.status} />
        </div>
        <div className="flex items-center gap-6 text-sm">
          {span.duration_ms != null && (
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Duration</span>
              <p className="text-foreground font-medium">{formatDuration(span.duration_ms)}</p>
            </div>
          )}
          {span.model && (
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Model</span>
              <p className="text-foreground font-medium">{span.model}</p>
            </div>
          )}
          {(span.input_tokens != null || span.output_tokens != null) && (
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Tokens</span>
              <p className="text-foreground font-medium">
                {formatTokens((span.input_tokens || 0) + (span.output_tokens || 0))}
                <span className="text-muted-foreground text-xs ml-1">
                  ({span.input_tokens || 0} in / {span.output_tokens || 0} out)
                </span>
              </p>
            </div>
          )}
          {span.cost_usd != null && (
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Cost</span>
              <p className="text-foreground font-medium">{formatCost(span.cost_usd)}</p>
            </div>
          )}
        </div>
      </div>

      {/* 2. EVAL SCORE */}
      {evalScore && (
        <div className="p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Eval Score</span>
            <span
              className={cn(
                'text-2xl font-bold',
                evalScore.score >= 7 ? 'text-green-400' : evalScore.score >= 5 ? 'text-yellow-400' : 'text-red-400'
              )}
            >
              {evalScore.score}/10
            </span>
          </div>
          {evalScore.reasoning && (
            <p className="text-sm text-muted-foreground">{evalScore.reasoning}</p>
          )}
          {isFlagged && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <span className="text-yellow-400 text-sm font-medium">
                ⚠ Silent failure detected — output quality is low
              </span>
            </div>
          )}
        </div>
      )}

      {/* Eval score status for LLM spans without score */}
      {isLlm && !evalScore && evalScoringEnabled === false && (
        <div className="p-4 rounded-lg border border-border bg-card">
          <span className="text-sm text-muted-foreground">
            Quality scoring is disabled. Add a free <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">GROQ_API_KEY</code> to enable this — get one at{' '}
            <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:text-primary/80">console.groq.com</a>
          </span>
        </div>
      )}

      {isLlm && !evalScore && polling && (
        <div className="p-4 rounded-lg border border-border bg-card flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Scoring in progress...</span>
        </div>
      )}

      {isLlm && !evalScore && pollingTimedOut && !polling && (
        <div className="p-4 rounded-lg border border-border bg-card">
          <span className="text-sm text-muted-foreground">
            Eval score not available for this span. This may happen with seeded data or if scoring failed.
          </span>
        </div>
      )}

      {/* 5. ERROR (show before input/output for visibility) */}
      {isError && span.error_message && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
          <span className="text-xs font-medium text-red-400 uppercase tracking-wider">Error</span>
          <p className="text-sm text-red-300 mt-1 font-mono whitespace-pre-wrap">{span.error_message}</p>
        </div>
      )}

      {/* 6. AI EXPLANATION */}
      {explanation && (
        <AIExplanationCard
          diagnosis={explanation.diagnosis}
          suggested_fix={explanation.suggested_fix}
        />
      )}

      {showExplainButton && explanationsEnabled === false && (
        <div className="p-4 rounded-lg border border-border bg-card">
          <span className="text-sm text-muted-foreground">
            AI explanations are disabled. Add a free <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">GEMINI_API_KEY</code> to enable this — get one at{' '}
            <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:text-primary/80">aistudio.google.com</a>
          </span>
        </div>
      )}

      {showExplainButton && explanationsEnabled !== false && (
        <Button
          variant="outline"
          onClick={onRequestExplanation}
          disabled={isLoadingExplanation}
          className="w-full"
        >
          {isLoadingExplanation ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Analyzing with AI...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Explain this failure
            </>
          )}
        </Button>
      )}

      {/* Debug in Playground button for LLM spans */}
      {isLlm && span.input && (
        <Button
          variant="outline"
          onClick={() => setShowPlayground(true)}
          className="w-full gap-2"
        >
          <Zap className="w-4 h-4" />
          Debug in Playground
        </Button>
      )}

      {/* Prompt Playground slide-over */}
      {showPlayground && (
        <PromptPlayground
          span={span}
          onClose={() => setShowPlayground(false)}
        />
      )}

      {/* 3. INPUT */}
      {span.input && (
        <CollapsibleSection title="Input" defaultOpen={true}>
          <JsonDisplay data={span.input} />
        </CollapsibleSection>
      )}

      {/* 4. OUTPUT */}
      {span.output && (
        <CollapsibleSection title="Output" defaultOpen={true}>
          <JsonDisplay data={span.output} />
        </CollapsibleSection>
      )}

      {/* 7. METADATA */}
      {span.metadata && Object.keys(span.metadata).length > 0 && (
        <CollapsibleSection title="Metadata" defaultOpen={false}>
          <JsonDisplay data={span.metadata} />
        </CollapsibleSection>
      )}
    </div>
  )
}
