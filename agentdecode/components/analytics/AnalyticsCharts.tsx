"use client"

import {
  AreaChart, Area,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
  Legend,
} from 'recharts'

// ─── Types ───────────────────────────────────────────────────────

interface AnalyticsChartsProps {
  costByModel: Array<{ model: string; cost: number }>
  spanTypeData: Array<{ type: string; count: number }>
  latencyTrend: Array<{ date: string; label: string; p50: number; p95: number; count: number }>
  scoreBuckets: Array<{ range: string; count: number; label: string }>
  costTrend: Array<{ date: string; label: string; cost: number }>
}

// ─── Color palettes ──────────────────────────────────────────────

const MODEL_COLORS = ['#197066', '#d97706', '#2563eb', '#db2777', '#7c3aed', '#059669', '#dc2626']

const SPAN_TYPE_COLORS: Record<string, string> = {
  llm: '#197066',
  tool: '#d97706',
  agent: '#7c3aed',
  chain: '#2563eb',
  retrieval: '#db2777',
}

// ─── Custom Tooltip ──────────────────────────────────────────────

function ChartTooltip({ active, payload, label, suffix }: any) {
  if (!active || !payload?.length) return null

  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-lg text-xs">
      <p className="text-muted-foreground mb-1.5 font-medium">{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} className="text-foreground" style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}{suffix || ''}
        </p>
      ))}
    </div>
  )
}

// ─── Section wrapper ─────────────────────────────────────────────

function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────

export default function AnalyticsCharts({
  costByModel,
  spanTypeData,
  latencyTrend,
  scoreBuckets,
  costTrend,
}: AnalyticsChartsProps) {
  const hasData = costByModel.length > 0 || spanTypeData.length > 0

  if (!hasData) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        <p className="text-lg font-medium">No data yet</p>
        <p className="text-sm mt-1">Generate demo traffic or start sending traces to see analytics.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Row 1: Cost by Model + Span Type Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Model — Donut Chart */}
        <ChartSection title="Cost by Model">
          {costByModel.length > 0 ? (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie
                    data={costByModel}
                    dataKey="cost"
                    nameKey="model"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                    strokeWidth={0}
                  >
                    {costByModel.map((_, i) => (
                      <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']}
                    contentStyle={{
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2">
                {costByModel.map((item, i) => (
                  <div key={item.model} className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-sm flex-shrink-0"
                      style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
                    />
                    <span className="text-xs text-muted-foreground truncate flex-1 font-mono">{item.model}</span>
                    <span className="text-xs font-semibold text-foreground">${item.cost.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground h-[200px] flex items-center justify-center">No cost data</p>
          )}
        </ChartSection>

        {/* Span Type Distribution — Bar Chart */}
        <ChartSection title="Span Type Distribution">
          {spanTypeData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={spanTypeData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e3dc" />
                <XAxis
                  dataKey="type"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#6b6960', fontSize: 11 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#6b6960', fontSize: 11 }}
                />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                  {spanTypeData.map((entry) => (
                    <Cell key={entry.type} fill={SPAN_TYPE_COLORS[entry.type] || '#6b6960'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground h-[200px] flex items-center justify-center">No span data</p>
          )}
        </ChartSection>
      </div>

      {/* Row 2: Latency Trend + Cost Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Latency P50/P95 Trend */}
        <ChartSection title="Latency Trend (P50 / P95)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={latencyTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="p50Gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#197066" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#197066" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="p95Gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#d97706" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#d97706" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e3dc" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#6b6960', fontSize: 10 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#6b6960', fontSize: 10 }}
                tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`}
              />
              <Tooltip content={<ChartTooltip suffix="ms" />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: '11px', color: '#6b6960' }}
              />
              <Area
                type="monotone"
                dataKey="p50"
                name="P50"
                stroke="#197066"
                strokeWidth={2}
                fill="url(#p50Gradient)"
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="p95"
                name="P95"
                stroke="#d97706"
                strokeWidth={2}
                fill="url(#p95Gradient)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartSection>

        {/* Daily Cost Trend */}
        <ChartSection title="Daily Cost">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={costTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e3dc" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#6b6960', fontSize: 10 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#6b6960', fontSize: 10 }}
                tickFormatter={(v: number) => `$${v.toFixed(3)}`}
              />
              <Tooltip
                formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']}
                contentStyle={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Area
                type="monotone"
                dataKey="cost"
                name="Cost"
                stroke="#2563eb"
                strokeWidth={2}
                fill="url(#costGradient)"
                dot={{ r: 3, fill: '#2563eb', strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartSection>
      </div>

      {/* Row 3: Eval Score Distribution */}
      <ChartSection title="Eval Score Distribution">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={scoreBuckets} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e3dc" />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6b6960', fontSize: 11 }}
              label={{ value: 'Score', position: 'insideBottom', offset: -5, style: { fill: '#9e9b92', fontSize: 10 } }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6b6960', fontSize: 11 }}
              label={{ value: 'Count', angle: -90, position: 'insideLeft', offset: 30, style: { fill: '#9e9b92', fontSize: 10 } }}
            />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="count" name="Spans" radius={[4, 4, 0, 0]}>
              {scoreBuckets.map((entry, i) => {
                const score = parseInt(entry.label)
                const color = score >= 7 ? '#059669' : score >= 5 ? '#d97706' : '#ef4444'
                return <Cell key={i} fill={color} />
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>
    </div>
  )
}
