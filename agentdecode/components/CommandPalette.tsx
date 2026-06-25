"use client"

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Search, ArrowRight, Activity, AlertCircle, Cpu, Command } from 'lucide-react'

interface SearchResult {
  type: 'session' | 'span' | 'issue'
  id: string
  title: string
  subtitle: string
  status: string
  href: string
  projectId: string
}

const TYPE_CONFIG = {
  session: { icon: Activity, label: 'Session', color: '#197066' },
  span: { icon: Cpu, label: 'Span', color: '#2563eb' },
  issue: { icon: AlertCircle, label: 'Issue', color: '#d97706' },
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // ⌘K / Ctrl+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
      setQuery('')
      setResults([])
      setSelectedIndex(0)
    }
  }, [open])

  // Debounced search
  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([])
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.results || [])
        setSelectedIndex(0)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  const handleInputChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(value), 250)
  }

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault()
      navigate(results[selectedIndex])
    }
  }

  const navigate = (result: SearchResult) => {
    setOpen(false)
    router.push(result.href)
  }

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!open) return null

  // Group results by type
  const grouped: Record<string, SearchResult[]> = {}
  for (const r of results) {
    if (!grouped[r.type]) grouped[r.type] = []
    grouped[r.type].push(r)
  }

  let flatIndex = 0

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-label="Command Palette">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={() => setOpen(false)}
      />

      {/* Modal */}
      <div className="absolute top-[20%] left-1/2 -translate-x-1/2 w-full max-w-[580px] mx-auto">
        <div
          className="bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
          style={{ fontFamily: "'Satoshi', sans-serif" }}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <Search className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search sessions, spans, issues..."
              className="flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
            {loading && (
              <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            <button
              onClick={() => setOpen(false)}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/50 border border-border text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              ESC
            </button>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[360px] overflow-y-auto">
            {query.length >= 2 && results.length === 0 && !loading && (
              <div className="py-12 text-center text-muted-foreground">
                <Search className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">No results for &ldquo;{query}&rdquo;</p>
                <p className="text-xs mt-1">Try a different search term</p>
              </div>
            )}

            {query.length < 2 && (
              <div className="py-12 text-center text-muted-foreground">
                <Command className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <p className="text-sm">Start typing to search</p>
                <p className="text-xs mt-2 opacity-60">
                  Search across sessions, spans, and issues
                </p>
              </div>
            )}

            {Object.entries(grouped).map(([type, items]) => {
              const config = TYPE_CONFIG[type as keyof typeof TYPE_CONFIG]
              const Icon = config.icon

              return (
                <div key={type}>
                  {/* Group header */}
                  <div className="px-4 py-2 bg-muted/20 border-b border-border">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {config.label}s
                    </span>
                  </div>

                  {/* Items */}
                  {items.map((item) => {
                    const currentIndex = flatIndex++
                    const isSelected = currentIndex === selectedIndex

                    return (
                      <button
                        key={item.id}
                        data-index={currentIndex}
                        onClick={() => navigate(item)}
                        onMouseEnter={() => setSelectedIndex(currentIndex)}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                          isSelected ? 'bg-primary/5' : 'hover:bg-muted/30'
                        }`}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: `${config.color}12` }}
                        >
                          <Icon className="w-4 h-4" style={{ color: config.color }} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {item.title}
                          </p>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {item.subtitle}
                          </p>
                        </div>

                        {/* Status badge */}
                        {item.status === 'error' && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/20 flex-shrink-0">
                            error
                          </span>
                        )}

                        {isSelected && (
                          <ArrowRight className="w-4 h-4 text-primary flex-shrink-0" />
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border bg-muted/10 flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-muted/50 border border-border font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-muted/50 border border-border font-mono">↵</kbd>
              open
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-muted/50 border border-border font-mono">esc</kbd>
              close
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
