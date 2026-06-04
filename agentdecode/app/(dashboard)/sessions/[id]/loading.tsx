export default function SessionLoading() {
  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-6 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="h-8 w-16 bg-muted rounded" />
          <div className="space-y-2">
            <div className="h-7 w-56 bg-muted rounded" />
            <div className="h-4 w-36 bg-muted rounded" />
          </div>
        </div>
      </div>
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="p-4 rounded-xl border border-border bg-card space-y-2">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-6 w-12 bg-muted rounded" />
          </div>
        ))}
      </div>
      {/* Span tree skeleton */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-3">
        <div className="h-5 w-24 bg-muted rounded" />
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-3" style={{ paddingLeft: `${(i % 3) * 24}px` }}>
            <div className="h-4 w-4 bg-muted rounded" />
            <div className="h-10 flex-1 bg-muted/50 rounded-lg border border-border" />
          </div>
        ))}
      </div>
    </div>
  )
}
