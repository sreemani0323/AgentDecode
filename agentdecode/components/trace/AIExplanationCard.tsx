"use client"

import { Lightbulb, Wrench } from 'lucide-react'

interface AIExplanationCardProps {
  diagnosis: string
  suggested_fix: string
}

export default function AIExplanationCard({ diagnosis, suggested_fix }: AIExplanationCardProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Root Cause */}
      <div className="p-4 rounded-lg border border-border bg-card border-l-4 border-l-yellow-500">
        <div className="flex items-center gap-2 mb-2">
          <Lightbulb className="w-4 h-4 text-yellow-400" />
          <span className="text-sm font-semibold text-yellow-400 uppercase tracking-wider">Root Cause</span>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{diagnosis}</p>
      </div>

      {/* Suggested Fix */}
      <div className="p-4 rounded-lg border border-border bg-card border-l-4 border-l-green-500">
        <div className="flex items-center gap-2 mb-2">
          <Wrench className="w-4 h-4 text-green-400" />
          <span className="text-sm font-semibold text-green-400 uppercase tracking-wider">Suggested Fix</span>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{suggested_fix}</p>
      </div>
    </div>
  )
}
