/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Runs once when the Next.js server starts. Used to validate environment
 * variables and perform one-time initialisation tasks.
 *
 * This file must handle both 'nodejs' and 'edge' runtimes.
 */
export async function register() {
  // Only run the full environment check in the Node.js runtime.
  // Edge workers don't have access to all env vars and restart frequently.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { logEnvStatus, checkEnv } = await import('@/lib/env')
    const { logger } = await import('@/lib/logger')

    // Surface env status in structured logs
    logEnvStatus()

    const envResult = checkEnv()

    if (!envResult.ok) {
      // Log FATAL but do NOT throw — the app must start so the
      // /api/health endpoint can report the problem to uptime monitors.
      logger.error('FATAL: Critical environment variables are missing', {
        missing: envResult.missing.map((m) => m.key),
      })
    } else {
      logger.info('Instrumentation complete — all critical env vars present')
    }
  }
}
