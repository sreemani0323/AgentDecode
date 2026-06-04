import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip auth for /api/ingest
  if (pathname === '/api/ingest') {
    return NextResponse.next()
  }

  const { supabase, response } = await updateSession(request)

  if (!supabase) {
    return response
  }

  let user = null
  try {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser()
    user = currentUser
  } catch (error) {
    console.error('[AgentDecode Middleware] Failed to get user session:', error)
  }

  // /(dashboard) routes -> if no session, redirect to /login
  const isDashboardRoute = pathname.startsWith('/dashboard') || 
                           pathname.startsWith('/projects') || 
                           pathname.startsWith('/sessions') || 
                           pathname.startsWith('/issues') || 
                           pathname.startsWith('/settings');
  
  if (isDashboardRoute && !user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // /login and /signup -> if session exists, redirect to /dashboard
  if ((pathname === '/login' || pathname === '/signup') && user) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // all other /api/* routes -> if no session, return 401 JSON
  if (pathname.startsWith('/api/') && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
