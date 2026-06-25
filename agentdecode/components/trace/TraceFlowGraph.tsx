"use client"

import { useCallback, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Position,
  MarkerType,
  type Node,
  type Edge,
  Handle,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Span, EvalScore } from '@/types'

// ─── Custom Node Component ───────────────────────────────────────

interface SpanNodeData {
  label: string
  spanType: string
  status: string
  durationMs: number | null
  model: string | null
  evalScore: number | null
  evalFlagged: boolean
  errorMessage: string | null
  isSelected: boolean
  [key: string]: unknown
}

function SpanNode({ data }: { data: SpanNodeData }) {
  const isError = data.status === 'error'

  // Type badge colors
  const typeColors: Record<string, { bg: string; text: string; border: string }> = {
    llm:       { bg: '#e6f3f2', text: '#197066', border: '#197066' },
    tool:      { bg: '#fef3c7', text: '#92400e', border: '#d97706' },
    agent:     { bg: '#ede9fe', text: '#5b21b6', border: '#7c3aed' },
    chain:     { bg: '#e0e7ff', text: '#3730a3', border: '#4f46e5' },
    retrieval: { bg: '#fce7f3', text: '#9d174d', border: '#db2777' },
  }

  const tc = typeColors[data.spanType] || typeColors.chain

  // Node border color based on status
  const borderColor = isError ? '#ef4444' : data.isSelected ? '#197066' : '#e5e3dc'
  const bgColor = data.isSelected ? '#f0fdfa' : '#ffffff'

  return (
    <div
      style={{
        background: bgColor,
        border: `2px solid ${borderColor}`,
        borderRadius: '12px',
        padding: '12px 16px',
        minWidth: '200px',
        maxWidth: '280px',
        fontFamily: "'Satoshi', sans-serif",
        boxShadow: data.isSelected
          ? '0 0 0 3px rgba(25, 112, 102, 0.15)'
          : '0 1px 3px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.2s, border-color 0.2s',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#197066', width: 8, height: 8, border: '2px solid #fff' }} />

      {/* Header: type badge + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '2px 8px',
            borderRadius: '4px',
            background: tc.bg,
            color: tc.text,
            border: `1px solid ${tc.border}40`,
          }}
        >
          {data.spanType}
        </span>
        {isError && (
          <span style={{ fontSize: '10px', fontWeight: 600, color: '#ef4444' }}>✗ ERROR</span>
        )}
      </div>

      {/* Name */}
      <div
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: '#1a1916',
          lineHeight: 1.3,
          marginBottom: '6px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {data.label}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        {/* Duration */}
        {data.durationMs != null && (
          <span style={{ fontSize: '11px', color: '#6b6960', fontFamily: 'monospace' }}>
            {data.durationMs >= 1000 ? `${(data.durationMs / 1000).toFixed(1)}s` : `${data.durationMs}ms`}
          </span>
        )}

        {/* Model */}
        {data.model && (
          <span style={{ fontSize: '10px', color: '#9e9b92', fontFamily: 'monospace' }}>
            {data.model}
          </span>
        )}

        {/* Eval Score */}
        {data.evalScore != null && (
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: data.evalScore >= 7 ? '#16a34a' : data.evalScore >= 5 ? '#d97706' : '#ef4444',
              fontFamily: 'monospace',
            }}
          >
            {data.evalScore}/10
          </span>
        )}
      </div>

      {/* Error message preview */}
      {isError && data.errorMessage && (
        <div
          style={{
            marginTop: '8px',
            padding: '6px 8px',
            background: '#fef2f2',
            borderRadius: '6px',
            border: '1px solid #fecaca',
            fontSize: '10px',
            color: '#991b1b',
            lineHeight: 1.4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
          }}
        >
          {data.errorMessage}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#197066', width: 8, height: 8, border: '2px solid #fff' }} />
    </div>
  )
}

const nodeTypes = { spanNode: SpanNode }

// ─── Layout algorithm (simple tree layout) ───────────────────────

function buildTree(
  spans: Span[],
  evalScores: Record<string, EvalScore>,
  selectedSpanId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  // Build parent → children map
  const childrenMap: Record<string, Span[]> = {}
  const rootSpans: Span[] = []

  for (const span of spans) {
    if (span.parent_span_id) {
      if (!childrenMap[span.parent_span_id]) childrenMap[span.parent_span_id] = []
      childrenMap[span.parent_span_id].push(span)
    } else {
      rootSpans.push(span)
    }
  }

  const nodes: Node[] = []
  const edges: Edge[] = []

  const NODE_WIDTH = 240
  const NODE_HEIGHT = 120
  const H_GAP = 40
  const V_GAP = 80

  // Calculate subtree widths for centering
  function getSubtreeWidth(spanId: string): number {
    const children = childrenMap[spanId] || []
    if (children.length === 0) return NODE_WIDTH

    const childWidths = children.map(c => getSubtreeWidth(c.id))
    return childWidths.reduce((sum, w) => sum + w, 0) + (children.length - 1) * H_GAP
  }

  // Recursive layout
  function layoutSpan(span: Span, x: number, y: number) {
    const evalScore = evalScores[span.id]

    nodes.push({
      id: span.id,
      type: 'spanNode',
      position: { x, y },
      data: {
        label: span.name,
        spanType: span.span_type,
        status: span.status,
        durationMs: span.duration_ms,
        model: span.model,
        evalScore: evalScore?.score ?? null,
        evalFlagged: evalScore?.flagged ?? false,
        errorMessage: span.error_message,
        isSelected: span.id === selectedSpanId,
      } satisfies SpanNodeData,
    })

    const children = childrenMap[span.id] || []
    if (children.length === 0) return

    // Calculate total children width
    const childWidths = children.map(c => getSubtreeWidth(c.id))
    const totalWidth = childWidths.reduce((sum, w) => sum + w, 0) + (children.length - 1) * H_GAP

    let currentX = x + NODE_WIDTH / 2 - totalWidth / 2

    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const childWidth = childWidths[i]
      const childX = currentX + childWidth / 2 - NODE_WIDTH / 2
      const childY = y + NODE_HEIGHT + V_GAP

      // Edge
      edges.push({
        id: `e-${span.id}-${child.id}`,
        source: span.id,
        target: child.id,
        type: 'smoothstep',
        animated: child.status === 'error',
        style: {
          stroke: child.status === 'error' ? '#ef4444' : '#d4d2cb',
          strokeWidth: 2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: child.status === 'error' ? '#ef4444' : '#d4d2cb',
          width: 16,
          height: 16,
        },
      })

      layoutSpan(child, childX, childY)
      currentX += childWidth + H_GAP
    }
  }

  // Layout all root spans side by side
  let rootX = 0
  for (const root of rootSpans) {
    const width = getSubtreeWidth(root.id)
    layoutSpan(root, rootX, 0)
    rootX += width + H_GAP * 2
  }

  return { nodes, edges }
}

// ─── Main Component ──────────────────────────────────────────────

interface TraceFlowGraphProps {
  spans: Span[]
  evalScores: Record<string, EvalScore>
  selectedSpanId: string | null
  onSelectSpan: (id: string) => void
}

export default function TraceFlowGraph({
  spans,
  evalScores,
  selectedSpanId,
  onSelectSpan,
}: TraceFlowGraphProps) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildTree(spans, evalScores, selectedSpanId),
    [spans, evalScores, selectedSpanId]
  )

  const [nodes, , onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState(initialEdges)

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectSpan(node.id)
    },
    [onSelectSpan]
  )

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#f7f6f3' }}
      >
        <Background color="#e5e3dc" gap={20} size={1} />
        <Controls
          showInteractive={false}
          style={{
            background: '#ffffff',
            border: '1px solid #e5e3dc',
            borderRadius: '8px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          }}
        />
        <MiniMap
          nodeColor={(node) => {
            const data = node.data as SpanNodeData
            if (data.status === 'error') return '#ef4444'
            if (data.evalFlagged) return '#d97706'
            return '#197066'
          }}
          maskColor="rgba(247, 246, 243, 0.7)"
          style={{
            background: '#ffffff',
            border: '1px solid #e5e3dc',
            borderRadius: '8px',
          }}
        />
      </ReactFlow>
    </div>
  )
}
