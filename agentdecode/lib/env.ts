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
    console.error('\n[AgentDecode] ❌ MISSING REQUIRED ENV VARS:')
    result.missing.forEach(m => console.error(`  - ${m.key}: ${m.description}`))
  }
  
  if (result.warnings.length > 0) {
    console.warn('\n[AgentDecode] ⚠️  Optional env vars not set (features will be degraded):')
    result.warnings.forEach(w => console.warn(`  - ${w.key}: ${w.description}`))
  }
  
  if (result.ok && result.warnings.length === 0) {
    console.log('\n[AgentDecode] ✅ All environment variables configured')
  }
}
