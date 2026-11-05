import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Spans Partition Maintenance Infrastructure (Migration 009)', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../supabase/migrations/009_production_readiness_remediation.sql'
  )
  const migrationSql = fs.readFileSync(migrationPath, 'utf8')

  test('provision_spans_partition is defined with SECURITY DEFINER and empty search_path', () => {
    const fnMatch = migrationSql.match(
      /CREATE OR REPLACE FUNCTION public\.provision_spans_partition[\s\S]*?LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/i
    )
    expect(fnMatch).not.toBeNull()
  })

  test('provision_spans_partition acquires transaction advisory lock to prevent concurrent provisioning race', () => {
    expect(migrationSql).toContain(
      "PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('provision_spans_partition'));"
    )
  })

  test('provision_spans_partition checks spans_default for conflicting rows and stages them', () => {
    expect(migrationSql).toContain("SELECT count(*) FROM public.spans_default")
    expect(migrationSql).toContain("started_at >= %L AND started_at < %L")
    expect(migrationSql).toContain("CREATE TEMP TABLE _spans_partition_staging")
    expect(migrationSql).toContain("DELETE FROM public.spans_default")
    expect(migrationSql).toContain("INSERT INTO public.spans SELECT * FROM _spans_partition_staging")
  })

  test('provision_future_spans_partitions provisions future monthly partitions dynamically', () => {
    const fnMatch = migrationSql.match(
      /CREATE OR REPLACE FUNCTION public\.provision_future_spans_partitions[\s\S]*?LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/i
    )
    expect(fnMatch).not.toBeNull()
    expect(migrationSql).toContain("public.provision_spans_partition(v_cur_month, v_next_month)")
  })

  test('Partitioning functions are accessible exclusively to service_role', () => {
    expect(migrationSql).toContain(
      "REVOKE ALL ON FUNCTION public.provision_spans_partition(DATE, DATE) FROM PUBLIC, anon, authenticated;"
    )
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION public.provision_spans_partition(DATE, DATE) TO service_role;"
    )
    expect(migrationSql).toContain(
      "REVOKE ALL ON FUNCTION public.provision_future_spans_partitions(INTEGER) FROM PUBLIC, anon, authenticated;"
    )
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION public.provision_future_spans_partitions(INTEGER) TO service_role;"
    )
  })
})
