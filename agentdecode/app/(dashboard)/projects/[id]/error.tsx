'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react'

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[AgentDecode] Project page error:', error)
  }, [error])

  return (
    <div className="p-8 max-w-7xl mx-auto w-full">
      <div className="text-center max-w-md mx-auto space-y-6 py-20">
        <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto border border-red-500/20">
          <AlertTriangle className="w-7 h-7 text-red-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-foreground">Failed to load project</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We couldn&apos;t load this project. It may have been deleted or you may not have access.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Retry
          </button>
          <a
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 border border-border bg-card text-foreground hover:bg-muted transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            All Projects
          </a>
        </div>
      </div>
    </div>
  )
}
