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

function JsonDisplay({ data }: { data: any }) {
  if (!data) return <div className="p-4 text-sm text-muted-foreground">null</div>

  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2)

  // Simple syntax coloring
  const colorized = jsonStr
    .replace(/"([^"]+)":/g, '<span style="color: #93c5fd">"$1"</span>:')
    .replace(/: "([^"]*?)"/g, ': <span style="color: #86efac">"$1"</span>')
    .replace(/: (\d+\.?\d*)/g, ': <span style="color: #fde68a">$1</span>')
    .replace(/: (true|false)/g, ': <span style="color: #c4b5fd">$1</span>')
    .replace(/: (null)/g, ': <span style="color: #9ca3af">$1</span>')

  return (
    <pre
      className="p-4 bg-background/80 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto"
      dangerouslySetInnerHTML={{ __html: colorized }}
    />
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

  // Auto-poll for eval score on LLM spans that don't have one yet
  useEffect(() => {
    if (!isLlm || evalScore) {
      setPolling(false)
      return
    }

    setPolling(true)
    const interval = setInterval(async () => {
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
  }, [span.id, isLlm, evalScore, onEvalScoreUpdate])

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

      {/* Eval score polling spinner for LLM spans without score */}
      {isLlm && !evalScore && polling && (
        <div className="p-4 rounded-lg border border-border bg-card flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Scoring in progress...</span>
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

      {showExplainButton && (
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
