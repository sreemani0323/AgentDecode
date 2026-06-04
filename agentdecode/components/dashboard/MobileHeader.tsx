"use client"

import { useState } from 'react'
import { Menu, X, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import NavLinks from '@/components/dashboard/NavLinks'
import SignOutButton from '@/components/dashboard/SignOutButton'
import Link from 'next/link'

export default function MobileHeader({ userEmail }: { userEmail: string }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      {/* Top bar — visible only on mobile */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Activity className="w-5 h-5 text-primary" />
          </div>
          <span className="font-semibold text-lg text-foreground">AgentDecode</span>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </Button>
      </div>

      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setIsOpen(false)}
          aria-hidden
        />
      )}

      {/* Slide-out sidebar panel */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[260px] bg-card border-r border-border flex flex-col transform transition-transform duration-300 ease-in-out md:hidden ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <Link href="/dashboard" className="flex items-center gap-2" onClick={() => setIsOpen(false)}>
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Activity className="w-5 h-5 text-primary" />
            </div>
            <span className="font-semibold text-lg text-foreground">AgentDecode</span>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsOpen(false)}
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Nav */}
        <div className="flex-1 py-4">
          <NavLinks onNavigate={() => setIsOpen(false)} />
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border">
          <div className="px-3 mb-2">
            <p className="text-xs font-medium text-muted-foreground truncate">{userEmail}</p>
          </div>
          <SignOutButton />
        </div>
      </aside>
    </>
  )
}
