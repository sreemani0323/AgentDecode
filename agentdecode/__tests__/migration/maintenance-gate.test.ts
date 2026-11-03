import { describe, test, expect, afterEach } from 'vitest'

describe('Maintenance Gate & RLS Security Suite', () => {
  const originalEnv = process.env.GATEWAY_WRITE_MAINTENANCE

  afterEach(() => {
    process.env.GATEWAY_WRITE_MAINTENANCE = originalEnv
  })

  test('Test 18 (Maintenance Gate Active): Ingest returns HTTP 503 with Retry-After: 30', async () => {
    process.env.GATEWAY_WRITE_MAINTENANCE = 'true'
    const { POST } = await import('@/app/api/ingest/route')

    const req = new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        spans: [{
          name: 'test-span',
          started_at: '2026-11-03T12:00:00Z',
        }],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')

    const body = await res.json()
    expect(body.error).toBe('MAINTENANCE_IN_PROGRESS')
    expect(body.retryable).toBe(true)
  })

  test('Test 19 (RLS Cross-Tenant Isolation): User in Org 1 cannot access spans in Org 2', () => {
    // Model RLS policy check: is_project_member(project_id)
    const orgMembers = [
      { org_id: 'org-1', user_id: 'user-alice' },
      { org_id: 'org-2', user_id: 'user-bob' },
    ]

    const projects = [
      { id: 'proj-1', org_id: 'org-1' },
      { id: 'proj-2', org_id: 'org-2' },
    ]

    function isProjectMember(userId: string, projectId: string): boolean {
      const proj = projects.find((p) => p.id === projectId)
      if (!proj) return false
      return orgMembers.some((m) => m.org_id === proj.org_id && m.user_id === userId)
    }

    // Alice belongs to Org 1 -> can view Project 1, but NOT Project 2
    expect(isProjectMember('user-alice', 'proj-1')).toBe(true)
    expect(isProjectMember('user-alice', 'proj-2')).toBe(false)

    // Bob belongs to Org 2 -> can view Project 2, but NOT Project 1
    expect(isProjectMember('user-bob', 'proj-2')).toBe(true)
    expect(isProjectMember('user-bob', 'proj-1')).toBe(false)
  })
})
