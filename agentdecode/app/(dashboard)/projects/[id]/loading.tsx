export default function ProjectLoading() {
  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-8 animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="h-8 w-16 bg-muted rounded" />
          <div className="space-y-2">
            <div className="h-8 w-48 bg-muted rounded" />
            <div className="h-4 w-72 bg-muted rounded" />
          </div>
        </div>
        <div className="flex gap-2">
          {[...Array(5)].map((_, i) => <div key={i} className="h-9 w-24 bg-muted rounded" />)}
        </div>
      </div>
      {/* Stat cards skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="p-6 rounded-xl border border-border bg-card space-y-3">
            <div className="h-4 w-28 bg-muted rounded" />
            <div className="h-8 w-16 bg-muted rounded" />
          </div>
        ))}
      </div>
      {/* Chart skeleton */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="h-5 w-32 bg-muted rounded" />
        <div className="h-48 bg-muted rounded" />
      </div>
      {/* Table skeleton */}
      <div className="space-y-4">
        <div className="h-6 w-40 bg-muted rounded" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-14 bg-muted/50 rounded-lg border border-border" />
        ))}
      </div>
    </div>
  )
}
