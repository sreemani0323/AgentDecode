-- ============================================================================
-- AgentDecode Milestone 1 Migration Verification SQL
-- Target: PostgreSQL 18
-- Run immediately after executing migrations 006, 007, 008.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Row Count Parity Check (Legacy Spans vs Partitioned Spans)
-- ----------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.spans_legacy) AS legacy_spans_count,
  (SELECT count(*) FROM public.spans)        AS partitioned_spans_count,
  CASE
    WHEN (SELECT count(*) FROM public.spans_legacy) = (SELECT count(*) FROM public.spans)
    THEN 'PASS: Row counts match perfectly'
    ELSE 'FAIL: Row count discrepancy detected!'
  END AS status;

-- ----------------------------------------------------------------------------
-- 2. Identity Ledger Parity Check
-- ----------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.span_identity_ledger) AS ledger_entries_count,
  (SELECT count(*) FROM public.spans)                AS raw_spans_count,
  CASE
    WHEN (SELECT count(*) FROM public.span_identity_ledger) = (SELECT count(*) FROM public.spans)
    THEN 'PASS: Every raw span has an exact canonical identity record'
    ELSE 'FAIL: Identity ledger and raw spans count mismatch!'
  END AS status;

-- ----------------------------------------------------------------------------
-- 3. Column-by-Column Reconciliation Sample (All 19 Original Columns)
-- ----------------------------------------------------------------------------
SELECT
  count(*) AS mismatched_rows_count,
  CASE
    WHEN count(*) = 0 THEN 'PASS: All 19 historical columns match exactly'
    ELSE 'FAIL: Data transformation discrepancy detected!'
  END AS status
FROM public.spans_legacy l
JOIN public.spans p ON l.id = p.id
WHERE l.session_id IS DISTINCT FROM p.session_id
   OR l.project_id IS DISTINCT FROM p.project_id
   OR l.parent_span_id IS DISTINCT FROM p.parent_span_id
   OR l.name IS DISTINCT FROM p.name
   OR COALESCE(l.span_type, 'chain') IS DISTINCT FROM p.span_type
   OR l.status IS DISTINCT FROM p.status
   OR l.started_at IS DISTINCT FROM p.started_at
   OR l.ended_at IS DISTINCT FROM p.ended_at
   OR l.duration_ms IS DISTINCT FROM p.duration_ms
   OR l.model IS DISTINCT FROM p.model
   OR l.input IS DISTINCT FROM p.input
   OR l.output IS DISTINCT FROM p.output
   OR l.error_message IS DISTINCT FROM p.error_message
   OR l.input_tokens IS DISTINCT FROM p.input_tokens
   OR l.output_tokens IS DISTINCT FROM p.output_tokens
   OR l.cost_usd IS DISTINCT FROM p.cost_usd
   OR l.metadata IS DISTINCT FROM p.metadata
   OR l.created_at IS DISTINCT FROM p.created_at;

-- ----------------------------------------------------------------------------
-- 4. Foreign Key Referential Integrity & Orphan Check
-- ----------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.eval_scores e
   LEFT JOIN public.span_identity_ledger l ON e.span_id = l.db_id
   WHERE l.db_id IS NULL) AS orphan_eval_scores,

  (SELECT count(*) FROM public.ai_explanations a
   LEFT JOIN public.span_identity_ledger l ON a.span_id = l.db_id
   WHERE l.db_id IS NULL) AS orphan_ai_explanations,

  (SELECT count(*) FROM public.issue_spans i
   LEFT JOIN public.span_identity_ledger l ON i.span_id = l.db_id
   WHERE l.db_id IS NULL) AS orphan_issue_spans;

-- ----------------------------------------------------------------------------
-- 5. Parent-Child Relationship Integrity (Project & Trace Scoping)
-- ----------------------------------------------------------------------------
SELECT
  count(*) AS cross_boundary_parents,
  CASE
    WHEN count(*) = 0 THEN 'PASS: All parent spans share project_id and trace_id'
    ELSE 'FAIL: Cross-project or cross-trace parent reference found!'
  END AS status
FROM public.spans child
JOIN public.span_identity_ledger parent ON child.parent_span_id = parent.db_id
WHERE child.project_id <> parent.project_id
   OR child.trace_id <> parent.trace_id;

-- ----------------------------------------------------------------------------
-- 6. Row Level Security & Policy Verification
-- ----------------------------------------------------------------------------
SELECT
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('spans', 'span_identity_ledger', 'evaluation_outbox', 'trace_evaluations', 'pending_parent_resolutions');

-- ----------------------------------------------------------------------------
-- 7. Application Query Emulation Check (Single UUID Lookup)
-- ----------------------------------------------------------------------------
-- Ensures that .eq('id', spanId).single() semantics return at most 1 row across all partitions
SELECT
  id,
  count(*) AS duplicate_uuid_count
FROM public.spans
GROUP BY id
HAVING count(*) > 1;
