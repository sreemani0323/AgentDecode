import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import ProjectCard from '@/components/dashboard/ProjectCard'
import OnboardingWizard from '@/components/dashboard/OnboardingWizard'
import StatusBadge from '@/components/sessions/StatusBadge'

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

  // Fetch recent sessions for the activity feed
  const { data: recentSessions } = await supabase
    .from('sessions')
    .select('id, name, status, started_at, project_id, projects(name)')
    .eq('projects.org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(5)

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
      {typedProjects.length > 0 ? (
        <>
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-6 rounded-xl border border-border bg-card" style={{ borderLeft: '3px solid #6366f1' }}>
              <p className="text-sm text-gray-500">Total Projects</p>
              <p className="text-foreground" style={{ fontSize: '2.5rem', fontWeight: 800, lineHeight: 1, marginTop: '8px' }}>{totalProjects}</p>
            </div>
            <div className="p-6 rounded-xl border border-border bg-card" style={{ borderLeft: '3px solid #0ea5e9' }}>
              <p className="text-sm text-gray-500">Sessions (All time)</p>
              <p className="text-foreground" style={{ fontSize: '2.5rem', fontWeight: 800, lineHeight: 1, marginTop: '8px' }}>{sessionsToday}</p>
            </div>
            <div
              className="p-6 rounded-xl border border-border bg-card"
              style={{
                borderLeft: errorsToday > 0 ? '3px solid #ef4444' : '3px solid #22c55e',
                background: errorsToday > 0 ? 'rgba(239,68,68,0.04)' : undefined,
              }}
            >
              <p className="text-sm text-gray-500">Errors (All time)</p>
              <p
                style={{
                  fontSize: '2.5rem',
                  fontWeight: 800,
                  lineHeight: 1,
                  marginTop: '8px',
                  color: errorsToday > 0 ? '#ef4444' : '#22c55e',
                }}
              >
                {errorsToday}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className={typedProjects.length < 3 ? 'lg:col-span-2' : 'lg:col-span-3'}>
              <div className={`grid gap-6 ${typedProjects.length < 3 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'}`}>
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
            </div>

            {typedProjects.length < 3 && recentSessions && recentSessions.length > 0 && (
              <div className="lg:col-span-1">
                <div className="rounded-xl border border-border bg-card p-6">
                  <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-4">Recent Activity</h3>
                  <div className="space-y-4">
                    {recentSessions.slice(0, 5).map((session: any) => (
                      <Link
                        key={session.id}
                        href={`/sessions/${session.id}`}
                        className="flex items-start gap-3 group"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                            {session.name || 'Unnamed Session'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {(session as any).projects?.name || 'Unknown project'}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <StatusBadge status={session.status} />
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(session.started_at), { addSuffix: true })}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <OnboardingWizard orgId={orgId} />
      )}
    </div>
  )
}
