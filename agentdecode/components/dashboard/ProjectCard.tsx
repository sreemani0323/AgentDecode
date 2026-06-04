"use client"

import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"

interface ProjectCardProps {
  project: any; 
  sessionCount: number;
  errorCount: number;
}

export default function ProjectCard({ project, sessionCount, errorCount }: ProjectCardProps) {
  const errorRate = sessionCount > 0 ? errorCount / sessionCount : 0
  
  let errorRateClass = "bg-gray-500/10 text-gray-400"
  if (sessionCount > 0) {
    if (errorRate > 0.1) errorRateClass = "bg-red-500/10 text-red-400"
    else if (errorRate < 0.05) errorRateClass = "bg-green-500/10 text-green-400"
    else errorRateClass = "bg-yellow-500/10 text-yellow-400"
  }

  return (
    <div className="group flex flex-col p-6 rounded-xl border border-border bg-card hover:border-primary/50 transition-colors">
      <div className="flex-1 space-y-2">
        <h3 className="text-xl font-bold text-foreground truncate">{project.name}</h3>
        <p className="text-sm text-muted-foreground line-clamp-2 min-h-[40px]">
          {project.description || "No description provided."}
        </p>
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
            <span className="text-lg font-semibold text-foreground">{sessionCount}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Errors</span>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-foreground">{errorCount}</span>
              {sessionCount > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${errorRateClass}`}>
                  {(errorRate * 100).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Created {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}
        </span>
        <Link href={`/projects/${project.id}`}>
          <Button variant="outline" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
            View Project
          </Button>
        </Link>
      </div>
    </div>
  )
}
