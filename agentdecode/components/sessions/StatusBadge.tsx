"use client"

interface StatusBadgeProps {
  status: string
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const label =
    status === 'success' ? 'Success'
    : status === 'error' ? 'Error'
    : status === 'running' ? 'Running'
    : status === 'ok' ? 'Success'
    : status

  let style: React.CSSProperties = {}

  switch (status) {
    case 'ok':
    case 'success':
      style = { background: '#f0fdf4', color: '#16a34a', borderColor: '#bbf7d0' }
      break
    case 'error':
      style = { background: '#fef2f2', color: '#dc2626', borderColor: '#fecaca' }
      break
    case 'running':
      style = { background: '#fffbeb', color: '#d97706', borderColor: '#fde68a' }
      break
    default:
      style = { background: '#f9fafb', color: '#6b7280', borderColor: '#e5e7eb' }
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border"
      style={style}
    >
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
