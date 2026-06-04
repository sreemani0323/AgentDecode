"use client"

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Plus, Trash2, Bell, BellOff } from 'lucide-react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'

interface AlertRule {
  id: string
  project_id: string
  name: string
  metric: 'error_rate' | 'latency_p95' | 'cost_spike'
  threshold: number
  window_minutes: number
  notify_email: string
  is_active: boolean
  created_at: string
}

const metricLabels: Record<string, string> = {
  error_rate: 'Error Rate (%)',
  latency_p95: 'P95 Latency (ms)',
  cost_spike: 'Cost Spike ($)',
}

const windowOptions = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 360, label: '6 hours' },
]

export default function AlertsPage() {
  const params = useParams()
  const projectId = params.id as string

  const [rules, setRules] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [metric, setMetric] = useState('error_rate')
  const [threshold, setThreshold] = useState('')
  const [windowMinutes, setWindowMinutes] = useState('60')
  const [notifyEmail, setNotifyEmail] = useState('')

  const fetchRules = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/alerts`)
      if (!res.ok) throw new Error('Failed to load alert rules')
      const data = await res.json()
      setRules(data.rules || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRules()
  }, [projectId])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    try {
      const res = await fetch(`/api/projects/${projectId}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          metric,
          threshold: parseFloat(threshold),
          window_minutes: parseInt(windowMinutes),
          notify_email: notifyEmail,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create rule')
      }

      setName('')
      setThreshold('')
      setNotifyEmail('')
      fetchRules()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (ruleId: string) => {
    try {
      const res = await fetch(`/api/alerts/${ruleId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to delete rule')
      }
      fetchRules()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleToggle = async (ruleId: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/alerts/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !isActive }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to toggle rule')
      }
      fetchRules()
    } catch (err: any) {
      setError(err.message)
    }
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
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Alert Rules</h1>
          <p className="text-muted-foreground mt-1">Get notified when metrics exceed thresholds.</p>
        </div>
      </div>

      {/* Add Alert Rule Form */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Add Alert Rule</h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ruleName">Rule Name</Label>
              <Input
                id="ruleName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. High error rate alert"
                className="bg-background/50"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="metric">Metric</Label>
              <select
                id="metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="error_rate">Error Rate (%)</option>
                <option value="latency_p95">P95 Latency (ms)</option>
                <option value="cost_spike">Cost Spike ($)</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="threshold">Threshold</Label>
              <Input
                id="threshold"
                type="number"
                step="any"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder={metric === 'error_rate' ? '10 (for 10%)' : metric === 'latency_p95' ? '5000 (ms)' : '1.00 ($)'}
                className="bg-background/50"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="window">Time Window</Label>
              <select
                id="window"
                value={windowMinutes}
                onChange={(e) => setWindowMinutes(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {windowOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Notify Email</Label>
            <Input
              id="email"
              type="email"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              placeholder="alerts@yourcompany.com"
              className="bg-background/50"
              required
            />
          </div>
          <Button type="submit" disabled={saving}>
            <Plus className="w-4 h-4 mr-2" />
            {saving ? 'Creating...' : 'Create Alert Rule'}
          </Button>
        </form>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Existing Rules */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Active Rules</h2>
        </div>

        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading...</div>
        ) : rules.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Bell className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p>No alert rules yet. Create one above to get started.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Metric</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Threshold</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Window</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Email</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-6 py-4">
                    <span className="text-sm font-medium text-foreground">{rule.name}</span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-sm text-muted-foreground">{metricLabels[rule.metric]}</span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-sm text-muted-foreground font-mono">{rule.threshold}</span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-sm text-muted-foreground">
                      {windowOptions.find((w) => w.value === rule.window_minutes)?.label || `${rule.window_minutes}m`}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-sm text-muted-foreground truncate max-w-[200px] block">{rule.notify_email}</span>
                  </td>
                  <td className="px-4 py-4">
                    {rule.is_active ? (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">Active</span>
                    ) : (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-500/10 text-gray-400 border border-gray-500/20">Paused</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggle(rule.id, rule.is_active)}
                        title={rule.is_active ? 'Pause' : 'Activate'}
                      >
                        {rule.is_active ? (
                          <BellOff className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <Bell className="w-4 h-4 text-green-400" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-red-400"
                        onClick={() => handleDelete(rule.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
