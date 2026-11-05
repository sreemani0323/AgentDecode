import { describe, test, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import { POST as createInviteRoute, GET as getInvitesRoute } from '@/app/api/invites/route'
import { POST as acceptInviteRoute } from '@/app/api/invites/accept/route'

let mockUser: any = { id: 'owner-1', email: 'owner@example.com' }
let mockMembership: any = { role: 'owner' }
let mockOrg: any = { id: 'org-123', name: 'Acme AI' }
let mockInsertedInvitation: any = null
let mockSendEmailCalls: any[] = []
let mockRpcFn: any = vi.fn()

vi.mock('@/lib/resend', () => ({
  sendInvitationEmail: vi.fn((to: string, orgName: string, inviteUrl: string) => {
    mockSendEmailCalls.push({ to, orgName, inviteUrl })
    return Promise.resolve({ success: true })
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: mockUser }, error: null }),
    },
    from: (table: string) => ({
      select: (...args: any[]) => ({
        eq: (col: string, val: any) => ({
          single: () => {
            if (table === 'org_members') {
              return Promise.resolve({ data: mockMembership, error: null })
            }
            if (table === 'organizations') {
              return Promise.resolve({ data: mockOrg, error: null })
            }
            return Promise.resolve({ data: null, error: null })
          },
          eq: () => ({
            single: () => Promise.resolve({ data: mockMembership, error: null }),
          }),
          is: () => ({
            gt: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
    rpc: (...args: any[]) => mockRpcFn(...args),
  }),
  createServiceClient: () => ({
    from: (table: string) => ({
      insert: (record: any) => {
        mockInsertedInvitation = record
        return {
          select: () => ({
            single: () => Promise.resolve({
              data: {
                id: 'inv-123',
                org_id: record.org_id,
                email: record.email,
                role: record.role,
                expires_at: record.expires_at,
                created_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }
      },
    }),
  }),
}))

describe('Organization Invitation Lifecycle (Creation, Token Hashing & Acceptance)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendEmailCalls = []
    mockInsertedInvitation = null
    mockUser = { id: 'owner-1', email: 'owner@example.com' }
    mockMembership = { role: 'owner' }
    mockOrg = { id: 'org-123', name: 'Acme AI' }
    mockRpcFn = vi.fn()
  })

  test('Non-owner cannot issue organization invitations', async () => {
    mockMembership = { role: 'member' }

    const request = new Request('http://localhost:3000/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: 'org-123', email: 'newmember@example.com' }),
    })

    const response = await createInviteRoute(request)
    expect(response.status).toBe(403)
    const json = await response.json()
    expect(json.error).toContain('Only organization owners can create invitations')
  })

  test('Owner issues invitation: generates 32-byte entropy token, stores SHA-256 hash, delivers raw token', async () => {
    const targetEmail = 'newmember@example.com'
    const request = new Request('http://localhost:3000/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: 'org-123', email: targetEmail }),
    })

    const response = await createInviteRoute(request)
    expect(response.status).toBe(200)
    const json = await response.json()

    expect(json.success).toBe(true)
    expect(json.token).toBeDefined()
    // 32 bytes hex = 64 characters
    expect(json.token.length).toBe(64)
    expect(json.invite_url).toContain(`/invites/accept?token=${json.token}`)

    // Verify database record has SHA-256 hash, NEVER the raw plaintext token
    expect(mockInsertedInvitation).not.toBeNull()
    expect(mockInsertedInvitation.email).toBe(targetEmail)
    expect(mockInsertedInvitation.token_hash).toBeDefined()
    expect(mockInsertedInvitation.token_hash.length).toBe(64)
    expect(mockInsertedInvitation.token_hash).not.toBe(json.token)

    // Verify hash matches SHA-256 of the delivered token
    const expectedHash = crypto.createHash('sha256').update(json.token).digest('hex')
    expect(mockInsertedInvitation.token_hash).toBe(expectedHash)

    // Verify delivery via Resend to the intended recipient
    expect(mockSendEmailCalls).toHaveLength(1)
    expect(mockSendEmailCalls[0].to).toBe(targetEmail)
    expect(mockSendEmailCalls[0].orgName).toBe('Acme AI')
    expect(mockSendEmailCalls[0].inviteUrl).toBe(json.invite_url)
  })

  test('Accept invitation: succeeds and returns membership when token is valid and unexpired', async () => {
    mockUser = { id: 'invitee-1', email: 'newmember@example.com' }
    const rawToken = 'a'.repeat(64)

    mockRpcFn.mockResolvedValueOnce({
      data: {
        success: true,
        org_id: 'org-123',
        user_id: 'invitee-1',
        role: 'member',
      },
      error: null,
    })

    const request = new Request('http://localhost:3000/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken }),
    })

    const response = await acceptInviteRoute(request)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.success).toBe(true)
    expect(json.membership.role).toBe('member')

    // Verify accept_org_invitation was invoked with the raw token
    expect(mockRpcFn).toHaveBeenCalledWith('accept_org_invitation', {
      p_token: rawToken,
    })
  })

  test('Accept invitation: returns 410 when token is already used or expired', async () => {
    mockRpcFn.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invitation has already been used' },
    })

    const request = new Request('http://localhost:3000/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'used-token-123' }),
    })

    const response = await acceptInviteRoute(request)
    expect(response.status).toBe(410)
    const json = await response.json()
    expect(json.error).toContain('already been used')
  })

  test('Accept invitation: returns 403 when authenticated user email does not match invitation email', async () => {
    mockRpcFn.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invitation was issued to a different email address' },
    })

    const request = new Request('http://localhost:3000/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' }),
    })

    const response = await acceptInviteRoute(request)
    expect(response.status).toBe(403)
    const json = await response.json()
    expect(json.error).toContain('different email address')
  })
})

