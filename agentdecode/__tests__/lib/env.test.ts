import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the logger module before importing env.ts
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { checkEnv, logEnvStatus } from '@/lib/env'
import { logger } from '@/lib/logger'

describe('env validation', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    vi.stubEnv('GROQ_API_KEY', 'groq-key')
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key')
    vi.stubEnv('RESEND_API_KEY', 'resend-key')

    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('returns ok: true and empty arrays when all vars are set', () => {
    const result = checkEnv()
    expect(result.ok).toBe(true)
    expect(result.missing).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)

    logEnvStatus()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('All environment variables configured')
    )
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  test('identifies missing required variables and fails ok status', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '') // mock as empty/missing
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')

    const result = checkEnv()
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([
      { key: 'NEXT_PUBLIC_SUPABASE_URL', description: 'Supabase project URL' },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', description: 'Supabase service role key (server-only)' }
    ])
    expect(result.warnings).toHaveLength(0)

    logEnvStatus()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing required env vars'),
      expect.objectContaining({
        missing: expect.arrayContaining(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']),
      })
    )
    expect(logger.info).not.toHaveBeenCalled()
  })

  test('identifies missing optional variables and issues warnings', () => {
    vi.stubEnv('GROQ_API_KEY', '')
    vi.stubEnv('RESEND_API_KEY', '')

    const result = checkEnv()
    expect(result.ok).toBe(true) // still true because only optional variables are missing
    expect(result.missing).toHaveLength(0)
    expect(result.warnings).toEqual([
      { key: 'GROQ_API_KEY', description: 'Groq API key for LLM eval scoring (optional)' },
      { key: 'RESEND_API_KEY', description: 'Resend API key for email alerts (optional)' }
    ])

    logEnvStatus()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Optional env vars not set'),
      expect.objectContaining({
        warnings: expect.arrayContaining(['GROQ_API_KEY', 'RESEND_API_KEY']),
      })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })
})
