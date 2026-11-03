# AgentDecode — Milestone 1 Migration Runbook: Operator-Controlled Producer Drain

## Overview
This runbook details the exact operational sequence for executing the Milestone 1 database migration (Migrations `006`, `007`, `008`) under a controlled maintenance window.

> [!CRITICAL]
> **Prototype SDK Limitation:** In Milestone 1, both TypeScript and Python client SDKs store telemetry exclusively in process memory. Returning `HTTP 503` pauses in-flight retries for running processes, but any agent worker or cron process that restarts, crashes, or terminates during the window will lose its in-memory buffer. Therefore, **upstream producers must be cleanly stopped or drained** prior to starting the database cutover.

---

## 1. Pre-Migration Checklist
- [ ] Database backup taken and verified (`pg_dump` or Supabase snapshot).
- [ ] Free disk space verified: $\ge 2.5 \times$ size of `public.spans` (to accommodate partitioned table copying).
- [ ] Engineering operators notified and maintenance window announced.
- [ ] Staging rehearsal completed successfully using `migration_verification.sql`.

---

## 2. Phase A: Operator-Controlled Producer Drain
1. **Signal Upstream Agent Workers:**
   - Pause scheduled workflow triggers and background ingestion runners.
   - Allow active agent runs to complete (or wait 60 seconds for in-flight requests to flush).
2. **Enable Gateway Maintenance Mode:**
   - Set environment variable across all Next.js API gateway instances:
     ```bash
     GATEWAY_WRITE_MAINTENANCE=true
     ```
   - Verify that calls to `POST /api/ingest` return `HTTP 503 Service Unavailable`:
     ```json
     {
       "error": "MAINTENANCE_IN_PROGRESS",
       "message": "Database migration or maintenance in progress; retain telemetry in client buffer",
       "retryable": true
     }
     ```
   - Headers must include `Retry-After: 30`.

---

## 3. Phase B: Database Lockout & Transaction Drain
Execute via administrative psql session (`postgres` role):

```sql
-- 1. Install Statement-Level Admission Guards on ALL affected tables
CREATE OR REPLACE FUNCTION public.check_migration_admission()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Database migration in progress; writes temporarily suspended'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_spans_admission_guard
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.spans
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_migration_admission();

CREATE TRIGGER trg_eval_scores_admission_guard
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.eval_scores
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_migration_admission();

CREATE TRIGGER trg_ai_explanations_admission_guard
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.ai_explanations
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_migration_admission();

CREATE TRIGGER trg_issue_spans_admission_guard
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.issue_spans
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_migration_admission();

-- 2. Revoke write privileges
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.spans FROM authenticated, anon, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.eval_scores FROM authenticated, anon, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ai_explanations FROM authenticated, anon, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.issue_spans FROM authenticated, anon, service_role;

-- 3. Target and terminate lingering write transactions holding locks on affected tables
SELECT pg_terminate_backend(l.pid)
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation::regclass::text IN ('public.spans', 'public.eval_scores', 'public.ai_explanations', 'public.issue_spans')
  AND l.mode IN ('RowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  AND a.pid <> pg_backend_pid();
```

---

## 4. Phase C: Execute Migration Scripts
Execute in single administrative session:

```bash
# Execute migrations in order:
psql -d $DATABASE_URL -f supabase/migrations/006_identity_ledger_and_partitioning.sql
psql -d $DATABASE_URL -f supabase/migrations/007_transactional_evaluation_outbox.sql
psql -d $DATABASE_URL -f supabase/migrations/008_atomic_identity_and_outbox_functions.sql
```

---

## 5. Phase D: Post-Migration Verification
Run `supabase/migration_verification.sql` to verify:
1. Row count parity: `count(spans_legacy) == count(spans)`.
2. Identity ledger parity: `count(spans) == count(span_identity_ledger)`.
3. Zero orphan foreign keys on `eval_scores`, `ai_explanations`, `issue_spans`.
4. RLS policies active on `span_identity_ledger` and `spans`.
5. Application queries using `.eq('id', spanId).single()` succeed without PostgREST errors.

---

## 6. Phase E: Reopening the Gateway
Only after 100% of verification queries pass:

1. **Disable Gateway Maintenance Mode:**
   - Update environment variable across Next.js pods:
     ```bash
     GATEWAY_WRITE_MAINTENANCE=false
     ```
2. **Drop Admission Triggers & Re-grant Privileges:**
   ```sql
   -- Drop admission triggers from active relations
   DROP TRIGGER IF EXISTS trg_spans_admission_guard ON public.spans;
   DROP TRIGGER IF EXISTS trg_eval_scores_admission_guard ON public.eval_scores;
   DROP TRIGGER IF EXISTS trg_ai_explanations_admission_guard ON public.ai_explanations;
   DROP TRIGGER IF EXISTS trg_issue_spans_admission_guard ON public.issue_spans;

   -- Restore permissions
   GRANT SELECT, UPDATE, DELETE ON public.spans TO authenticated;
   GRANT ALL ON public.spans TO service_role;
   GRANT ALL ON public.eval_scores TO service_role, authenticated;
   GRANT ALL ON public.ai_explanations TO service_role, authenticated;
   GRANT ALL ON public.issue_spans TO service_role, authenticated;
   ```
3. **Resume Upstream Producers:**
   - Restart background workers, cron jobs, and agent runners.
   - Verify incoming spans are populating `spans` and `span_identity_ledger`.
