"use client"

export default function SearchTrigger() {
  return (
    <div className="px-6 pb-3">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background/50 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
        onClick={() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
        }}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="flex-1 text-left">Search...</span>
        <kbd className="px-1.5 py-0.5 rounded bg-muted/50 border border-border text-[10px] font-mono">⌘K</kbd>
      </button>
    </div>
  )
}
