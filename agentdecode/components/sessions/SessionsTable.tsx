"use client"

import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { formatDuration, formatCost, formatTokens } from '@/lib/utils'
import StatusBadge from '@/components/sessions/StatusBadge'
import type { Session } from '@/types'

interface SessionWithQuality extends Session {
  hasLowQuality?: boolean
  hasLlmSpans?: boolean
}

interface SessionsTableProps {
  sessions: SessionWithQuality[]
}

export default function SessionsTable({ sessions }: SessionsTableProps) {
  const router = useRouter()

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Name</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Quality</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Spans</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Duration</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Cost</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Tokens</th>
            <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Time</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => {
            const durationMs = session.ended_at && session.started_at
              ? new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()
              : null

            return (
              <tr
                key={session.id}
                onClick={() => router.push(`/sessions/${session.id}`)}
                className="border-b border-border/50 last:border-b-0 hover:bg-white/[0.02] cursor-pointer transition-colors"
              >
                <td className="px-6 py-4">
                  <span className="text-sm font-medium text-foreground">
                    {session.name || 'Unnamed Session'}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <StatusBadge status={session.status} />
                </td>
                <td className="px-4 py-4">
                  {session.hasLlmSpans ? (
                    session.hasLowQuality ? (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                        ⚠ Low Quality
                      </span>
                    ) : (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                        ✓ Good
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-4">
                  <span className="text-sm text-muted-foreground">{session.span_count}</span>
                </td>
                <td className="px-4 py-4">
                  <span className="text-sm text-muted-foreground">
                    {durationMs != null ? formatDuration(durationMs) : '—'}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <span className="text-sm text-muted-foreground">
                    {session.total_cost_usd ? formatCost(session.total_cost_usd) : '—'}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <span className="text-sm text-muted-foreground">
                    {session.total_tokens ? formatTokens(session.total_tokens) : '—'}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <span className="text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(session.started_at), { addSuffix: true })}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
