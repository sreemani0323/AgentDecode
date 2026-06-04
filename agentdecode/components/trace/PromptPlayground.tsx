"use client"

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Play, X, RotateCcw, Clock, Cpu, Zap } from 'lucide-react'
import type { Span } from '@/types'

interface PromptPlaygroundProps {
  span: Span
  onClose: () => void
}

const MODELS = [
  { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
  { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
  { value: 'gemma2-9b-it', label: 'Gemma 2 9B' },
  { value: 'mixtral-8x7b-32768', label: 'Mixtral 8×7B' },
]

function extractMessages(input: Record<string, unknown> | null): Array<{ role: string; content: string }> {
  if (!input) return [{ role: 'user', content: '' }]

  // If input has a messages array, use it
  if (input.messages && Array.isArray(input.messages)) {
    return input.messages
      .filter((m: any) => m.role && m.content)
      .map((m: any) => ({ role: String(m.role), content: String(m.content) }))
  }

  // Fallback: wrap entire input as a user message
  return [{ role: 'user', content: JSON.stringify(input, null, 2) }]
}

export default function PromptPlayground({ span, onClose }: PromptPlaygroundProps) {
  const originalMessages = extractMessages(span.input)
  const [messages, setMessages] = useState(originalMessages)
  const [model, setModel] = useState(MODELS[0].value)
  const [temperature, setTemperature] = useState(0.7)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    content: string
    model: string
    usage: { input_tokens: number; output_tokens: number; total_tokens: number }
    duration_ms: number
    finish_reason: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRun = useCallback(async () => {
    setRunning(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/playground/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model, temperature }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Request failed')
        return
      }

      setResult(data)
    } catch (err: any) {
      setError(err.message || 'Network error')
    } finally {
      setRunning(false)
    }
  }, [messages, model, temperature])

  const handleReset = () => {
    setMessages(originalMessages)
    setResult(null)
    setError(null)
  }

  const updateMessage = (index: number, field: 'role' | 'content', value: string) => {
    setMessages(prev => prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)))
  }

  const addMessage = () => {
    setMessages(prev => [...prev, { role: 'user', content: '' }])
  }

  const removeMessage = (index: number) => {
    if (messages.length <= 1) return
    setMessages(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-label="Prompt Playground">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto w-full max-w-[900px] bg-card border-l border-border shadow-lg flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "'Clash Display', sans-serif" }}>
                Prompt Playground
              </h2>
              <p className="text-xs text-muted-foreground">
                Debugging: <span className="font-mono">{span.name}</span>
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Body — two-column layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Prompt Editor */}
          <div className="w-1/2 flex flex-col border-r border-border">
            {/* Controls */}
            <div className="px-4 py-3 border-b border-border bg-background/50 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">Model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="text-xs bg-background border border-border rounded-md px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">Temp</label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-20 h-1.5 accent-primary"
                />
                <span className="text-xs font-mono text-foreground w-7">{temperature}</span>
              </div>
            </div>

            {/* Messages editor */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((msg, i) => (
                <div key={i} className="rounded-lg border border-border overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                    <select
                      value={msg.role}
                      onChange={(e) => updateMessage(i, 'role', e.target.value)}
                      className="text-xs font-medium bg-transparent text-foreground focus:outline-none cursor-pointer"
                    >
                      <option value="system">system</option>
                      <option value="user">user</option>
                      <option value="assistant">assistant</option>
                    </select>
                    {messages.length > 1 && (
                      <button
                        onClick={() => removeMessage(i)}
                        className="text-muted-foreground hover:text-destructive transition-colors p-0.5"
                        aria-label="Remove message"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={msg.content}
                    onChange={(e) => updateMessage(i, 'content', e.target.value)}
                    className="w-full min-h-[80px] p-3 text-sm font-mono bg-card text-foreground resize-y border-0 focus:outline-none focus:ring-0"
                    placeholder="Enter message content..."
                  />
                </div>
              ))}

              <button
                onClick={addMessage}
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-lg hover:border-primary/40 transition-colors"
              >
                + Add message
              </button>
            </div>

            {/* Action bar */}
            <div className="px-4 py-3 border-t border-border bg-background/50 flex items-center gap-2">
              <Button onClick={handleRun} disabled={running} className="gap-2">
                {running ? (
                  <>
                    <span className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Run
                  </>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5">
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </Button>
            </div>
          </div>

          {/* Right: Response */}
          <div className="w-1/2 flex flex-col">
            <div className="px-4 py-3 border-b border-border bg-background/50">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Response</h3>
            </div>

            <div className="flex-1 overflow-y-auto">
              {!result && !error && !running && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
                  <Play className="w-10 h-10 mb-4 opacity-20" />
                  <p className="text-sm font-medium">Edit the prompt and click Run</p>
                  <p className="text-xs mt-1">
                    Responses are generated via Groq&apos;s free tier
                  </p>
                </div>
              )}

              {running && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <span className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
                  <p className="text-sm">Generating response...</p>
                </div>
              )}

              {error && (
                <div className="p-4 m-4 rounded-lg bg-red-500/10 border border-red-500/20">
                  <span className="text-xs font-medium text-red-500 uppercase tracking-wider">Error</span>
                  <p className="text-sm text-red-400 mt-1 font-mono whitespace-pre-wrap">{error}</p>
                </div>
              )}

              {result && (
                <div className="p-4 space-y-4">
                  {/* Response content */}
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="px-3 py-1.5 bg-muted/50 border-b border-border flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">assistant</span>
                      <span className="text-[10px] text-muted-foreground font-mono">({result.model})</span>
                    </div>
                    <div className="p-3 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                      {result.content}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg bg-muted/30 border border-border">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Clock className="w-3 h-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Latency</span>
                      </div>
                      <p className="text-sm font-semibold text-foreground">
                        {result.duration_ms >= 1000
                          ? `${(result.duration_ms / 1000).toFixed(1)}s`
                          : `${result.duration_ms}ms`}
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30 border border-border">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Cpu className="w-3 h-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Tokens</span>
                      </div>
                      <p className="text-sm font-semibold text-foreground">
                        {result.usage.total_tokens}
                        <span className="text-xs text-muted-foreground ml-1">
                          ({result.usage.input_tokens}↑ {result.usage.output_tokens}↓)
                        </span>
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30 border border-border">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Zap className="w-3 h-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Status</span>
                      </div>
                      <p className="text-sm font-semibold text-foreground capitalize">
                        {result.finish_reason}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
