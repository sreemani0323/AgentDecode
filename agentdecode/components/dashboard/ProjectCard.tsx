"use client"

import Link from "next/link"
import { formatDistanceToNow } from "date-fns"

interface ProjectCardProps {
  project: any; 
  sessionCount: number;
  errorCount: number;
}

export default function ProjectCard({ project, sessionCount, errorCount }: ProjectCardProps) {
  const errorRate = sessionCount > 0 ? errorCount / sessionCount : 0
  const errorPct = (errorRate * 100).toFixed(1)

  // Health banner config
  let bannerBg = ''
  let bannerBorder = ''
  let bannerText = ''
  let bannerColor = ''

  if (sessionCount === 0) {
    // No data yet
    bannerBg = '#f9fafb'
    bannerBorder = '#e5e7eb'
    bannerText = '— No sessions yet'
    bannerColor = '#6b7280'
  } else if (errorRate > 0.2) {
    bannerBg = '#fef2f2'
    bannerBorder = '#fecaca'
    bannerText = `⚠ ${errorPct}% error rate`
    bannerColor = '#dc2626'
  } else if (errorRate >= 0.05) {
    bannerBg = '#fffbeb'
    bannerBorder = '#fde68a'
    bannerText = `⚠ ${errorPct}% error rate`
    bannerColor = '#d97706'
  } else {
    bannerBg = '#f0fdf4'
    bannerBorder = '#bbf7d0'
    bannerText = '✓ Healthy'
    bannerColor = '#16a34a'
  }

  return (
    <Link href={`/projects/${project.id}`} className="block group">
      <div
        className="flex flex-col rounded-xl border border-border bg-card overflow-hidden"
        style={{
          cursor: 'pointer',
          transition: 'box-shadow 150ms ease, transform 150ms ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.04)'
          e.currentTarget.style.transform = 'translateY(-1px)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)'
          e.currentTarget.style.transform = 'translateY(0)'
        }}
      >
        <div className="p-6 flex-1 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-semibold text-foreground truncate">{project.name}</h3>
            <span
              className="transition-all duration-150 group-hover:translate-x-1"
              style={{ fontSize: '18px', color: '#6b7280' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#111827' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#6b7280' }}
            >
              →
            </span>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2 min-h-[40px]">
            {project.description || "No description provided."}
          </p>
        </div>

        <div className="px-6 pb-4 flex items-center justify-between border-t border-border pt-4">
          <div className="flex items-center gap-6">
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
              <span className="text-lg font-semibold text-foreground">{sessionCount}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Errors</span>
              <span className="text-lg font-semibold text-foreground">{errorCount}</span>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}
          </span>
        </div>

        {/* Health banner */}
        <div
          style={{
            background: bannerBg,
            borderTop: `1px solid ${bannerBorder}`,
            color: bannerColor,
            padding: '8px 24px',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {bannerText}
        </div>
      </div>
    </Link>
  )
}
