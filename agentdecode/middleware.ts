import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'
import { logger } from './lib/logger'

export async function middleware(request: NextRequest) {
  try {
    const { pathname } = request.nextUrl

    // Security headers applied to all responses
    const securityHeaders: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    }

    /** Apply security headers to a response and return it. */
    function withSecurityHeaders(res: NextResponse): NextResponse {
      for (const [key, value] of Object.entries(securityHeaders)) {
        res.headers.set(key, value)
      }
      return res
    }

    // Skip auth for public API endpoints
    if (pathname === '/api/ingest' || pathname === '/api/health' || pathname === '/api/docs') {
      return withSecurityHeaders(NextResponse.next())
    }

    const { supabase, response } = await updateSession(request)

    if (!supabase) {
      return withSecurityHeaders(response)
    }

    let user = null
    try {
      const {
        data: { user: currentUser },
      } = await supabase.auth.getUser()
      user = currentUser
    } catch (error) {
      logger.error('Failed to get user session', error as Error, { context: 'middleware' })
    }

    // /(dashboard) routes -> if no session, redirect to /login
    const isDashboardRoute = pathname.startsWith('/dashboard') || 
                             pathname.startsWith('/projects') || 
                             pathname.startsWith('/sessions') || 
                             pathname.startsWith('/issues') || 
                             pathname.startsWith('/settings');
    
    if (isDashboardRoute && !user) {
      const url = new URL('/login', request.url)
      return withSecurityHeaders(NextResponse.redirect(url))
    }

    // /login and /signup -> if session exists, redirect to /dashboard
    if ((pathname === '/login' || pathname === '/signup') && user) {
      const url = new URL('/dashboard', request.url)
      return withSecurityHeaders(NextResponse.redirect(url))
    }

    // all other /api/* routes -> if no session, return 401 JSON
    if (pathname.startsWith('/api/') && !user) {
      return withSecurityHeaders(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    }

    return withSecurityHeaders(response)
  } catch (globalError) {
    logger.error('Global Unhandled Exception in Middleware', globalError as Error)
    // Fail-safe: return default response to avoid breaking the application for users
    return NextResponse.next()
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
