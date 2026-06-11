import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock env check
vi.mock('@/lib/env', () => ({
  checkEnv: vi.fn(() => ({
    ok: true,
    missing: [],
    warnings: [],
  })),
}))

// Mock supabase server client
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    rpc: vi.fn(() => ({
      maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not a function' } })),
    })),
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve({ data: [{ id: 'test' }], error: null })),
      })),
    })),
  })),
}))

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('returns 200 with structured health response when everything is ok', async () => {
    const { GET } = await import('@/app/api/health/route')

    const response = await GET()
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data.status).toBe('ok')
    expect(data.version).toBe('0.1.0')
    expect(data).toHaveProperty('timestamp')
    expect(data.checks).toHaveProperty('env')
    expect(data.checks).toHaveProperty('database')
    expect(data.checks.env.status).toBe('ok')
  })

  test('returns Cache-Control no-store header', async () => {
    const { GET } = await import('@/app/api/health/route')

    const response = await GET()
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })

  test('reports env errors when required vars are missing', async () => {
    const { checkEnv } = await import('@/lib/env')
    vi.mocked(checkEnv).mockReturnValue({
      ok: false,
      missing: [{ key: 'NEXT_PUBLIC_SUPABASE_URL', description: 'test' }],
      warnings: [],
    })

    // Need to re-import to pick up the new mock
    vi.resetModules()
    vi.doMock('@/lib/env', () => ({
      checkEnv: vi.fn(() => ({
        ok: false,
        missing: [{ key: 'NEXT_PUBLIC_SUPABASE_URL', description: 'test' }],
        warnings: [],
      })),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }))
    vi.doMock('@/lib/supabase/server', () => ({
      createServiceClient: vi.fn(() => ({
        rpc: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: { message: 'err' } })),
        })),
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      })),
    }))

    const { GET } = await import('@/app/api/health/route')
    const response = await GET()
    const data = await response.json()

    expect(data.checks.env.status).toBe('error')
    expect(data.checks.env.details).toContain('NEXT_PUBLIC_SUPABASE_URL')
    // Overall status should be error when env is error
    expect(response.status).toBe(503)
  })
})
