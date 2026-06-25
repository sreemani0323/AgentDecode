"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { format, parseISO } from 'date-fns'

interface ErrorRateDataPoint {
  date: string
  errorRate: number
  totalSessions: number
}

interface ErrorRateChartProps {
  data: ErrorRateDataPoint[]
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null

  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-xl">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-sm font-medium text-red-400">
        Error Rate: {payload[0].value.toFixed(1)}%
      </p>
      <p className="text-xs text-muted-foreground">
        {payload[0].payload.totalSessions} sessions
      </p>
    </div>
  )
}

export default function ErrorRateChart({ data }: ErrorRateChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState(0)

  const updateWidth = useCallback(() => {
    if (containerRef.current) {
      setChartWidth(containerRef.current.clientWidth)
    }
  }, [])

  useEffect(() => {
    updateWidth()
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver(() => {
      updateWidth()
    })
    observer.observe(el)

    // Also listen to window resize as fallback
    window.addEventListener('resize', updateWidth)
    // Delayed measurement to handle hydration timing
    const timer = setTimeout(updateWidth, 100)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
      clearTimeout(timer)
    }
  }, [updateWidth])

  const allZero = data.every((d) => d.totalSessions === 0)

  if (allZero) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
        No sessions in the last 7 days
      </div>
    )
  }

  const chartData = data.map((d) => ({
    ...d,
    label: format(parseISO(d.date), 'EEE'),
    fullDate: format(parseISO(d.date), 'MMM d'),
  }))

  const CHART_HEIGHT = 200

  return (
    <div ref={containerRef} style={{ width: '100%', height: CHART_HEIGHT }}>
      {chartWidth > 0 && (
        <AreaChart
          data={chartData}
          width={chartWidth}
          height={CHART_HEIGHT}
          margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
        >
          <defs>
            <linearGradient id="errorGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: '#6b7280', fontSize: 12 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: '#6b7280', fontSize: 12 }}
            domain={[0, 100]}
            tickFormatter={(value: number) => `${value}%`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="errorRate"
            stroke="#ef4444"
            strokeWidth={2}
            fill="url(#errorGradient)"
            dot={{ r: 4, fill: '#ef4444', strokeWidth: 0 }}
            activeDot={{ r: 6, fill: '#ef4444', strokeWidth: 2, stroke: '#1f2937' }}
          />
        </AreaChart>
      )}
    </div>
  )
}
