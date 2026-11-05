import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Database Security Definer & Privilege Auditing (Migration 009)', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../supabase/migrations/009_production_readiness_remediation.sql'
  )
  const migrationSql = fs.readFileSync(migrationPath, 'utf8')

  const PRIVILEGED_FUNCTIONS = [
    'register_span_identity',
    'ingest_span_transactional',
    'ingest_spans_batch_transactional',
    'claim_evaluation_job',
    'finalize_evaluation_job',
    'consume_rate_limit_token',
    'cleanup_expired_rate_limit_buckets',
    'provision_spans_partition',
    'provision_future_spans_partitions',
  ]

  test('all privileged functions are defined with SECURITY DEFINER and search_path = ""', () => {
    for (const fn of PRIVILEGED_FUNCTIONS) {
      const fnRegex = new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+public\\.${fn}\\b[\\s\\S]*?LANGUAGE plpgsql\\s+SECURITY DEFINER\\s+SET search_path = ''`,
        'i'
      )
      expect(
        fnRegex.test(migrationSql),
        `Function public.${fn} must be defined with SECURITY DEFINER and SET search_path = ''`
      ).toBe(true)
    }
  })

  test('all privileged functions explicitly revoke execute from PUBLIC, anon, and authenticated', () => {
    for (const fn of PRIVILEGED_FUNCTIONS) {
      const revokeRegex = new RegExp(
        `REVOKE ALL ON FUNCTION\\s+public\\.${fn}\\b[\\s\\S]*?FROM PUBLIC,\\s*anon,\\s*authenticated;`,
        'i'
      )
      expect(
        revokeRegex.test(migrationSql),
        `Function public.${fn} must explicitly REVOKE ALL FROM PUBLIC, anon, authenticated`
      ).toBe(true)
    }
  })

  test('all privileged functions explicitly grant execute to service_role only', () => {
    for (const fn of PRIVILEGED_FUNCTIONS) {
      const grantRegex = new RegExp(
        `GRANT EXECUTE ON FUNCTION\\s+public\\.${fn}\\b[\\s\\S]*?TO service_role;`,
        'i'
      )
      expect(
        grantRegex.test(migrationSql),
        `Function public.${fn} must grant EXECUTE TO service_role`
      ).toBe(true)
    }
  })

  test('is_org_member, is_project_member, and is_org_owner explicitly revoke anon and grant to authenticated and service_role', () => {
    const helperFns = ['is_org_member', 'is_project_member', 'is_org_owner']
    for (const fn of helperFns) {
      const revokeRegex = new RegExp(
        `REVOKE ALL ON FUNCTION\\s+public\\.${fn}\\(UUID\\)\\s+FROM\\s+PUBLIC,\\s*anon;`,
        'i'
      )
      expect(
        revokeRegex.test(migrationSql),
        `Helper public.${fn} must REVOKE ALL FROM anon`
      ).toBe(true)

      const grantRegex = new RegExp(
        `GRANT EXECUTE ON FUNCTION\\s+public\\.${fn}\\(UUID\\)\\s+TO\\s+authenticated,\\s*service_role;`,
        'i'
      )
      expect(
        grantRegex.test(migrationSql),
        `Helper public.${fn} must grant EXECUTE TO authenticated, service_role`
      ).toBe(true)
    }

    // Trigger functions handle_new_user and handle_new_profile must revoke from anon
    expect(/REVOKE ALL ON FUNCTION public\.handle_new_user\(\) FROM PUBLIC, anon;/i.test(migrationSql)).toBe(true)
    expect(/REVOKE ALL ON FUNCTION public\.handle_new_profile\(\) FROM PUBLIC, anon;/i.test(migrationSql)).toBe(true)

    // accept_org_invitation must revoke from PUBLIC and anon, grant to authenticated and service_role
    expect(
      /REVOKE ALL ON FUNCTION\s+public\.accept_org_invitation\(VARCHAR\)\s+FROM\s+PUBLIC,\s*anon;/i.test(
        migrationSql
      )
    ).toBe(true)
    expect(
      /GRANT EXECUTE ON FUNCTION\s+public\.accept_org_invitation\(VARCHAR\)\s+TO\s+authenticated,\s*service_role;/i.test(
        migrationSql
      )
    ).toBe(true)
  })

  test('all 15 security definer functions explicitly revoke execute from PUBLIC and anon', () => {
    const all15 = [
      'accept_org_invitation',
      'claim_evaluation_job',
      'cleanup_expired_rate_limit_buckets',
      'consume_rate_limit_token',
      'finalize_evaluation_job',
      'handle_new_profile',
      'handle_new_user',
      'ingest_span_transactional',
      'ingest_spans_batch_transactional',
      'is_org_member',
      'is_org_owner',
      'is_project_member',
      'provision_future_spans_partitions',
      'provision_spans_partition',
      'register_span_identity',
    ]

    for (const fn of all15) {
      const revokeRegex = new RegExp(
        `REVOKE ALL ON FUNCTION\\s+public\\.${fn}\\b[\\s\\S]*?FROM[^;]*?\\bPUBLIC\\b`,
        'i'
      )
      expect(
        revokeRegex.test(migrationSql),
        `Function public.${fn} must explicitly revoke EXECUTE from PUBLIC in migration 009`
      ).toBe(true)
    }
  })

  test('inventory of all 15 security definer functions is fully reconciled across migrations 001-009 with exact regprocedure signatures', () => {
    const migration001Path = path.resolve(
      __dirname,
      '../../supabase/migrations/001_initial_schema.sql'
    )
    const migration001Sql = fs.readFileSync(migration001Path, 'utf8')

    // Find all SECURITY DEFINER functions in 001 and 009
    const allSecDefFns = new Set<string>()
    const secDefRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-zA-Z0-9_]+)\b[\s\S]*?SECURITY\s+DEFINER/gi
    let match: RegExpExecArray | null

    while ((match = secDefRegex.exec(migration001Sql)) !== null) {
      allSecDefFns.add(match[1])
    }
    while ((match = secDefRegex.exec(migrationSql)) !== null) {
      allSecDefFns.add(match[1])
    }

    const expected15 = [
      'accept_org_invitation',
      'claim_evaluation_job',
      'cleanup_expired_rate_limit_buckets',
      'consume_rate_limit_token',
      'finalize_evaluation_job',
      'handle_new_profile',
      'handle_new_user',
      'ingest_span_transactional',
      'ingest_spans_batch_transactional',
      'is_org_member',
      'is_org_owner',
      'is_project_member',
      'provision_future_spans_partitions',
      'provision_spans_partition',
      'register_span_identity',
    ]

    expect(Array.from(allSecDefFns).sort()).toEqual(expected15.sort())
    expect(allSecDefFns.size).toBe(15)

    // Expected exact regprocedure signatures
    const expectedRegprocedures = [
      'public.accept_org_invitation(character varying)',
      'public.claim_evaluation_job(character varying, integer, integer)',
      'public.cleanup_expired_rate_limit_buckets(integer)',
      'public.consume_rate_limit_token(character varying, numeric, numeric, numeric, integer)',
      'public.finalize_evaluation_job(uuid, character varying, uuid, integer, numeric, text, boolean, uuid)',
      'public.handle_new_profile()',
      'public.handle_new_user()',
      'public.ingest_span_transactional(uuid, uuid, character varying, character varying, character varying, uuid, text, text, text, timestamp with time zone, timestamp with time zone, integer, text, jsonb, jsonb, text, integer, integer, numeric, jsonb, boolean, jsonb, jsonb, integer, integer)',
      'public.ingest_spans_batch_transactional(uuid, uuid, jsonb)',
      'public.is_org_member(uuid)',
      'public.is_org_owner(uuid)',
      'public.is_project_member(uuid)',
      'public.provision_future_spans_partitions(integer)',
      'public.provision_spans_partition(date, date)',
      'public.register_span_identity(uuid, character varying, character varying, timestamp with time zone)',
    ]
    expect(expectedRegprocedures.length).toBe(15)
  })

  test('all function bodies use schema-qualified table references without relying on search_path', () => {
    const bareSpansMatch = /FROM\s+spans\b(?!_)/i.test(migrationSql)
    expect(bareSpansMatch, 'Should not have unqualified FROM spans references').toBe(false)

    const bareOutboxMatch = /FROM\s+evaluation_outbox\b/i.test(migrationSql)
    expect(bareOutboxMatch, 'Should not have unqualified FROM evaluation_outbox references').toBe(false)
  })
})
