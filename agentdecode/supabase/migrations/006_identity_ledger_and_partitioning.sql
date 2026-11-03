-- ============================================================================
-- Migration: 006_identity_ledger_and_partitioning.sql
-- Description: Creates span_identity_ledger, pending_parent_resolutions,
--              range-partitioned spans table, backfills historical data,
--              and re-points dependent foreign keys.
-- Database Target: PostgreSQL 18
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Create Span Identity Ledger (Unpartitioned Authority)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.span_identity_ledger (
  project_id       UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  trace_id         VARCHAR(64) NOT NULL,
  span_id          VARCHAR(64) NOT NULL,
  db_id            UUID NOT NULL DEFAULT gen_random_uuid(),
  first_started_at TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, trace_id, span_id),
  CONSTRAINT uq_ledger_db_id UNIQUE (db_id),
  CONSTRAINT uq_ledger_project_trace_db_id UNIQUE (project_id, trace_id, db_id),
  CONSTRAINT uq_ledger_composite UNIQUE (project_id, db_id, first_started_at)
);

COMMENT ON TABLE public.span_identity_ledger IS
  'Durable identity authority binding project/trace/span to canonical UUID and partition timestamp.';

-- ----------------------------------------------------------------------------
-- 2. Create Pending Parent Resolutions Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pending_parent_resolutions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  trace_id           VARCHAR(64) NOT NULL,
  parent_span_id_hex VARCHAR(64) NOT NULL,
  child_span_id      UUID NOT NULL,
  child_started_at   TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 hour')
);

COMMENT ON TABLE public.pending_parent_resolutions IS
  'Tracks child spans arriving before their parent span without polluting the identity ledger.';

CREATE INDEX IF NOT EXISTS idx_pending_parent_lookup
  ON public.pending_parent_resolutions (project_id, trace_id, parent_span_id_hex);

-- ----------------------------------------------------------------------------
-- 3. Create Replacement Range-Partitioned Spans Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.spans_partitioned (
  -- 19 original columns preserved
  id             UUID NOT NULL,
  session_id     UUID NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,
  project_id     UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  parent_span_id UUID,
  name           TEXT NOT NULL,
  span_type      TEXT NOT NULL DEFAULT 'chain'
                   CHECK (span_type IN ('llm', 'tool', 'chain', 'retrieval', 'agent', 'embedding', 'rerank', 'guardrail', 'other')),
  status         TEXT NOT NULL DEFAULT 'ok'
                   CHECK (status IN ('ok', 'error')),
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  duration_ms    INTEGER,
  model          TEXT,
  input          JSONB,
  output         JSONB,
  error_message  TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       NUMERIC(10,6),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- OpenTelemetry & Identification Columns
  trace_id       VARCHAR(64) NOT NULL,
  span_id        VARCHAR(64) NOT NULL,
  is_legacy      BOOLEAN NOT NULL DEFAULT false,
  attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  links          JSONB NOT NULL DEFAULT '[]'::jsonb,
  workflow_step  INTEGER,
  iteration_index INTEGER,

  -- Primary & Composite Integrity Constraints
  PRIMARY KEY (project_id, trace_id, span_id, started_at),
  CONSTRAINT uq_spans_project_id_started_at UNIQUE (project_id, id, started_at),
  CONSTRAINT fk_spans_ledger_composite
    FOREIGN KEY (project_id, id, started_at)
    REFERENCES public.span_identity_ledger (project_id, db_id, first_started_at)
    ON DELETE CASCADE,
  -- PostgreSQL 18 column-specific SET NULL referential action:
  CONSTRAINT fk_spans_parent_ledger_trace_scoped
    FOREIGN KEY (project_id, trace_id, parent_span_id)
    REFERENCES public.span_identity_ledger (project_id, trace_id, db_id)
    ON DELETE SET NULL (parent_span_id),
  -- Format Validation Discriminator:
  CONSTRAINT chk_spans_identifier_format
    CHECK (
      (is_legacy = true AND trace_id LIKE 'legacy_%' AND span_id LIKE 'legacy_%') OR
      (is_legacy = false AND trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> '00000000000000000000000000000000'
                         AND span_id ~ '^[0-9a-f]{16}$' AND span_id <> '0000000000000000')
    )
) PARTITION BY RANGE (started_at);

-- ----------------------------------------------------------------------------
-- 4. Create Historical & Future Monthly Partitions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.spans_y2026m09 PARTITION OF public.spans_partitioned
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.spans_y2026m10 PARTITION OF public.spans_partitioned
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.spans_y2026m11 PARTITION OF public.spans_partitioned
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.spans_y2026m12 PARTITION OF public.spans_partitioned
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.spans_default PARTITION OF public.spans_partitioned DEFAULT;

-- ----------------------------------------------------------------------------
-- 5. Backfill Identity Ledger from Existing Spans
-- ----------------------------------------------------------------------------
INSERT INTO public.span_identity_ledger (
  project_id, trace_id, span_id, db_id, first_started_at, created_at
)
SELECT
  s.project_id,
  'legacy_' || replace(s.session_id::text, '-', '') AS trace_id,
  'legacy_' || replace(s.id::text, '-', '')         AS span_id,
  s.id                                              AS db_id,
  s.started_at                                      AS first_started_at,
  s.created_at                                      AS created_at
FROM public.spans s
ORDER BY s.started_at ASC
ON CONFLICT (project_id, trace_id, span_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. Copy Historical Data into Partitioned Spans
-- ----------------------------------------------------------------------------
INSERT INTO public.spans_partitioned (
  id, session_id, project_id, parent_span_id, name,
  span_type, status, started_at, ended_at, duration_ms,
  model, input, output, error_message, input_tokens,
  output_tokens, cost_usd, metadata, created_at,
  trace_id, span_id, is_legacy, attributes, links
)
SELECT
  s.id,
  s.session_id,
  s.project_id,
  s.parent_span_id,
  s.name,
  COALESCE(s.span_type, 'chain') AS span_type,
  s.status,
  s.started_at,
  s.ended_at,
  s.duration_ms,
  s.model,
  s.input,
  s.output,
  s.error_message,
  s.input_tokens,
  s.output_tokens,
  s.cost_usd,
  s.metadata,
  s.created_at,
  'legacy_' || replace(s.session_id::text, '-', '') AS trace_id,
  'legacy_' || replace(s.id::text, '-', '')         AS span_id,
  true                                              AS is_legacy,
  jsonb_build_object('is_legacy', true)             AS attributes,
  '[]'::jsonb                                       AS links
FROM public.spans s;

-- ----------------------------------------------------------------------------
-- 7. Atomic Table Swap & Re-pointing Foreign Keys
-- ----------------------------------------------------------------------------
ALTER TABLE public.eval_scores DROP CONSTRAINT IF EXISTS eval_scores_span_id_fkey;
ALTER TABLE public.ai_explanations DROP CONSTRAINT IF EXISTS ai_explanations_span_id_fkey;
ALTER TABLE public.issue_spans DROP CONSTRAINT IF EXISTS issue_spans_span_id_fkey;

-- Rename legacy indexes to prevent name collisions
ALTER INDEX IF EXISTS public.idx_spans_session_started RENAME TO idx_spans_legacy_session_started;
ALTER INDEX IF EXISTS public.idx_spans_project_errors RENAME TO idx_spans_legacy_project_errors;
ALTER INDEX IF EXISTS public.idx_spans_parent RENAME TO idx_spans_legacy_parent;

-- Swap tables
ALTER TABLE public.spans RENAME TO spans_legacy;
ALTER TABLE public.spans_partitioned RENAME TO spans;

-- Re-point foreign keys to unpartitioned span_identity_ledger (db_id)
ALTER TABLE public.eval_scores
  ADD CONSTRAINT fk_eval_scores_ledger
  FOREIGN KEY (span_id)
  REFERENCES public.span_identity_ledger (db_id)
  ON DELETE CASCADE;

ALTER TABLE public.ai_explanations
  ADD CONSTRAINT fk_ai_explanations_ledger
  FOREIGN KEY (span_id)
  REFERENCES public.span_identity_ledger (db_id)
  ON DELETE CASCADE;

ALTER TABLE public.issue_spans
  ADD CONSTRAINT fk_issue_spans_ledger
  FOREIGN KEY (span_id)
  REFERENCES public.span_identity_ledger (db_id)
  ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- 8. Create Replacement Indexes on Partitioned Spans
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_spans_id ON public.spans (id);
CREATE INDEX IF NOT EXISTS idx_spans_session_started ON public.spans (session_id, started_at ASC);
CREATE INDEX IF NOT EXISTS idx_spans_project_errors ON public.spans (project_id, status) WHERE status = 'error';
CREATE INDEX IF NOT EXISTS idx_spans_parent ON public.spans (parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON public.spans (project_id, trace_id);

-- ----------------------------------------------------------------------------
-- 9. Row Level Security & Permissions
-- ----------------------------------------------------------------------------
ALTER TABLE public.span_identity_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_parent_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ledger: org members can view identities"
  ON public.span_identity_ledger FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

CREATE POLICY "pending_parents: org members can view"
  ON public.pending_parent_resolutions FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

CREATE POLICY "spans: org members can view spans"
  ON public.spans FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

CREATE POLICY "spans: org members can update spans"
  ON public.spans FOR UPDATE
  TO authenticated
  USING (public.is_project_member(project_id))
  WITH CHECK (public.is_project_member(project_id));

CREATE POLICY "spans: org members can delete spans"
  ON public.spans FOR DELETE
  TO authenticated
  USING (public.is_project_member(project_id));

REVOKE ALL ON public.span_identity_ledger FROM public, anon;
GRANT SELECT ON public.span_identity_ledger TO authenticated;
GRANT ALL ON public.span_identity_ledger TO service_role;

REVOKE ALL ON public.pending_parent_resolutions FROM public, anon;
GRANT SELECT ON public.pending_parent_resolutions TO authenticated;
GRANT ALL ON public.pending_parent_resolutions TO service_role;

REVOKE ALL ON public.spans FROM public, anon;
GRANT SELECT, UPDATE, DELETE ON public.spans TO authenticated;
GRANT ALL ON public.spans TO service_role;

GRANT ALL ON public.eval_scores TO service_role, authenticated;
GRANT ALL ON public.ai_explanations TO service_role, authenticated;
GRANT ALL ON public.issue_spans TO service_role, authenticated;

COMMIT;
