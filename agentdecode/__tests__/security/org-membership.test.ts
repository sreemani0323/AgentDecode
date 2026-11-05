import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Organization Membership & Invitation Security (Migration 009)', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../supabase/migrations/009_production_readiness_remediation.sql'
  )
  const migrationSql = fs.readFileSync(migrationPath, 'utf8')

  test('is_org_owner helper exists as SECURITY DEFINER with search_path = "" to prevent RLS recursion', () => {
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION public.is_org_owner(p_org_id UUID)')
    const helperMatch = migrationSql.match(
      /CREATE OR REPLACE FUNCTION public\.is_org_owner[\s\S]*?LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''[\s\S]*?\$\$;/i
    )
    expect(helperMatch).not.toBeNull()
    expect(migrationSql).toContain('REVOKE ALL ON FUNCTION public.is_org_owner(UUID) FROM PUBLIC, anon;')
    expect(migrationSql).toContain('GRANT EXECUTE ON FUNCTION public.is_org_owner(UUID) TO authenticated, service_role;')
  })

  test('org_members insertion policy strictly prohibits self-enrolment into existing orgs without RLS recursion', () => {
    expect(migrationSql).toContain(
      'DROP POLICY IF EXISTS "org_members: owners can insert members" ON public.org_members'
    )
    expect(migrationSql).toContain(
      'CREATE POLICY "org_members: owners can insert members"'
    )

    const policyExtractMatch = migrationSql.match(
      /CREATE POLICY "org_members: owners can insert members"[\s\S]*?;/
    )
    expect(policyExtractMatch).not.toBeNull()
    const policyBody = policyExtractMatch![0]

    expect(policyBody).toContain('public.is_org_owner(org_id)')
    expect(policyBody).toContain("role = 'owner'")
    expect(policyBody).toContain('NOT EXISTS')
  })

  test('org_invitations table is created with SHA-256 hashed token uniqueness and expiration', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS public.org_invitations')
    expect(migrationSql).toContain('token_hash   VARCHAR(64) NOT NULL UNIQUE')
    expect(migrationSql).toContain('expires_at   TIMESTAMPTZ NOT NULL')
    expect(migrationSql).toContain('used_at      TIMESTAMPTZ')
    expect(migrationSql).toContain('email        TEXT NOT NULL')
    expect(migrationSql).toContain('idx_org_invitations_token_hash')
  })

  test('accept_org_invitation RPC performs SHA-256 token hashing, expiration check, and email verification', () => {
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION public.accept_org_invitation')
    expect(migrationSql).toContain("encode(extensions.digest(p_token, 'sha256'), 'hex')")
    expect(migrationSql).toContain('WHERE token_hash = v_token_hash')
    expect(migrationSql).toContain('v_invitation.expires_at <= pg_catalog.clock_timestamp()')
    expect(migrationSql).toContain('v_invitation.used_at IS NOT NULL')
    expect(migrationSql).toContain('lower(trim(v_invitation.email)) <> v_user_email')
    expect(migrationSql).toContain('UPDATE public.org_invitations')
    expect(migrationSql).toContain('INSERT INTO public.org_members')
  })

  test('org_invitations table enforces strict Row Level Security for org owners via is_org_owner', () => {
    expect(migrationSql).toContain('ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;')
    expect(migrationSql).toContain(
      'CREATE POLICY "org_invitations: org owners can manage invitations"'
    )
    expect(migrationSql).toContain('USING (public.is_org_owner(org_id))')
    expect(migrationSql).toContain('WITH CHECK (public.is_org_owner(org_id))')
    expect(migrationSql).toContain('REVOKE ALL ON public.org_invitations FROM PUBLIC, anon;')
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_invitations TO authenticated, service_role;'
    )
  })
})
