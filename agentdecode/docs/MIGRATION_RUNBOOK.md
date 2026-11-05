# AgentDecode — Database Migration & Operational Runbook

## Overview
This runbook details the operational sequence for executing database migrations (Migrations `006` through `009`) under a controlled maintenance window, managing spans table partitioning, handling failure recovery, and maintaining production health.

> [!CRITICAL]
> **Persistent SDK WAL & Maintenance Windows:**
> While SDKs running Milestone 2 feature persistent Write-Ahead Logs (SQLite in Python, durable fsync in Node.js), returning `HTTP 503` pauses transmission and instructs SDKs to back off and retain spans locally. For planned database maintenance windows, **upstream producers should still be cleanly drained** or paused to minimize local disk queue buildup.

---

## 1. Pre-Migration Checklist
- [ ] Database backup taken and verified (`pg_dump` or Supabase snapshot).
- [ ] Free disk space verified: $\ge 2.5 \times$ size of `public.spans` (to accommodate partitioned table copying and index building).
- [ ] Engineering operators notified and maintenance window announced.
- [ ] Staging rehearsal completed successfully using `migration_verification.sql`.
- [ ] Target database connection strings and credentials prepared.

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

-- 2. Revoke write privileges temporarily
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

Always execute migration scripts with `ON_ERROR_STOP=1` to ensure execution halts immediately upon any error.

### Linux / macOS (Bash)
```bash
set -e
export ON_ERROR_STOP=1

psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f supabase/migrations/006_identity_ledger_and_partitioning.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f supabase/migrations/007_transactional_evaluation_outbox.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f supabase/migrations/008_atomic_identity_and_outbox_functions.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f supabase/migrations/009_production_readiness_remediation.sql
```

### Windows (PowerShell)
```powershell
$ErrorActionPreference = "Stop"

$migrations = @(
  "supabase\migrations\006_identity_ledger_and_partitioning.sql",
  "supabase\migrations\007_transactional_evaluation_outbox.sql",
  "supabase\migrations\008_atomic_identity_and_outbox_functions.sql",
  "supabase\migrations\009_production_readiness_remediation.sql"
)

foreach ($migration in $migrations) {
  Write-Host "Applying $migration..."
  & psql -v ON_ERROR_STOP=1 -d $env:DATABASE_URL -f $migration
  if ($LASTEXITCODE -ne 0) {
    throw "Migration failed on $migration with exit code $LASTEXITCODE"
  }
}
Write-Host "All migrations applied successfully."
```

---

## 5. Phase D: Post-Migration Verification
Execute the verification checks:

1. **Row Count Parity:**
   ```sql
   SELECT
     (SELECT count(*) FROM public.spans_legacy) AS legacy_count,
     (SELECT count(*) FROM public.spans) AS partitioned_count,
     (SELECT count(*) FROM public.span_identity_ledger) AS ledger_count;
   ```
   `legacy_count` must equal `partitioned_count` and `ledger_count`.

2. **Security & Search Path Audit (15-Function Audited Inventory):**
   ```sql
   SELECT p.proname, p.prosecdef, p.proconfig,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef = true
   ORDER BY p.proname;
   ```
   **Verification Criteria:**
   - Exactly **15 functions** returned:
     1. `accept_org_invitation` (auth: true, anon: false)
     2. `claim_evaluation_job` (auth: false, anon: false)
     3. `cleanup_expired_rate_limit_buckets` (auth: false, anon: false)
     4. `consume_rate_limit_token` (auth: false, anon: false)
     5. `finalize_evaluation_job` (auth: false, anon: false)
     6. `handle_new_profile` (auth: false, anon: false)
     7. `handle_new_user` (auth: false, anon: false)
     8. `ingest_span_transactional` (auth: false, anon: false)
     9. `ingest_spans_batch_transactional` (auth: false, anon: false)
     10. `is_org_member` (auth: true, anon: false)
     11. `is_org_owner` (auth: true, anon: false)
     12. `is_project_member` (auth: true, anon: false)
     13. `provision_future_spans_partitions` (auth: false, anon: false)
     14. `provision_spans_partition` (auth: false, anon: false)
     15. `register_span_identity` (auth: false, anon: false)
   - Every single function must have `prosecdef = true` and `proconfig = {search_path=}`.
   - `anon_can_execute` must be `false` across all 15 functions.

3. **Rate-Limit Cleanup & Maintenance Schedule:**
   - Primary maintenance is deterministic: `EvaluationOutboxWorker` executes `public.cleanup_expired_rate_limit_buckets(1000)` on every worker execution cycle (Vercel Cron minute-schedule or operator CLI runner).
   - Operator CLI manual trigger:
     ```bash
     node scripts/run-outbox-worker.mjs --batch-size=10
     ```
   - Direct SQL manual cleanup:
     ```sql
     SELECT public.cleanup_expired_rate_limit_buckets(5000);
     ```

4. **Partition Provisioning Test:**
   ```sql
   -- Pre-provision next 2 months of partitions
   SELECT public.provision_future_spans_partitions(2);
   ```

5. **Zero Orphan Foreign Keys:**
   ```sql
   SELECT count(*) FROM public.trace_evaluations te
   LEFT JOIN public.span_identity_ledger sil ON te.span_id = sil.db_id
   WHERE te.span_id IS NOT NULL AND sil.db_id IS NULL;
   ```

---

## 6. Phase E: Reopening the Gateway
Only after 100% of verification queries pass:

1. **Disable Gateway Maintenance Mode:**
   - Update environment variable across Next.js pods:
     ```bash
     GATEWAY_WRITE_MAINTENANCE=false
     ```
2. **Drop Admission Triggers & Re-grant Privileges:**
   > [!IMPORTANT]
   > Because Migration `006` renamed the original `spans` table to `spans_legacy` and created a new partitioned `spans` table, you **MUST drop the admission guard trigger from BOTH `public.spans_legacy` and `public.spans`**.

   ```sql
   -- Drop admission triggers from BOTH spans and spans_legacy
   DROP TRIGGER IF EXISTS trg_spans_admission_guard ON public.spans;
   DROP TRIGGER IF EXISTS trg_spans_admission_guard ON public.spans_legacy;
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

---

## 7. Failure Recovery & Forward-Repair Procedures

### Partial Migration Failure
If a migration fails midway:
1. Because `ON_ERROR_STOP=1` was set, PostgreSQL halted at the failing statement.
2. If the failure occurred within a single transaction block, the transaction was rolled back automatically.
3. For multi-statement migrations with partial DDL commits:
   - All DDL statements in Migration `009` are designed with idempotent guards:
     - `CREATE OR REPLACE FUNCTION ...`
     - `CREATE TABLE IF NOT EXISTS ...`
     - `CREATE INDEX IF NOT EXISTS ...`
     - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
     - `DROP POLICY IF EXISTS ...`
   - Inspect the exact error message from the psql output.
   - Correct the underlying condition (e.g. insufficient disk space or conflicting lock).
   - Re-run the migration script from the start.

### Emergency Rollback
If the partitioned `spans` cutover in migration 006 failed or application queries fail critically:
1. `spans_legacy` preserves the entire original dataset unmodified.
2. In an emergency:
   ```sql
   -- Drop partitioned view/table and restore spans_legacy
   DROP TABLE IF EXISTS public.spans CASCADE;
   ALTER TABLE public.spans_legacy RENAME TO spans;
   ```
3. Remove admission guards and re-enable the gateway.

---

## 8. Ongoing Spans Partition Maintenance

The `spans` table is partitioned by month on `started_at`.
To ensure high-throughput writes never fall into `spans_default`:

1. **Automated Scheduled Provisioning:**
   Call `provision_future_spans_partitions` on the 1st of every month via cron or background worker:
   ```sql
   SELECT public.provision_future_spans_partitions(2);
   ```

2. **Handling `spans_default` Conflicts:**
   PostgreSQL prevents attaching a new partition range if `spans_default` contains rows within that range.
   The function `public.provision_spans_partition(p_start_date, p_end_date)` handles this automatically:
   - Takes transaction advisory lock `pg_advisory_xact_lock(hashtext('provision_spans_partition'))`.
   - Checks `spans_default` for conflicting rows in `[p_start_date, p_end_date)`.
   - If found, safely moves conflicting rows to a temporary staging table, creates the partition, and re-inserts the staging rows so they route cleanly into the newly attached partition.


---

## 9. Evaluation Outbox Worker, Vercel Hobby Architecture & Supabase Scheduling

### 9.1 Vercel Hobby Configuration & Protected Worker Endpoint
On Vercel Hobby accounts, scheduled cron expressions more frequent than once per day are unsupported and will reject deployments.
To maintain 100% compatibility with Vercel Hobby while achieving minute-by-minute evaluation outbox draining:

1. **Vercel Configuration (`vercel.json`):**
   - The cron configuration in `agentdecode/vercel.json` is set to `{}` (zero cron declarations).
   - Do **NOT** configure a daily or minute cron in `vercel.json`.
   - The serverless function `/api/workers/eval-outbox` remains active and protected.
2. **Serverless Function Budget (`maxDuration: 10`):**
   - Vercel Hobby limits serverless functions to a maximum execution duration of 10 seconds.
   - The worker route enforces a safe execution ceiling (`maxExecutionTimeMs = 8000`, batch size = 5) ensuring jobs finish and respond with HTTP 200 well before the 10-second ceiling.
3. **Constant-Time Secret Protection:**
   - The endpoint strictly verifies `Authorization: Bearer <CRON_SECRET>` or `Bearer <EVAL_WORKER_SECRET>` using `crypto.timingSafeEqual` to eliminate timing side-channel attacks.

---

### 9.2 Supabase Native Scheduling (`pg_cron` + `pg_net` + Vault)
Minute-level scheduling is executed natively inside hosted Supabase using `pg_cron` combined with `pg_net` to trigger the Vercel worker over HTTPS.

#### Step 1: Enable Required Extensions
In your Supabase project (via **Database -> Extensions** in the Supabase Dashboard, or in the SQL Editor):
```sql
-- Enable pg_cron (runs inside postgres)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Enable pg_net (asynchronous non-blocking HTTP client)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
```

#### Step 2: Store Credentials Securely in Supabase Vault
Never store raw URLs or secrets in migrations, Git commits, or SQL scripts.
Store them in Supabase Vault using the Supabase Dashboard (**Project Settings -> Vault**) or run the following SQL using placeholders:

```sql
-- 1. Store your deployed Vercel production URL (e.g. https://agentdecode.vercel.app)
SELECT vault.create_secret(
  'https://<your-project>.vercel.app',
  'eval_worker_url',
  'AgentDecode production Vercel deployment URL'
);

-- 2. Store the shared worker Bearer secret (matches CRON_SECRET in Vercel environment variables)
SELECT vault.create_secret(
  '<your-secure-cron-secret-entropy-32-bytes>',
  'cron_secret',
  'Shared Bearer authorization secret for outbox worker endpoint'
);
```

#### Step 3: Register the Every-Minute Invocator Job
Execute the following scheduling block in the Supabase SQL Editor. It dynamically resolves credentials from `vault.decrypted_secrets` at execution time and issues an asynchronous HTTP POST via `net.http_post`:

```sql
-- Register minute-level evaluation outbox runner
SELECT cron.schedule(
  'agentdecode-outbox-worker',
  '* * * * *',
  $$
  DO $$
  DECLARE
    v_url TEXT;
    v_secret TEXT;
    v_request_id BIGINT;
  BEGIN
    -- Read credentials dynamically from Supabase Vault
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'eval_worker_url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'cron_secret'
    LIMIT 1;

    -- Dispatch HTTP request only when vault secrets are configured
    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      SELECT net.http_post(
        url := rtrim(v_url, '/') || '/api/workers/eval-outbox',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_secret
        ),
        body := jsonb_build_object(
          'batch_size', 5,
          'max_time_ms', 8000
        ),
        timeout_milliseconds := 9000
      ) INTO v_request_id;
    END IF;
  END $$;
  $$
);
```

---

### 9.3 Overlapping Scheduler Safety & Concurrency Guarantees
Because `pg_cron` triggers every minute, network latency or LLM provider delays could cause an invocation to still be running when the next scheduled tick fires.
The architecture provides mathematical concurrency isolation:
1. **Row Locks with `SKIP LOCKED`:**
   `claim_evaluation_job` issues `SELECT id FROM public.evaluation_outbox WHERE status = 'pending' ... FOR UPDATE SKIP LOCKED`. Any row currently claimed or processing by an active worker is immediately skipped by concurrent invocations.
2. **Lease Isolation:**
   Each claim generates a unique `lease_token` (UUID) and `lease_expires_at`.
3. **Atomic 6-Condition Finalization:**
   `finalize_evaluation_job` verifies that the worker holds the active lease token, the trace version matches, and the lease has not expired.
4. **Result:** Overlapping scheduler invocations **cannot** duplicate job processing or produce duplicate evaluation rows.

---

### 9.4 Monitoring, Recovery & Operational Troubleshooting

#### 1. Inspect Scheduled Cron Job Configuration
```sql
SELECT jobid, jobname, schedule, active, username
FROM cron.job
WHERE jobname = 'agentdecode-outbox-worker';
```

#### 2. Inspect `pg_cron` Execution History
```sql
SELECT runid, jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'agentdecode-outbox-worker')
ORDER BY start_time DESC
LIMIT 15;
```

#### 3. Inspect HTTP Request & Response Status in `pg_net`
> [!IMPORTANT]
> A status of `succeeded` in `cron.job_run_details` only indicates that `net.http_post` was successfully placed into the `pg_net` transmission queue. You **MUST inspect `net._http_response`** to verify HTTP response codes from Vercel.

```sql
-- Inspect latest HTTP responses from Vercel worker
SELECT id, status_code, error_msg, timed_out, created
FROM net._http_response
ORDER BY created DESC
LIMIT 15;
```
- `status_code = 200`: Worker successfully executed bounded batch.
- `status_code = 401`: Secret mismatch between Supabase Vault and Vercel `CRON_SECRET`.
- `status_code = 504`: Worker exceeded Vercel Hobby duration limit (check `max_time_ms` setting).

#### 4. Pausing or Removing the Scheduled Job Safely
```sql
-- Temporarily pause job without deleting:
UPDATE cron.job SET active = false WHERE jobname = 'agentdecode-outbox-worker';

-- Re-enable paused job:
UPDATE cron.job SET active = true WHERE jobname = 'agentdecode-outbox-worker';

-- Completely unschedule and delete job:
SELECT cron.unschedule('agentdecode-outbox-worker');
```

---

## 10. Engine Compatibility & Rate-Limit Storage Maintenance

### 10.1 PostgreSQL Versioning (16 vs 18)
- **Production Baseline:** Managed Supabase projects run PostgreSQL 15/16.
- **CI & Testing:** CI validates migrations `001` through `009` against PostgreSQL 16 using `ON_ERROR_STOP=1`.
- **Forward Compatibility:** All DDL, declarative partitions, advisory locks, and cryptographic hashing (`extensions.digest`) are strictly ANSI/PostgreSQL 16+ compliant and forward-compatible with PostgreSQL 18.

### 10.2 Rate-Limit Storage Bounded Cleanup
The `rate_limit_buckets` table records token bucket state. Expired buckets are pruned using `public.cleanup_expired_rate_limit_buckets(p_batch_size)`:
```sql
SELECT public.cleanup_expired_rate_limit_buckets(5000);
```
- **Non-blocking Concurrency:** Uses `FOR UPDATE SKIP LOCKED` over index `idx_rate_limit_expires` (`expires_at`), ensuring maintenance never blocks or deadlocks active ingest requests.
- **Opportunistic Purge:** The ingestion token consumption RPC performs bounded cleanup (50 rows) probabilistically on 1% of requests.
