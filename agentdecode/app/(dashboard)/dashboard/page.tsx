import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Plus, FolderOpen } from 'lucide-react'
import ProjectCard from '@/components/dashboard/ProjectCard'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Get org_id from org_members
  const { data: orgMember } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!orgMember) {
    return <div className="p-8 text-foreground">No organization found. Please ensure your account setup is complete.</div>
  }

  const orgId = orgMember.org_id

  // Fetch projects for that org
  const { data: projects, error } = await supabase
    .from('projects')
    .select(`
      *,
      sessions (id, error_count)
    `)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error(error)
  }

  const typedProjects = projects || []
  
  // Calculate stats
  const totalProjects = typedProjects.length
  let sessionsToday = 0
  let errorsToday = 0

  typedProjects.forEach(p => {
    sessionsToday += p.sessions?.length || 0
    p.sessions?.forEach((s: any) => {
      errorsToday += s.error_count || 0
    })
  })

  return (
    <div className="p-8 max-w-7xl mx-auto w-full space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="text-muted-foreground mt-1">Manage your AgentDecode observability projects.</p>
        </div>
        <Link href="/projects/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            New Project
          </Button>
        </Link>
      </div>

      {typedProjects.length > 0 ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="text-sm font-medium text-muted-foreground">Total Projects</h3>
              <p className="text-3xl font-bold text-foreground mt-2">{totalProjects}</p>
            </div>
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="text-sm font-medium text-muted-foreground">Sessions (All time)</h3>
              <p className="text-3xl font-bold text-foreground mt-2">{sessionsToday}</p>
            </div>
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="text-sm font-medium text-muted-foreground">Errors (All time)</h3>
              <p className="text-3xl font-bold text-red-400 mt-2">{errorsToday}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {typedProjects.map((project) => {
              const sessionCount = project.sessions?.length || 0
              const errorCount = project.sessions?.reduce((acc: number, s: any) => acc + (s.error_count || 0), 0) || 0
              
              return (
                <ProjectCard 
                  key={project.id} 
                  project={project} 
                  sessionCount={sessionCount} 
                  errorCount={errorCount} 
                />
              )
            })}
          </div>
        </>
      ) : (
        <div className="space-y-8">
          {/* Welcome Hero */}
          <div className="text-center py-12 px-8 rounded-2xl border border-border bg-gradient-to-b from-primary/5 to-transparent">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6 border border-primary/20">
              <FolderOpen className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-3">Welcome to AgentDecode</h2>
            <p className="text-muted-foreground max-w-lg mx-auto text-base leading-relaxed">
              Start observing your AI agents in 3 simple steps. Full visibility into every LLM call, tool execution, and decision — completely free.
            </p>
            <Link href="/projects/new">
              <Button className="mt-8 h-11 px-8 text-base">
                <Plus className="w-5 h-5 mr-2" />
                Create Your First Project
              </Button>
            </Link>
          </div>

          {/* 3-Step Guide */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-xl border border-border bg-card relative">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center mb-4 border border-primary/20">1</div>
              <h3 className="text-base font-semibold text-foreground mb-2">Create a Project</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Each project maps to one AI agent or service. You&apos;ll get dedicated API keys and a private dashboard.
              </p>
            </div>
            <div className="p-6 rounded-xl border border-border bg-card relative">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center mb-4 border border-primary/20">2</div>
              <h3 className="text-base font-semibold text-foreground mb-2">Get Your API Key</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Generate a secure API key in your project settings. This authenticates your SDK telemetry.
              </p>
            </div>
            <div className="p-6 rounded-xl border border-border bg-card relative">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center mb-4 border border-primary/20">3</div>
              <h3 className="text-base font-semibold text-foreground mb-2">Send Traces</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Connect via direct HTTP calls or use the <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded font-mono">@agentdecode/sdk</code>. Start seeing traces instantly.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
