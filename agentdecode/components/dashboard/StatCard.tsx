import { type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  icon?: LucideIcon
}

export default function StatCard({ title, value, subtitle, trend, icon: Icon }: StatCardProps) {
  const borderColor =
    trend === 'up' ? 'border-l-green-500'
    : trend === 'down' ? 'border-l-red-500'
    : 'border-l-transparent'

  return (
    <div
      className={cn(
        'relative p-6 rounded-xl border border-border bg-card border-l-4 transition-colors',
        borderColor
      )}
    >
      {Icon && (
        <div className="absolute top-4 right-4">
          <Icon className="w-5 h-5 text-muted-foreground/50" />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-3xl font-bold text-foreground">{value}</p>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {subtitle && (
          <p className="text-xs text-muted-foreground/70">{subtitle}</p>
        )}
      </div>
    </div>
  )
}
