import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Activity } from 'lucide-react'
import SignOutButton from '@/components/dashboard/SignOutButton'
import NavLinks from '@/components/dashboard/NavLinks'
import MobileHeader from '@/components/dashboard/MobileHeader'
import CommandPalette from '@/components/CommandPalette'
import SearchTrigger from '@/components/dashboard/SearchTrigger'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (!user || error) {
    redirect('/login')
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Mobile Header with hamburger */}
      <MobileHeader userEmail={user.email || ''} />

      {/* Desktop Sidebar */}
      <aside className="w-[240px] border-r border-border bg-card flex-col hidden md:flex">
        <div className="p-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
              <Activity className="w-5 h-5 text-primary" />
            </div>
            <span
              className="text-lg text-foreground"
              style={{ fontFamily: "'Clash Display', sans-serif", fontWeight: 700, letterSpacing: '-0.02em' }}
            >
              AgentDecode
            </span>
          </Link>
        </div>

        {/* Search shortcut hint */}
        <SearchTrigger />
        
        <NavLinks />
        
        <div className="p-4 border-t border-border mt-auto">
          <div className="px-3 mb-2">
            <p className="text-xs font-medium text-muted-foreground truncate">{user.email}</p>
          </div>
          <SignOutButton />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {children}
      </main>

      {/* Global Command Palette */}
      <CommandPalette />
    </div>
  )
}
