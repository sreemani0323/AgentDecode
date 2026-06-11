import { logger } from '@/lib/logger'

/**
 * Runtime environment validation for AgentDecode.
 * Called at startup or in API routes to surface missing config.
 */

type EnvVar = {
  key: string
  required: boolean
  description: string
}

const ENV_VARS: EnvVar[] = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', required: true, description: 'Supabase project URL' },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', required: true, description: 'Supabase anonymous key' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', required: true, description: 'Supabase service role key (server-only)' },
  { key: 'GROQ_API_KEY', required: false, description: 'Groq API key for LLM eval scoring (optional)' },
  { key: 'GEMINI_API_KEY', required: false, description: 'Google Gemini API key for AI error diagnosis (optional)' },
  { key: 'RESEND_API_KEY', required: false, description: 'Resend API key for email alerts (optional)' },
]

export type EnvCheckResult = {
  ok: boolean
  missing: { key: string; description: string }[]
  warnings: { key: string; description: string }[]
}

export function checkEnv(): EnvCheckResult {
  const missing: { key: string; description: string }[] = []
  const warnings: { key: string; description: string }[] = []

  for (const v of ENV_VARS) {
    if (!process.env[v.key]) {
      if (v.required) {
        missing.push({ key: v.key, description: v.description })
      } else {
        warnings.push({ key: v.key, description: v.description })
      }
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  }
}

/**
 * Log environment status at startup. Call from instrumentation.ts or layout.
 */
export function logEnvStatus(): void {
  const result = checkEnv()
  
  if (result.missing.length > 0) {
    logger.error('Missing required env vars', {
      missing: result.missing.map(m => m.key),
    })
  }
  
  if (result.warnings.length > 0) {
    logger.warn('Optional env vars not set (features will be degraded)', {
      warnings: result.warnings.map(w => w.key),
    })
  }
  
  if (result.ok && result.warnings.length === 0) {
    logger.info('All environment variables configured successfully')
  }
}
