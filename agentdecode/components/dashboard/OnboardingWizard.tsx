"use client"

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Key, Rocket, FolderPlus, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface OnboardingWizardProps {
  orgId: string
}

export default function OnboardingWizard({ orgId }: OnboardingWizardProps) {
  const router = useRouter()

  // Step state
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 state
  const [projectName, setProjectName] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)

  // Step 2 state
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)

  // Step 3 state
  const [curlCopied, setCurlCopied] = useState(false)
  const [polling, setPolling] = useState(false)
  const [traceReceived, setTraceReceived] = useState(false)

  // ── Step 1: Create project ─────────────────────────────────────
  const handleCreateProject = async () => {
    if (!projectName.trim()) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName.trim(),
          description: '',
          org_id: orgId,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create project')
      }

      const data = await res.json()
      setProjectId(data.project?.id || data.id)
      setStep(2)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2: Generate API key ───────────────────────────────────
  const handleGenerateKey = async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to generate key')
      }

      const data = await res.json()
      setApiKey(data.key)
      setStep(3)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  // ── Step 3: Poll for first trace ───────────────────────────────
  const checkForTrace = useCallback(async () => {
    if (!projectId || traceReceived) return
    try {
      const res = await fetch(`/api/projects/${projectId}`)
      if (res.ok) {
        const data = await res.json()
        const sessionCount = data.project?.stats?.total_sessions ?? 0
        if (sessionCount > 0) {
          setTraceReceived(true)
          setPolling(false)
        }
      }
    } catch {
      // Ignore polling errors
    }
  }, [projectId, traceReceived])

  useEffect(() => {
    if (step === 3 && !traceReceived) {
      setPolling(true)
      const interval = setInterval(checkForTrace, 3000)
      return () => clearInterval(interval)
    }
  }, [step, traceReceived, checkForTrace])

  // ── Curl command ───────────────────────────────────────────────
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app'
  const curlCommand = `curl -X POST ${baseUrl}/api/ingest \\
  -H "Authorization: Bearer ${apiKey || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{"session_name":"my_first_test","spans":[{"name":"llm.call","span_type":"llm","status":"ok","started_at":"2026-01-01T00:00:00Z","ended_at":"2026-01-01T00:00:01Z","model":"gpt-4o","input":{"prompt":"Hello"},"output":{"response":"Hi!"},"input_tokens":10,"output_tokens":5}]}'`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center py-8">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-5 border border-primary/20">
          <Rocket className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-2xl font-bold text-foreground mb-2">Welcome to AgentDecode</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          Get full observability for your AI agents in 3 steps. Takes about 2 minutes.
        </p>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2 max-w-lg mx-auto">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex-1 flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all ${
                s < step
                  ? 'bg-primary text-primary-foreground border-primary'
                  : s === step
                  ? 'bg-primary/10 text-primary border-primary'
                  : 'bg-muted/50 text-muted-foreground border-border'
              }`}
            >
              {s < step ? <Check className="w-4 h-4" /> : s}
            </div>
            {s < 3 && (
              <div className={`flex-1 h-0.5 rounded ${s < step ? 'bg-primary' : 'bg-border'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Error display */}
      {error && (
        <div className="max-w-lg mx-auto p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
          {error}
        </div>
      )}

      {/* Step cards */}
      <div className="max-w-lg mx-auto space-y-4">
        {/* ── Step 1: Create Project ─────────────────────────────── */}
        <div className={`rounded-xl border p-6 transition-all ${
          step === 1 ? 'border-primary bg-card shadow-sm' : step > 1 ? 'border-border bg-card/50' : 'border-border bg-muted/30 opacity-50'
        }`}>
          <div className="flex items-center gap-3 mb-4">
            <FolderPlus className={`w-5 h-5 ${step >= 1 ? 'text-primary' : 'text-muted-foreground'}`} />
            <h3 className="text-base font-semibold text-foreground">Create your first project</h3>
            {step > 1 && <Check className="w-5 h-5 text-primary ml-auto" />}
          </div>

          {step === 1 && (
            <div className="space-y-3">
              <input
                type="text"
                placeholder="e.g. Customer Support Agent"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                autoFocus
              />
              <Button
                onClick={handleCreateProject}
                disabled={!projectName.trim() || loading}
                className="w-full"
              >
                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FolderPlus className="w-4 h-4 mr-2" />}
                Create Project
              </Button>
            </div>
          )}

          {step > 1 && (
            <p className="text-sm text-muted-foreground">
              ✓ Created <span className="font-medium text-foreground">{projectName}</span>
            </p>
          )}
        </div>

        {/* ── Step 2: Get API Key ────────────────────────────────── */}
        <div className={`rounded-xl border p-6 transition-all ${
          step === 2 ? 'border-primary bg-card shadow-sm' : step > 2 ? 'border-border bg-card/50' : 'border-border bg-muted/30 opacity-50'
        }`}>
          <div className="flex items-center gap-3 mb-4">
            <Key className={`w-5 h-5 ${step >= 2 ? 'text-primary' : 'text-muted-foreground'}`} />
            <h3 className="text-base font-semibold text-foreground">Get your API key</h3>
            {step > 2 && <Check className="w-5 h-5 text-primary ml-auto" />}
          </div>

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Generate a key to authenticate trace data from your agent.
              </p>
              <Button
                onClick={handleGenerateKey}
                disabled={loading}
                className="w-full"
              >
                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Key className="w-4 h-4 mr-2" />}
                Generate API Key
              </Button>
            </div>
          )}

          {step > 2 && apiKey && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-muted/50 px-3 py-2 rounded-lg font-mono text-foreground truncate border border-border">
                  {apiKey}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(apiKey, setKeyCopied)}
                  className="shrink-0"
                >
                  {keyCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
              </div>
              <p className="text-xs text-amber-500 font-medium">
                ⚠ Save this key now — it won&apos;t be shown again.
              </p>
            </div>
          )}

          {step < 2 && (
            <p className="text-sm text-muted-foreground">Complete step 1 first</p>
          )}
        </div>

        {/* ── Step 3: Send First Trace ───────────────────────────── */}
        <div className={`rounded-xl border p-6 transition-all ${
          step === 3 ? 'border-primary bg-card shadow-sm' : 'border-border bg-muted/30 opacity-50'
        }`}>
          <div className="flex items-center gap-3 mb-4">
            <Rocket className={`w-5 h-5 ${step >= 3 ? 'text-primary' : 'text-muted-foreground'}`} />
            <h3 className="text-base font-semibold text-foreground">Send your first trace</h3>
          </div>

          {step === 3 && !traceReceived && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Run this in your terminal to send a test trace:
              </p>
              <div className="relative">
                <pre className="text-xs bg-[#1a1a1a] text-green-400 p-4 rounded-lg overflow-x-auto font-mono leading-relaxed border border-border">
                  {curlCommand}
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(curlCommand, setCurlCopied)}
                  className="absolute top-2 right-2 h-7 text-xs bg-background/80 backdrop-blur-sm"
                >
                  {curlCopied ? <><Check className="w-3 h-3 mr-1" /> Copied</> : <><Copy className="w-3 h-3 mr-1" /> Copy</>}
                </Button>
              </div>

              {/* Polling indicator */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {polling && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                <span>Waiting for your first trace…</span>
              </div>
            </div>
          )}

          {step === 3 && traceReceived && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-600 font-medium">
                <Check className="w-5 h-5" />
                <span>Trace received!</span>
              </div>
              <Button onClick={() => router.push(`/projects/${projectId}`)} className="w-full">
                <ExternalLink className="w-4 h-4 mr-2" />
                View your project dashboard
              </Button>
            </div>
          )}

          {step < 3 && (
            <p className="text-sm text-muted-foreground">Complete steps 1 and 2 first</p>
          )}
        </div>
      </div>
    </div>
  )
}
