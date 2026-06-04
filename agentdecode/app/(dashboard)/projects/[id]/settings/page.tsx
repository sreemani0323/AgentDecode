"use client"

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Plus, Copy, Check, Trash2, Key, AlertTriangle, Bell, Zap, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { generateMockTraffic } from '@/app/actions/generateMockTraffic'

interface ApiKeyRow {
  id: string
  key_prefix: string
  name: string | null
  last_used_at: string | null
  is_active: boolean
  created_at: string
}

export default function ProjectSettingsPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string

  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [showNewKeyModal, setShowNewKeyModal] = useState(false)
  const [newFullKey, setNewFullKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generatingTraffic, setGeneratingTraffic] = useState(false)
  const [trafficResult, setTrafficResult] = useState<{ sessions: number; spans: number } | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [projectName, setProjectName] = useState('')

  const fetchKeys = async () => {
    try {
      const res = await fetch(`/api/keys?project_id=${projectId}`)
      if (!res.ok) throw new Error('Failed to load keys')
      const data = await res.json()
      setKeys(data.keys || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchKeys()
    // Fetch project name for delete confirmation
    fetch(`/api/projects/${projectId}`)
      .then(res => res.json())
      .then(data => {
        if (data.project?.name) setProjectName(data.project.name)
      })
      .catch(() => {})
  }, [projectId])

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)

    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, name: keyName || undefined }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to generate key')
      }

      const data = await res.json()
      setNewFullKey(data.key)
      setShowNewKeyModal(true)
      setKeyName('')
      fetchKeys()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    try {
      const res = await fetch('/api/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to revoke key')
      }

      setConfirmRevoke(null)
      fetchKeys()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(newFullKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="p-8 max-w-4xl mx-auto w-full space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Project
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Project Settings</h1>
          <p className="text-muted-foreground mt-1">Manage API keys and alert rules.</p>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/30 border border-border w-fit">
        <div className="px-4 py-2 rounded-md bg-primary/10 text-primary text-sm font-medium">
          <Key className="w-4 h-4 inline mr-2" />
          API Keys
        </div>
        <Link href={`/projects/${projectId}/alerts`}>
          <div className="px-4 py-2 rounded-md text-muted-foreground hover:text-foreground text-sm font-medium transition-colors cursor-pointer">
            <Bell className="w-4 h-4 inline mr-2" />
            Alerts
          </div>
        </Link>
      </div>

      {/* Generate New Key */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Generate New Key</h2>
        <div className="flex items-end gap-4">
          <div className="flex-1 space-y-2">
            <Label htmlFor="keyName">Key Name (Optional)</Label>
            <Input
              id="keyName"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="e.g. Production Agent"
              className="bg-background/50"
            />
          </div>
          <Button onClick={handleGenerate} disabled={generating}>
            <Plus className="w-4 h-4 mr-2" />
            {generating ? 'Generating...' : 'Generate Key'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* New Key Modal with Integration Guide */}
      {showNewKeyModal && (
        <div className="p-6 rounded-xl border-2 border-yellow-500/30 bg-yellow-500/5 space-y-6">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-400" />
            <h3 className="text-lg font-semibold text-yellow-400">Save your API key now!</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            This key will never be shown again. Copy it and store it securely.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-3 rounded-lg bg-background border border-border text-sm font-mono text-foreground break-all">
              {newFullKey}
            </code>
            <Button variant="outline" size="sm" onClick={copyToClipboard}>
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>

          {/* Direct HTTP Integration Guide */}
          <div className="space-y-3 pt-4 border-t border-yellow-500/20">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Quick Integration
            </h4>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Send a trace from your code</p>
              <pre className="p-3 rounded-lg bg-background border border-border text-sm font-mono text-foreground overflow-x-auto leading-relaxed">
                <code>{`await fetch('${typeof window !== 'undefined' ? window.location.origin : ''}/api/ingest', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${newFullKey}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    session_name: 'My Agent',
    spans: [{
      name: 'my_llm_call',
      span_type: 'llm',
      model: 'gpt-4o',
      status: 'ok',
      started_at: new Date(Date.now() - 1000).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 1000,
      input: { prompt: 'Hello' },
      output: { response: 'Hi there!' },
    }],
  }),
})`}</code>
              </pre>
            </div>
          </div>

          <Button variant="outline" size="sm" onClick={() => setShowNewKeyModal(false)}>
            I&apos;ve saved it
          </Button>
        </div>
      )}

      {/* Existing Keys */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Existing Keys</h2>
        </div>

        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading...</div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Key className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p>No API keys yet. Generate one above to get started.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Prefix</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Last Used</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-6 py-4">
                    <code className="text-sm font-mono text-foreground">{k.key_prefix}...</code>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-sm text-muted-foreground">{k.name || '—'}</span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-sm text-muted-foreground">
                      {k.last_used_at
                        ? formatDistanceToNow(new Date(k.last_used_at), { addSuffix: true })
                        : 'Never'}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    {k.is_active ? (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                        Active
                      </span>
                    ) : (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                        Revoked
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {k.is_active && (
                      <>
                        {confirmRevoke === k.id ? (
                          <div className="inline-flex items-center gap-2">
                            <span className="text-xs text-red-400">Confirm?</span>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleRevoke(k.id)}
                            >
                              Revoke
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setConfirmRevoke(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-red-400"
                            onClick={() => setConfirmRevoke(k.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Developer Tools */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            Developer Tools
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Generate realistic demo data to populate your dashboard with sessions, traces, errors, and eval scores.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <Button
            onClick={async () => {
              setGeneratingTraffic(true)
              setTrafficResult(null)
              setError(null)
              try {
                const result = await generateMockTraffic(projectId)
                if (result.success) {
                  setTrafficResult({ sessions: result.sessionsCreated, spans: result.spansCreated })
                } else {
                  setError(result.error || 'Failed to generate mock traffic')
                }
              } catch (err: any) {
                setError(err.message || 'Failed to generate mock traffic')
              } finally {
                setGeneratingTraffic(false)
              }
            }}
            disabled={generatingTraffic}
            variant="outline"
            className="gap-2"
          >
            {generatingTraffic ? (
              <>
                <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                Generating 5 sessions...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Generate Demo Traffic
              </>
            )}
          </Button>

          {trafficResult && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="w-4 h-4" />
              Created {trafficResult.sessions} sessions with {trafficResult.spans} spans. Eval scores generating in background.
            </div>
          )}
        </div>
      </div>

      {/* ── Danger Zone ─────────────────────────────────────────── */}
      <div className="border border-red-500/30 rounded-xl bg-card/50 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-red-500/10 flex items-center justify-center">
            <Trash2 className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Danger Zone</h2>
            <p className="text-xs text-muted-foreground">
              Irreversible actions — proceed with caution
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Permanently delete this project and all its data — sessions, spans, eval scores, issues, alert rules, and API keys. This action cannot be undone.
          </p>

          {!showDeleteConfirm ? (
            <Button
              variant="destructive"
              onClick={() => setShowDeleteConfirm(true)}
              className="bg-red-600 hover:bg-red-700 text-foreground"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete this project
            </Button>
          ) : (
            <div className="space-y-3 p-4 rounded-lg border border-red-500/30 bg-red-500/5">
              <p className="text-sm text-red-400 font-medium">
                Type the project name to confirm deletion:
              </p>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="Project name"
                className="bg-background/50 border-red-500/30 focus:border-red-500"
              />
              <div className="flex items-center gap-3">
                <Button
                  variant="destructive"
                  disabled={deleteConfirmText !== projectName || deleting}
                  onClick={async () => {
                    setDeleting(true)
                    try {
                      const res = await fetch(`/api/projects/${projectId}`, {
                        method: 'DELETE',
                      })
                      if (res.ok) {
                        router.push('/dashboard')
                      } else {
                        const data = await res.json()
                        setError(data.error || 'Failed to delete project')
                        setShowDeleteConfirm(false)
                      }
                    } catch (err: any) {
                      setError(err.message || 'Failed to delete project')
                      setShowDeleteConfirm(false)
                    } finally {
                      setDeleting(false)
                      setDeleteConfirmText('')
                    }
                  }}
                  className="bg-red-600 hover:bg-red-700 text-foreground"
                >
                  {deleting ? 'Deleting...' : 'I understand, delete this project'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowDeleteConfirm(false)
                    setDeleteConfirmText('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
