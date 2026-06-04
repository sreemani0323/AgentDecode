export default function IssuesLoading() {
  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-8 w-32 bg-muted rounded" />
        <div className="h-4 w-64 bg-muted rounded" />
      </div>
      {/* Filter bar skeleton */}
      <div className="flex gap-3">
        <div className="h-9 w-32 bg-muted rounded" />
        <div className="h-9 w-32 bg-muted rounded" />
      </div>
      {/* Issues list skeleton */}
      <div className="space-y-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="p-5 rounded-xl border border-border bg-card flex items-center justify-between">
            <div className="space-y-2 flex-1">
              <div className="h-5 w-3/4 bg-muted rounded" />
              <div className="flex gap-4">
                <div className="h-3 w-20 bg-muted rounded" />
                <div className="h-3 w-24 bg-muted rounded" />
                <div className="h-3 w-16 bg-muted rounded" />
              </div>
            </div>
            <div className="h-6 w-16 bg-muted rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
