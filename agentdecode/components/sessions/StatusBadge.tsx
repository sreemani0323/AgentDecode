"use client"

import { getStatusBgColor } from '@/lib/utils'

interface StatusBadgeProps {
  status: string
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const colorClasses = getStatusBgColor(status)

  const label =
    status === 'success' ? 'Success'
    : status === 'error' ? 'Error'
    : status === 'running' ? 'Running'
    : status === 'ok' ? 'Success'
    : status

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${colorClasses}`}>
      {status === 'running' && (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-400" />
        </span>
      )}
      {label}
    </span>
  )
}
