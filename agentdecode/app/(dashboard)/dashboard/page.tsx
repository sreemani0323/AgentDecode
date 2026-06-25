import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import ProjectCard from '@/components/dashboard/ProjectCard'
import OnboardingWizard from '@/components/dashboard/OnboardingWizard'

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
        <OnboardingWizard orgId={orgId} />
      )}
    </div>
  )
}
