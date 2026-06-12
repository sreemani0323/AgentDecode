"use client"

import { useState, useEffect, Fragment } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import {
  CheckCircle,
  EyeOff,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from "lucide-react"

interface Issue {
  id: string
  title: string
  error_fingerprint: string
  status: "open" | "resolved" | "ignored"
  occurrence_count: number
  first_seen_at: string
  last_seen_at: string
  created_at: string
  project_id: string
}

interface LinkedSpan {
  id: string
  name: string
  span_type: string
  status: string
  error_message: string | null
  session_id: string
}

interface Project {
  id: string
  name: string
}

type FilterStatus = "all" | "open" | "resolved" | "ignored"

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function GlobalIssuesPage() {
  const supabase = createClient()

  const [issues, setIssues] = useState<Issue[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterStatus>("all")
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null)
  const [linkedSpans, setLinkedSpans] = useState<LinkedSpan[]>([])
  const [loadingSpans, setLoadingSpans] = useState(false)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)

      // Get current user
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      // Get user's org
      const { data: membership } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .single()

      if (!membership) {
        setLoading(false)
        return
      }

      // Get all projects for the org
      const { data: projectData } = await supabase
        .from("projects")
        .select("id, name")
        .eq("org_id", membership.org_id)

      if (projectData) setProjects(projectData)

      if (!projectData || projectData.length === 0) {
        setLoading(false)
        return
      }

      const projectIds = projectData.map((p) => p.id)

      // Get all issues across all projects
      const { data: issueData } = await supabase
        .from("issues")
        .select("*")
        .in("project_id", projectIds)
        .order("last_seen_at", { ascending: false })

      if (issueData) setIssues(issueData)
      setLoading(false)
    }

    fetchData()
  }, [])

  const projectMap = new Map(projects.map((p) => [p.id, p.name]))

  async function handleStatusChange(issueId: string, newStatus: string) {
    const res = await fetch(`/api/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    })

    if (res.ok) {
      setIssues((prev) =>
        prev.map((i) =>
          i.id === issueId ? { ...i, status: newStatus as Issue["status"] } : i
        )
      )
    }
  }

  async function toggleExpand(issueId: string) {
    if (expandedIssueId === issueId) {
      setExpandedIssueId(null)
      setLinkedSpans([])
      return
    }

    setExpandedIssueId(issueId)
    setLoadingSpans(true)

    const { data } = await supabase
      .from("issue_spans")
      .select("span_id, spans(id, name, span_type, status, error_message, session_id)")
      .eq("issue_id", issueId)

    if (data) {
      const spans = data
        .map((row: any) => row.spans)
        .filter(Boolean) as LinkedSpan[]
      setLinkedSpans(spans)
    } else {
      setLinkedSpans([])
    }

    setLoadingSpans(false)
  }

  const filteredIssues =
    filter === "all" ? issues : issues.filter((i) => i.status === filter)

  const counts = {
    all: issues.length,
    open: issues.filter((i) => i.status === "open").length,
    resolved: issues.filter((i) => i.status === "resolved").length,
    ignored: issues.filter((i) => i.status === "ignored").length,
  }

  const filterTabs: { key: FilterStatus; label: string }[] = [
    { key: "all", label: "All" },
    { key: "open", label: "Open" },
    { key: "resolved", label: "Resolved" },
    { key: "ignored", label: "Ignored" },
  ]

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      open: "bg-red-500/10 text-red-400 border-red-500/20",
      resolved: "bg-green-500/10 text-green-400 border-green-500/20",
      ignored: "bg-gray-500/10 text-gray-400 border-gray-500/20",
    }
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${styles[status] || styles.open}`}
      >
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    )
  }

  if (loading) {
    return (
      <div className="p-8 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-4 mb-8">
          <div className="h-8 w-48 bg-muted/50 animate-pulse rounded" />
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 bg-muted/30 animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Issues</h1>
            {counts.open > 0 && (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
                {counts.open} open
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5">
            Issues across all projects
          </p>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 border-b border-border pb-0">
        {filterTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              filter === tab.key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span
              className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                filter === tab.key
                  ? "bg-primary/20 text-primary"
                  : "bg-muted/50 text-muted-foreground"
              }`}
            >
              {counts[tab.key]}
            </span>
            {filter === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Issues Table */}
      {filteredIssues.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border rounded-xl bg-card/50">
          <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">No issues detected</h3>
          <p className="text-muted-foreground">Your agents are running smoothly.</p>
        </div>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden bg-card/50">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3 w-8" />
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Title
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Project
                </th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Occurrences
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  First Seen
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Last Seen
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Status
                </th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredIssues.map((issue) => (
                <Fragment key={issue.id}>
                  <tr
                    className="hover:bg-muted/20 transition-colors cursor-pointer group"
                    onClick={() => toggleExpand(issue.id)}
                  >
                    <td className="px-4 py-3">
                      {expandedIssueId === issue.id ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">
                        {issue.title}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${issue.project_id}`}
                        className="text-sm text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {projectMap.get(issue.project_id) || "Unknown"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-sm text-muted-foreground font-mono">
                        {issue.occurrence_count}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {formatDate(issue.first_seen_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {formatDate(issue.last_seen_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3">{statusBadge(issue.status)}</td>
                    <td className="px-4 py-3 text-right">
                      <div
                        className="flex items-center justify-end gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {issue.status === "open" && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-green-400 border-green-500/30 hover:bg-green-500/10 h-7 text-xs"
                              onClick={() => handleStatusChange(issue.id, "resolved")}
                            >
                              <CheckCircle className="w-3.5 h-3.5 mr-1" />
                              Resolve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-gray-400 border-gray-500/30 hover:bg-gray-500/10 h-7 text-xs"
                              onClick={() => handleStatusChange(issue.id, "ignored")}
                            >
                              <EyeOff className="w-3.5 h-3.5 mr-1" />
                              Ignore
                            </Button>
                          </>
                        )}
                        {(issue.status === "resolved" || issue.status === "ignored") && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10 h-7 text-xs"
                            onClick={() => handleStatusChange(issue.id, "open")}
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1" />
                            Reopen
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedIssueId === issue.id && (
                    <tr key={`${issue.id}-expanded`}>
                      <td colSpan={8} className="bg-muted/10 px-4 py-4">
                        <div className="pl-8">
                          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                            Linked Spans
                          </h4>
                          {loadingSpans ? (
                            <div className="space-y-2">
                              {[...Array(3)].map((_, i) => (
                                <div
                                  key={i}
                                  className="h-8 bg-muted/30 animate-pulse rounded"
                                />
                              ))}
                            </div>
                          ) : linkedSpans.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              No linked spans found for this issue.
                            </p>
                          ) : (
                            <table className="w-full">
                              <thead>
                                <tr className="border-b border-border/50">
                                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">
                                    Span Name
                                  </th>
                                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">
                                    Type
                                  </th>
                                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">
                                    Status
                                  </th>
                                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">
                                    Error Message
                                  </th>
                                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">
                                    Session
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/30">
                                {linkedSpans.map((span) => (
                                  <tr
                                    key={span.id}
                                    className="hover:bg-muted/10 transition-colors"
                                  >
                                    <td className="px-3 py-2 text-sm text-foreground font-mono">
                                      {span.name}
                                    </td>
                                    <td className="px-3 py-2">
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                                        {span.span_type}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-sm text-muted-foreground">
                                      {span.status}
                                    </td>
                                    <td className="px-3 py-2 text-sm text-muted-foreground max-w-xs truncate">
                                      {span.error_message || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      <Link
                                        href={`/sessions/${span.session_id}`}
                                        className="text-xs text-primary hover:underline"
                                      >
                                        View Session →
                                      </Link>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
