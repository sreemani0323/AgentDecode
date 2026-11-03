-- ============================================================================
-- Migration: 007_transactional_evaluation_outbox.sql
-- Description: Creates evaluation_outbox, trace_evaluations, and
--              ingestion_batch_checkpoints tables with security policies.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Create Transactional Evaluation Outbox
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.evaluation_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  trace_id         VARCHAR(64) NOT NULL,
  eval_type        VARCHAR(32) NOT NULL DEFAULT 'hallucination'
                     CHECK (eval_type IN ('hallucination', 'llm_judge', 'latency', 'safety', 'span_score')),
  trace_version    INTEGER NOT NULL DEFAULT 1,
  status           VARCHAR(32) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'reopened', 'failed')),
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '15 seconds'),
  claimed_by       VARCHAR(64),
  lease_token      UUID,
  lease_expires_at TIMESTAMPTZ,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  max_retries      INTEGER NOT NULL DEFAULT 3,
  last_error       TEXT,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_outbox_project_trace_type UNIQUE (project_id, trace_id, eval_type)
);

COMMENT ON TABLE public.evaluation_outbox IS
  'Transactional outbox managing LLM evaluations with quiescence scheduling and lease tokens.';

CREATE INDEX IF NOT EXISTS idx_evaluation_outbox_claim
  ON public.evaluation_outbox (scheduled_at, updated_at)
  WHERE status IN ('pending', 'reopened');

CREATE INDEX IF NOT EXISTS idx_evaluation_outbox_project_trace
  ON public.evaluation_outbox (project_id, trace_id);

-- ----------------------------------------------------------------------------
-- 2. Create Trace Evaluations Table (Multi-Type Versioned Results)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trace_evaluations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  trace_id      VARCHAR(64) NOT NULL,
  eval_type     VARCHAR(32) NOT NULL,
  trace_version INTEGER NOT NULL,
  score         NUMERIC(3,1) NOT NULL CHECK (score >= 0 AND score <= 10),
  reasoning     TEXT,
  flagged       BOOLEAN NOT NULL DEFAULT false,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_trace_eval_version UNIQUE (project_id, trace_id, eval_type, trace_version)
);

COMMENT ON TABLE public.trace_evaluations IS
  'Stores multi-type evaluation results partitioned/versioned per trace execution.';

CREATE INDEX IF NOT EXISTS idx_trace_eval_lookup
  ON public.trace_evaluations (project_id, trace_id, eval_type);

-- ----------------------------------------------------------------------------
-- 3. Create Ingestion Batch Checkpoints Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingestion_batch_checkpoints (
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL,
  batch_digest    VARCHAR(64) NOT NULL,
  expected_count  INTEGER NOT NULL,
  persisted_count INTEGER NOT NULL,
  committed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, batch_id)
);

COMMENT ON TABLE public.ingestion_batch_checkpoints IS
  'Cryptographic checkpoint table confirming durable PostgreSQL batch persistence.';

CREATE INDEX IF NOT EXISTS idx_checkpoints_project
  ON public.ingestion_batch_checkpoints (project_id, batch_id);

-- ----------------------------------------------------------------------------
-- 4. Row Level Security & Access Grants
-- ----------------------------------------------------------------------------
ALTER TABLE public.evaluation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trace_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_batch_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "outbox: org members can view outbox"
  ON public.evaluation_outbox FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

CREATE POLICY "trace_evals: org members can view evaluations"
  ON public.trace_evaluations FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

CREATE POLICY "checkpoints: org members can view checkpoints"
  ON public.ingestion_batch_checkpoints FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

REVOKE ALL ON public.evaluation_outbox FROM public, anon;
GRANT SELECT ON public.evaluation_outbox TO authenticated;
GRANT ALL ON public.evaluation_outbox TO service_role;

REVOKE ALL ON public.trace_evaluations FROM public, anon;
GRANT SELECT ON public.trace_evaluations TO authenticated;
GRANT ALL ON public.trace_evaluations TO service_role;

REVOKE ALL ON public.ingestion_batch_checkpoints FROM public, anon;
GRANT SELECT ON public.ingestion_batch_checkpoints TO authenticated;
GRANT ALL ON public.ingestion_batch_checkpoints TO service_role;

COMMIT;
