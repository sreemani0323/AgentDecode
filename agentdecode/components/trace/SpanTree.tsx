"use client"

import { useMemo } from 'react'
import { formatDuration, getSpanTypeColor, cn } from '@/lib/utils'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import type { Span, EvalScore } from '@/types'

// Helper: find the first error span ID in a flat span list (for auto-selection)
export function getFirstErrorSpanId(spans: Span[]): string | null {
  const errorSpan = spans.find((s) => s.status === 'error')
  return errorSpan?.id ?? null
}

interface SpanTreeProps {
  spans: Span[]
  evalScores: Record<string, EvalScore>
  selectedSpanId: string | null
  onSelectSpan: (spanId: string) => void
}

interface SpanNode extends Span {
  children: SpanNode[]
  depth: number
}

// Sort helper: error spans bubble to top, then by started_at
function sortNodes(nodes: SpanNode[]): SpanNode[] {
  return [...nodes].sort((a, b) => {
    // Errors first
    const aErr = a.status === 'error' || hasErrorDescendant(a) ? 0 : 1
    const bErr = b.status === 'error' || hasErrorDescendant(b) ? 0 : 1
    if (aErr !== bErr) return aErr - bErr
    // Then by started_at
    return new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
  })
}

function hasErrorDescendant(node: SpanNode): boolean {
  if (node.status === 'error') return true
  return node.children.some(hasErrorDescendant)
}

function buildTree(spans: Span[]): SpanNode[] {
  const map = new Map<string, SpanNode>()
  const roots: SpanNode[] = []

  // Create nodes
  spans.forEach((span) => {
    map.set(span.id, { ...span, children: [], depth: 0 })
  })

  // Build tree
  spans.forEach((span) => {
    const node = map.get(span.id)!
    if (span.parent_span_id && map.has(span.parent_span_id)) {
      const parent = map.get(span.parent_span_id)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  })

  // Set depths recursively and sort children
  function setDepthsAndSort(node: SpanNode, depth: number) {
    node.depth = depth
    node.children = sortNodes(node.children)
    node.children.forEach((child) => setDepthsAndSort(child, depth + 1))
  }
  const sortedRoots = sortNodes(roots)
  sortedRoots.forEach((root) => setDepthsAndSort(root, 0))

  return sortedRoots
}

function EvalBadge({ evalScore }: { evalScore: EvalScore }) {
  const score = evalScore.score
  const flagged = evalScore.flagged

  if (score >= 7 && !flagged) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
        ✓ {score}/10
      </span>
    )
  }

  if (score >= 5 && !flagged) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
        ⚠ {score}/10
      </span>
    )
  }

  // score < 5 or flagged
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
      <span className="relative flex-shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-30 animate-ping" />
        <AlertTriangle className="relative w-3 h-3" />
      </span>
      ✗ {score}/10
    </span>
  )
}

function SpanRow({
  node,
  evalScores,
  selectedSpanId,
  onSelectSpan,
}: {
  node: SpanNode
  evalScores: Record<string, EvalScore>
  selectedSpanId: string | null
  onSelectSpan: (spanId: string) => void
}) {
  const isSelected = selectedSpanId === node.id
  const isError = node.status === 'error'
  const evalScore = evalScores[node.id]
  const isLlm = node.span_type === 'llm'
  const dotColor = getSpanTypeColor(node.span_type)

  return (
    <>
      <div
        onClick={() => onSelectSpan(node.id)}
        className={cn(
          'flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all group',
          isSelected
            ? 'bg-primary/10 border-l-2 border-primary'
            : isError
              ? 'bg-red-500/[0.04] border-l-2 border-red-500/60 hover:bg-red-500/[0.08] shadow-[inset_0_0_12px_rgba(239,68,68,0.05)]'
              : 'hover:bg-white/[0.03] border-l-2 border-transparent'
        )}
        style={{ paddingLeft: `${node.depth * 16 + 12}px` }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Colored dot */}
          <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColor)} />

          {/* Span name */}
          <span
            className={cn(
              'text-sm font-medium truncate',
              isError ? 'text-red-400' : 'text-foreground'
            )}
          >
            {node.name}
          </span>

          {/* Type badge */}
          <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded flex-shrink-0">
            {node.span_type}
          </span>

          {/* Error icon with pulse */}
          {isError && (
            <span className="relative flex-shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-30 animate-ping" />
              <AlertCircle className="relative w-3.5 h-3.5 text-red-400" />
            </span>
          )}

          {/* Eval score badge for LLM spans */}
          {isLlm && evalScore && <EvalBadge evalScore={evalScore} />}
        </div>

        {/* Duration */}
        <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
          {node.duration_ms != null ? formatDuration(node.duration_ms) : '—'}
        </span>
      </div>

      {/* Render children */}
      {node.children.map((child) => (
        <SpanRow
          key={child.id}
          node={child}
          evalScores={evalScores}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      ))}
    </>
  )
}

export default function SpanTree({ spans, evalScores, selectedSpanId, onSelectSpan }: SpanTreeProps) {
  const tree = useMemo(() => buildTree(spans), [spans])

  return (
    <div className="space-y-0.5">
      {tree.map((node) => (
        <SpanRow
          key={node.id}
          node={node}
          evalScores={evalScores}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      ))}
    </div>
  )
}
