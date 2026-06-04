"use client"

import { getSpanTypeColor, cn } from '@/lib/utils'
import type { Span } from '@/types'

interface TraceTimelineProps {
  spans: Span[]
  sessionStartedAt: string
  totalDurationMs: number
  selectedSpanId: string | null
  onSelectSpan: (spanId: string) => void
}

export default function TraceTimeline({
  spans,
  sessionStartedAt,
  totalDurationMs,
  selectedSpanId,
  onSelectSpan,
}: TraceTimelineProps) {
  const sessionStart = new Date(sessionStartedAt).getTime()
  const safeTotalDuration = Math.max(totalDurationMs, 1)

  // Only show spans that have timing info
  const timedSpans = spans.filter((s) => s.started_at)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
        <span>Trace Timeline</span>
        <span>{safeTotalDuration >= 1000 ? `${(safeTotalDuration / 1000).toFixed(1)}s` : `${safeTotalDuration}ms`}</span>
      </div>
      {timedSpans.map((span) => {
        const spanStart = new Date(span.started_at).getTime() - sessionStart
        const spanDuration = span.duration_ms || (span.ended_at
          ? new Date(span.ended_at).getTime() - new Date(span.started_at).getTime()
          : safeTotalDuration * 0.05)

        const leftPercent = Math.max(0, (spanStart / safeTotalDuration) * 100)
        const widthPercent = Math.max(0.5, (spanDuration / safeTotalDuration) * 100)
        const isSelected = selectedSpanId === span.id
        const barColor = getSpanTypeColor(span.span_type)

        return (
          <div
            key={span.id}
            className="flex items-center gap-2 group cursor-pointer"
            onClick={() => onSelectSpan(span.id)}
          >
            {/* Span name label */}
            <div className="w-[120px] flex-shrink-0 text-right">
              <span className={cn(
                'text-[11px] truncate block',
                isSelected ? 'text-foreground font-medium' : 'text-muted-foreground group-hover:text-foreground'
              )}>
                {span.name.length > 20 ? span.name.slice(0, 20) + '…' : span.name}
              </span>
            </div>

            {/* Timeline bar area */}
            <div className="flex-1 relative h-6 bg-white/[0.02] rounded">
              <div
                className={cn(
                  'absolute top-0.5 bottom-0.5 rounded transition-all',
                  barColor,
                  isSelected ? 'opacity-100 ring-1 ring-white/30' : 'opacity-60 group-hover:opacity-80'
                )}
                style={{
                  left: `${leftPercent}%`,
                  width: `${Math.min(widthPercent, 100 - leftPercent)}%`,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
