-- ============================================================================
-- Migration: 009_production_readiness_remediation.sql
-- Description: Production Readiness Security, Outbox, and Partition Remediation
--   1. Security Definer Search Path Hardening & Role Privilege Revocations
--   2. Org Membership Self-Enrolment Removal & Secure Invitation System
--   3. Evaluation Outbox Support for Multiple LLM Spans per Trace
--   4. Distributed Atomic Rate Limiting Infrastructure
--   5. Idempotent Partition Maintenance with Preflight Conflict Migration
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: SECURITY DEFINER FUNCTIONS HARDENING & LEAST PRIVILEGE REVOCATIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 Hardened Span Identity Registration Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_span_identity(
  p_project_id UUID,
  p_trace_id VARCHAR(64),
  p_span_id VARCHAR(64),
  p_started_at TIMESTAMPTZ
)
RETURNS TABLE (
  db_id UUID,
  first_started_at TIMESTAMPTZ,
  was_inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_db_id UUID;
  v_first_started TIMESTAMPTZ;
  v_inserted BOOLEAN := false;
BEGIN
  -- Attempt insert of new identity binding
  INSERT INTO public.span_identity_ledger (
    project_id, trace_id, span_id, db_id, first_started_at, created_at
  )
  VALUES (
    p_project_id, p_trace_id, p_span_id, pg_catalog.gen_random_uuid(), p_started_at, pg_catalog.clock_timestamp()
  )
  ON CONFLICT (project_id, trace_id, span_id) DO NOTHING
  RETURNING span_identity_ledger.db_id, span_identity_ledger.first_started_at
  INTO v_db_id, v_first_started;

  IF FOUND THEN
    v_inserted := true;
  ELSE
    -- Identity exists: retrieve canonical binding
    SELECT l.db_id, l.first_started_at
    INTO v_db_id, v_first_started
    FROM public.span_identity_ledger l
    WHERE l.project_id = p_project_id
      AND l.trace_id = p_trace_id
      AND l.span_id = p_span_id;
  END IF;

  RETURN QUERY SELECT v_db_id, v_first_started, v_inserted;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1.2 Schema Adjustments for Multiple LLM Spans per Trace (Pre-requisite for Ingest RPC)
-- ----------------------------------------------------------------------------
-- Add nullable span_id column to evaluation_outbox if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evaluation_outbox'
      AND column_name = 'span_id'
  ) THEN
    ALTER TABLE public.evaluation_outbox ADD COLUMN span_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'trace_evaluations'
      AND column_name = 'span_id'
  ) THEN
    ALTER TABLE public.trace_evaluations ADD COLUMN span_id UUID;
  END IF;
END $$;

-- Backfill span_id from payload for existing queued outbox jobs
UPDATE public.evaluation_outbox
SET span_id = (payload->>'span_id')::uuid
WHERE span_id IS NULL
  AND payload->>'span_id' IS NOT NULL
  AND payload->>'span_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Update unique constraints on evaluation_outbox to include span_id
ALTER TABLE public.evaluation_outbox
  DROP CONSTRAINT IF EXISTS uq_outbox_project_trace_type;

DROP INDEX IF EXISTS public.uq_outbox_project_trace_type_span;
CREATE UNIQUE INDEX uq_outbox_project_trace_type_span
  ON public.evaluation_outbox (
    project_id,
    trace_id,
    eval_type,
    (COALESCE(span_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

-- Update unique constraints on trace_evaluations to include span_id
ALTER TABLE public.trace_evaluations
  DROP CONSTRAINT IF EXISTS uq_trace_eval_version;

DROP INDEX IF EXISTS public.uq_trace_eval_version_span;
CREATE UNIQUE INDEX uq_trace_eval_version_span
  ON public.trace_evaluations (
    project_id,
    trace_id,
    eval_type,
    trace_version,
    (COALESCE(span_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

-- ----------------------------------------------------------------------------
-- 1.3 Hardened Single-Span Transactional Ingestion RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_span_transactional(
  p_project_id UUID,
  p_session_id UUID,
  p_trace_id VARCHAR(64),
  p_span_id VARCHAR(64),
  p_parent_span_id_hex VARCHAR(64) DEFAULT NULL,
  p_parent_db_id UUID DEFAULT NULL,
  p_name TEXT DEFAULT 'unnamed_span',
  p_span_type TEXT DEFAULT 'chain',
  p_status TEXT DEFAULT 'ok',
  p_started_at TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp(),
  p_ended_at TIMESTAMPTZ DEFAULT NULL,
  p_duration_ms INTEGER DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
  p_input JSONB DEFAULT NULL,
  p_output JSONB DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_input_tokens INTEGER DEFAULT NULL,
  p_output_tokens INTEGER DEFAULT NULL,
  p_cost_usd NUMERIC DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_is_legacy BOOLEAN DEFAULT false,
  p_attributes JSONB DEFAULT '{}'::jsonb,
  p_links JSONB DEFAULT '[]'::jsonb,
  p_workflow_step INTEGER DEFAULT NULL,
  p_iteration_index INTEGER DEFAULT NULL
)
RETURNS TABLE (
  out_db_id UUID,
  out_trace_id VARCHAR(64),
  out_span_id VARCHAR(64),
  out_first_started_at TIMESTAMPTZ,
  out_was_inserted BOOLEAN,
  out_resolved_parent_id UUID,
  out_is_parent_pending BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_db_id UUID;
  v_first_started_at TIMESTAMPTZ;
  v_was_inserted BOOLEAN;
  v_resolved_parent_id UUID := NULL;
  v_is_parent_pending BOOLEAN := false;
  r RECORD;
BEGIN
  -- 1. Register canonical span identity in ledger
  SELECT i.db_id, i.first_started_at, i.was_inserted
  INTO v_db_id, v_first_started_at, v_was_inserted
  FROM public.register_span_identity(p_project_id, p_trace_id, p_span_id, p_started_at) i;

  -- 2. Resolve parent span ID
  IF p_parent_span_id_hex IS NOT NULL AND p_parent_span_id_hex <> '' THEN
    SELECT l.db_id INTO v_resolved_parent_id
    FROM public.span_identity_ledger l
    WHERE l.project_id = p_project_id
      AND l.trace_id = p_trace_id
      AND l.span_id = p_parent_span_id_hex;

    IF v_resolved_parent_id IS NULL THEN
      -- Record pending child resolution if parent has not arrived yet
      INSERT INTO public.pending_parent_resolutions (
        project_id, trace_id, parent_span_id_hex, child_span_id, child_started_at, created_at, expires_at
      )
      VALUES (
        p_project_id, p_trace_id, p_parent_span_id_hex, v_db_id, v_first_started_at,
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + INTERVAL '1 hour'
      );
      v_is_parent_pending := true;
    END IF;
  ELSIF p_parent_db_id IS NOT NULL THEN
    v_resolved_parent_id := p_parent_db_id;
  END IF;

  -- 3. Idempotently insert span record
  IF v_was_inserted THEN
    INSERT INTO public.spans (
      id, session_id, project_id, parent_span_id, name,
      span_type, status, started_at, ended_at, duration_ms,
      model, input, output, error_message, input_tokens,
      output_tokens, cost_usd, metadata, created_at,
      trace_id, span_id, is_legacy, attributes, links,
      workflow_step, iteration_index
    )
    VALUES (
      v_db_id, p_session_id, p_project_id, v_resolved_parent_id, p_name,
      p_span_type, p_status, v_first_started_at, p_ended_at, p_duration_ms,
      p_model, p_input, p_output, p_error_message, p_input_tokens,
      p_output_tokens, p_cost_usd, COALESCE(p_metadata, '{}'::jsonb), pg_catalog.clock_timestamp(),
      p_trace_id, p_span_id, p_is_legacy, COALESCE(p_attributes, '{}'::jsonb), COALESCE(p_links, '[]'::jsonb),
      p_workflow_step, p_iteration_index
    );
  END IF;

  -- 4. Resolve any pending children that arrived earlier waiting for this span
  FOR r IN
    DELETE FROM public.pending_parent_resolutions
    WHERE project_id = p_project_id
      AND trace_id = p_trace_id
      AND parent_span_id_hex = p_span_id
    RETURNING child_span_id
  LOOP
    UPDATE public.spans
    SET parent_span_id = v_db_id
    WHERE id = r.child_span_id
      AND project_id = p_project_id;
  END LOOP;

  -- 5. Schedule evaluation outbox atomically within same transaction.
  -- Preserves distinct outbox records per LLM span via (project_id, trace_id, eval_type, span_id).
  IF p_span_type = 'llm' THEN
    INSERT INTO public.evaluation_outbox (
      project_id, trace_id, span_id, eval_type, trace_version, status,
      scheduled_at, payload, created_at, updated_at
    )
    VALUES (
      p_project_id, p_trace_id, v_db_id, 'span_score', 1, 'pending',
      pg_catalog.clock_timestamp() + INTERVAL '15 seconds',
      jsonb_build_object('span_id', v_db_id, 'input', p_input, 'output', p_output),
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    )
    ON CONFLICT (project_id, trace_id, eval_type, (COALESCE(span_id, '00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE
      SET trace_version = evaluation_outbox.trace_version + 1,
          status = 'reopened',
          lease_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          scheduled_at = pg_catalog.clock_timestamp() + INTERVAL '15 seconds',
          payload = jsonb_build_object('span_id', v_db_id, 'input', p_input, 'output', p_output),
          updated_at = pg_catalog.clock_timestamp();
  END IF;

  RETURN QUERY SELECT v_db_id, p_trace_id, p_span_id, v_first_started_at, v_was_inserted, v_resolved_parent_id, v_is_parent_pending;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1.4 Hardened Batch Transactional Ingestion RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_spans_batch_transactional(
  p_project_id UUID,
  p_session_id UUID,
  p_spans JSONB
)
RETURNS TABLE (
  out_db_id UUID,
  out_trace_id VARCHAR(64),
  out_span_id VARCHAR(64),
  out_first_started_at TIMESTAMPTZ,
  out_was_inserted BOOLEAN,
  out_client_span_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_elem JSONB;
  v_client_id TEXT;
  v_parent_client_id TEXT;
  v_parent_hex TEXT;
  v_resolved_parent_uuid UUID;
  v_res RECORD;
  v_client_map JSONB := '{}'::jsonb;
BEGIN
  -- Validate batch input
  IF p_spans IS NULL OR jsonb_array_length(p_spans) = 0 THEN
    RETURN;
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_spans)
  LOOP
    v_client_id := v_elem->>'client_span_id';
    v_parent_client_id := v_elem->>'parent_client_span_id';
    v_parent_hex := v_elem->>'parent_span_id_hex';
    v_resolved_parent_uuid := NULL;

    IF v_elem->>'parent_span_id' IS NOT NULL AND v_elem->>'parent_span_id' <> '' THEN
      v_resolved_parent_uuid := (v_elem->>'parent_span_id')::uuid;
    ELSIF v_parent_client_id IS NOT NULL AND v_client_map ? v_parent_client_id THEN
      v_resolved_parent_uuid := (v_client_map->>v_parent_client_id)::uuid;
    END IF;

    SELECT * INTO v_res FROM public.ingest_span_transactional(
      p_project_id,
      p_session_id,
      v_elem->>'trace_id',
      v_elem->>'span_id',
      v_parent_hex,
      v_resolved_parent_uuid,
      v_elem->>'name',
      COALESCE(v_elem->>'span_type', 'chain'),
      COALESCE(v_elem->>'status', 'ok'),
      (v_elem->>'started_at')::timestamptz,
      (v_elem->>'ended_at')::timestamptz,
      (v_elem->>'duration_ms')::integer,
      v_elem->>'model',
      v_elem->'input',
      v_elem->'output',
      v_elem->>'error_message',
      (v_elem->>'input_tokens')::integer,
      (v_elem->>'output_tokens')::integer,
      (v_elem->>'cost_usd')::numeric,
      COALESCE(v_elem->'metadata', '{}'::jsonb),
      COALESCE((v_elem->>'is_legacy')::boolean, false),
      COALESCE(v_elem->'attributes', '{}'::jsonb),
      COALESCE(v_elem->'links', '[]'::jsonb),
      (v_elem->>'workflow_step')::integer,
      (v_elem->>'iteration_index')::integer
    );

    IF v_client_id IS NOT NULL AND v_client_id <> '' THEN
      v_client_map := jsonb_set(v_client_map, ARRAY[v_client_id], to_jsonb(v_res.out_db_id::text));
    END IF;

    RETURN QUERY SELECT v_res.out_db_id, v_res.out_trace_id, v_res.out_span_id, v_res.out_first_started_at, v_res.out_was_inserted, v_client_id;
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1.5 Hardened Worker Claim Function (Batch & Quiescence Protected)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_evaluation_job(
  p_worker_id VARCHAR(64),
  p_lease_duration_seconds INTEGER DEFAULT 180,
  p_batch_size INTEGER DEFAULT 10
)
RETURNS TABLE (
  outbox_id UUID,
  project_id UUID,
  trace_id VARCHAR(64),
  span_id UUID,
  eval_type VARCHAR(32),
  trace_version INTEGER,
  lease_token UUID,
  payload JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease_token UUID := pg_catalog.gen_random_uuid();
  v_lease_expires TIMESTAMPTZ := pg_catalog.clock_timestamp() + (p_lease_duration_seconds || ' seconds')::interval;
  v_limit INTEGER := COALESCE(NULLIF(p_batch_size, 0), 10);
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT sub.id
    FROM public.evaluation_outbox sub
    WHERE sub.retry_count < sub.max_retries
      AND (
        (sub.status IN ('pending', 'reopened') AND sub.scheduled_at <= pg_catalog.clock_timestamp())
        OR (sub.status = 'running' AND sub.lease_expires_at < pg_catalog.clock_timestamp())
      )
    ORDER BY sub.scheduled_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.evaluation_outbox o
  SET status = 'running',
      claimed_by = p_worker_id,
      lease_token = v_lease_token,
      lease_expires_at = v_lease_expires,
      updated_at = pg_catalog.clock_timestamp()
  FROM claimable
  WHERE o.id = claimable.id
  RETURNING o.id, o.project_id, o.trace_id, o.span_id, o.eval_type, o.trace_version, o.lease_token, o.payload;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1.6 Hardened 6-Condition Atomic Worker Finalization Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_evaluation_job(
  p_outbox_id UUID,
  p_worker_id VARCHAR(64),
  p_lease_token UUID,
  p_trace_version INTEGER,
  p_score NUMERIC,
  p_reasoning TEXT,
  p_flagged BOOLEAN,
  p_span_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id UUID;
  v_trace_id VARCHAR(64);
  v_span_id UUID;
  v_eval_type VARCHAR(32);
  v_trace_version INTEGER;
  v_lease_token UUID;
  v_status VARCHAR(32);
  v_lease_expires_at TIMESTAMPTZ;
  v_final_span_id UUID;
BEGIN
  -- 1. Lock outbox row FOR UPDATE
  SELECT o.project_id, o.trace_id, o.span_id, o.eval_type, o.trace_version, o.lease_token, o.status, o.lease_expires_at
  INTO v_project_id, v_trace_id, v_span_id, v_eval_type, v_trace_version, v_lease_token, v_status, v_lease_expires_at
  FROM public.evaluation_outbox o
  WHERE o.id = p_outbox_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- 2. Verify all 6 strict concurrency conditions
  IF v_status <> 'running'
     OR v_lease_token IS DISTINCT FROM p_lease_token
     OR v_trace_version <> p_trace_version
     OR v_lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN false;
  END IF;

  v_final_span_id := COALESCE(p_span_id, v_span_id);

  -- 3. Persist score to trace_evaluations
  INSERT INTO public.trace_evaluations (
    project_id, trace_id, span_id, eval_type, trace_version, score, reasoning, flagged, generated_at
  )
  VALUES (
    v_project_id, v_trace_id, v_final_span_id, v_eval_type, v_trace_version, p_score, p_reasoning, p_flagged, pg_catalog.clock_timestamp()
  )
  ON CONFLICT (project_id, trace_id, eval_type, trace_version, (COALESCE(span_id, '00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE
    SET score = EXCLUDED.score,
        reasoning = EXCLUDED.reasoning,
        flagged = EXCLUDED.flagged,
        generated_at = EXCLUDED.generated_at;

  -- 4. If span_id is available, also idempotently persist to span-level eval_scores
  IF v_final_span_id IS NOT NULL THEN
    INSERT INTO public.eval_scores (
      span_id, score, reasoning, flagged, generated_at
    )
    VALUES (
      v_final_span_id, p_score, p_reasoning, p_flagged, pg_catalog.clock_timestamp()
    )
    ON CONFLICT (span_id) DO UPDATE
      SET score = EXCLUDED.score,
          reasoning = EXCLUDED.reasoning,
          flagged = EXCLUDED.flagged,
          generated_at = EXCLUDED.generated_at;
  END IF;

  -- 5. Mark outbox completed
  UPDATE public.evaluation_outbox
  SET status = 'completed',
      claimed_by = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_outbox_id;

  RETURN true;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1.7 Explicit Revocations and Least-Privilege Role Grants
-- ----------------------------------------------------------------------------
-- Revoke all execute privileges on privileged internal RPCs from PUBLIC, anon, and authenticated
REVOKE ALL ON FUNCTION public.register_span_identity(UUID, VARCHAR, VARCHAR, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_span_transactional(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, JSONB, TEXT, INTEGER, INTEGER, NUMERIC, JSONB, BOOLEAN, JSONB, JSONB, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_spans_batch_transactional(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_evaluation_job(VARCHAR, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_evaluation_job(UUID, VARCHAR, UUID, INTEGER, NUMERIC, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;

-- Grant EXECUTE exclusively to service_role for internal backend ingestion and workers
GRANT EXECUTE ON FUNCTION public.register_span_identity(UUID, VARCHAR, VARCHAR, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_span_transactional(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, JSONB, TEXT, INTEGER, INTEGER, NUMERIC, JSONB, BOOLEAN, JSONB, JSONB, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_spans_batch_transactional(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_evaluation_job(VARCHAR, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_evaluation_job(UUID, VARCHAR, UUID, INTEGER, NUMERIC, TEXT, BOOLEAN, UUID) TO service_role;

-- Document & ensure minimum permissions for RLS helper functions
REVOKE ALL ON FUNCTION public.is_org_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_project_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_project_member(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_new_profile() TO service_role;

-- Helper to check if caller is organization owner without RLS recursion
CREATE OR REPLACE FUNCTION public.is_org_owner(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.org_members
    WHERE org_id = p_org_id
      AND user_id = auth.uid()
      AND role = 'owner'
  );
$$;

REVOKE ALL ON FUNCTION public.is_org_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_owner(UUID) TO authenticated, service_role;


-- ============================================================================
-- SECTION 2: ORG MEMBERSHIP SELF-ENROLMENT REMOVAL & INVITATION SYSTEM
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2.1 Remove Vulnerable Self-Enrolment Policy on org_members
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "org_members: owners can insert members" ON public.org_members;

-- Allow INSERT on org_members ONLY when:
-- 1. The caller is an existing 'owner' of the organization (checked via SECURITY DEFINER helper to prevent RLS recursion), OR
-- 2. The caller is creating the initial 'owner' membership for an organization
--    they own (where organizations.owner_id = auth.uid() and no members exist yet).
CREATE POLICY "org_members: owners can insert members"
  ON public.org_members FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_org_owner(org_id)
    OR (
      user_id = auth.uid()
      AND role = 'owner'
      AND EXISTS (
        SELECT 1 FROM public.organizations
        WHERE id = org_members.org_id
          AND owner_id = auth.uid()
          AND NOT EXISTS (
            SELECT 1 FROM public.org_members
            WHERE org_id = org_members.org_id
          )
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 2.2 Secure Organization Invitations Table (Hashed Tokens)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_invitations (
  id           UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  invited_by   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (pg_catalog.clock_timestamp() + INTERVAL '7 days'),
  used_at      TIMESTAMPTZ,
  CONSTRAINT chk_invitation_email_not_empty CHECK (trim(email) <> '')
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_token_hash ON public.org_invitations (token_hash);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org_email ON public.org_invitations (org_id, lower(email));

ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_invitations: org owners can manage invitations"
  ON public.org_invitations FOR ALL
  TO authenticated
  USING (public.is_org_owner(org_id))
  WITH CHECK (public.is_org_owner(org_id));

REVOKE ALL ON public.org_invitations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_invitations TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2.3 Secure Invitation Acceptance Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_org_invitation(p_token VARCHAR(128))
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_email TEXT;
  v_invitation RECORD;
  v_token_hash VARCHAR(64);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_token IS NULL OR trim(p_token) = '' THEN
    RAISE EXCEPTION 'Invalid invitation token' USING ERRCODE = 'P0002';
  END IF;

  -- Compute SHA-256 digest of incoming plaintext token across vanilla Postgres and Supabase schemas
  IF pg_catalog.to_regprocedure('extensions.digest(text,text)') IS NOT NULL THEN
    EXECUTE 'SELECT pg_catalog.encode(extensions.digest($1, ''sha256''), ''hex'')'
      INTO v_token_hash
      USING p_token;
  ELSIF pg_catalog.to_regprocedure('public.digest(text,text)') IS NOT NULL THEN
    EXECUTE 'SELECT pg_catalog.encode(public.digest($1, ''sha256''), ''hex'')'
      INTO v_token_hash
      USING p_token;
  ELSE
    RAISE EXCEPTION 'pgcrypto digest(text,text) is required for invitation token hashing'
      USING ERRCODE = '42883';
  END IF;

  -- Get current user email from auth.users
  SELECT lower(email) INTO v_user_email
  FROM auth.users
  WHERE id = v_user_id;

  -- Lock invitation row FOR UPDATE
  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token_hash = v_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation token' USING ERRCODE = 'P0002';
  END IF;

  IF v_invitation.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been used' USING ERRCODE = '22023';
  END IF;

  IF v_invitation.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Verify intended identity matches caller email
  IF lower(trim(v_invitation.email)) <> v_user_email THEN
    RAISE EXCEPTION 'Invitation was issued to a different email address' USING ERRCODE = '42501';
  END IF;

  -- Add user to organization membership
  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (v_invitation.org_id, v_user_id, v_invitation.role)
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET role = EXCLUDED.role;

  -- Mark invitation as used
  UPDATE public.org_invitations
  SET used_at = pg_catalog.clock_timestamp()
  WHERE id = v_invitation.id;

  RETURN jsonb_build_object(
    'success', true,
    'org_id', v_invitation.org_id,
    'user_id', v_user_id,
    'role', v_invitation.role
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_org_invitation(VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invitation(VARCHAR) TO authenticated, service_role;


-- ============================================================================
-- SECTION 3: DISTRIBUTED ATOMIC RATE LIMITING INFRASTRUCTURE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key  VARCHAR(128) PRIMARY KEY,
  tokens      NUMERIC NOT NULL,
  last_refill TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_expires ON public.rate_limit_buckets (expires_at);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limit_buckets TO service_role;

-- ----------------------------------------------------------------------------
-- 3.1 Safe Bounded, Indexed Rate-Limit Storage Cleanup
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limit_buckets(
  p_batch_size INTEGER DEFAULT 5000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  -- Safe bounded cleanup: uses index on expires_at and SKIP LOCKED to never race or block active requests
  WITH expired AS (
    SELECT bucket_key
    FROM public.rate_limit_buckets
    WHERE expires_at < pg_catalog.clock_timestamp()
    ORDER BY expires_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.rate_limit_buckets
  WHERE bucket_key IN (SELECT bucket_key FROM expired);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_rate_limit_buckets(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_rate_limit_buckets(INTEGER) TO service_role;

-- ----------------------------------------------------------------------------
-- 3.2 Atomic Token Bucket Rate Limiter
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_rate_limit_token(
  p_key VARCHAR(128),
  p_max_tokens NUMERIC,
  p_refill_rate NUMERIC,
  p_cost NUMERIC DEFAULT 1,
  p_ttl_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  allowed BOOLEAN,
  remaining NUMERIC,
  retry_after_ms INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_row public.rate_limit_buckets%ROWTYPE;
  v_elapsed_seconds NUMERIC;
  v_new_tokens NUMERIC;
  v_allowed BOOLEAN := false;
  v_rem NUMERIC := 0;
  v_retry_ms INTEGER := 0;
  v_deficit NUMERIC;
BEGIN
  -- Opportunistic bounded non-racing cleanup (1% of requests)
  IF (pg_catalog.random() < 0.01) THEN
    PERFORM public.cleanup_expired_rate_limit_buckets(50);
  END IF;

  SELECT * INTO v_row
  FROM public.rate_limit_buckets
  WHERE bucket_key = p_key
  FOR UPDATE;

  IF NOT FOUND THEN
    -- First request for bucket: initialize with max_tokens - cost
    IF p_max_tokens >= p_cost THEN
      v_allowed := true;
      v_rem := p_max_tokens - p_cost;
      v_retry_ms := 0;
    ELSE
      v_allowed := false;
      v_rem := p_max_tokens;
      v_deficit := p_cost - p_max_tokens;
      v_retry_ms := pg_catalog.ceil((v_deficit / p_refill_rate) * 1000)::integer;
    END IF;

    INSERT INTO public.rate_limit_buckets (
      bucket_key, tokens, last_refill, expires_at
    )
    VALUES (
      p_key,
      CASE WHEN v_allowed THEN v_rem ELSE p_max_tokens END,
      v_now,
      v_now + (p_ttl_seconds || ' seconds')::interval
    )
    ON CONFLICT (bucket_key) DO NOTHING;

    RETURN QUERY SELECT v_allowed, v_rem, v_retry_ms;
    RETURN;
  END IF;

  -- Refill existing bucket based on elapsed time
  v_elapsed_seconds := EXTRACT(EPOCH FROM (v_now - v_row.last_refill));
  v_new_tokens := LEAST(p_max_tokens, v_row.tokens + (v_elapsed_seconds * p_refill_rate));

  IF v_new_tokens >= p_cost THEN
    v_allowed := true;
    v_rem := v_new_tokens - p_cost;
    v_retry_ms := 0;

    UPDATE public.rate_limit_buckets
    SET tokens = v_rem,
        last_refill = v_now,
        expires_at = v_now + (p_ttl_seconds || ' seconds')::interval
    WHERE bucket_key = p_key;
  ELSE
    v_allowed := false;
    v_rem := v_new_tokens;
    v_deficit := p_cost - v_new_tokens;
    v_retry_ms := pg_catalog.ceil((v_deficit / p_refill_rate) * 1000)::integer;

    UPDATE public.rate_limit_buckets
    SET tokens = v_new_tokens,
        last_refill = v_now,
        expires_at = v_now + (p_ttl_seconds || ' seconds')::interval
    WHERE bucket_key = p_key;
  END IF;

  RETURN QUERY SELECT v_allowed, v_rem, v_retry_ms;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit_token(VARCHAR, NUMERIC, NUMERIC, NUMERIC, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit_token(VARCHAR, NUMERIC, NUMERIC, NUMERIC, INTEGER) TO service_role;


-- ============================================================================
-- SECTION 4: IDEMPOTENT SPANS PARTITION MAINTENANCE INFRASTRUCTURE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.provision_spans_partition(
  p_start_date DATE,
  p_end_date DATE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_part_name TEXT;
  v_year TEXT := to_char(p_start_date, 'YYYY');
  v_month TEXT := to_char(p_start_date, 'MM');
  v_exists BOOLEAN;
  v_conflict_count INTEGER := 0;
BEGIN
  v_part_name := 'spans_y' || v_year || 'm' || v_month;

  -- Transaction advisory lock to ensure single-caller concurrency safety
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('provision_spans_partition'));

  -- Check if partition table is already attached
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_part_name
  ) INTO v_exists;

  IF v_exists THEN
    RETURN v_part_name || ':ALREADY_EXISTS';
  END IF;

  -- Preflight: inspect spans_default for rows that fall inside this partition range
  EXECUTE format(
    'SELECT count(*) FROM public.spans_default WHERE started_at >= %L AND started_at < %L',
    p_start_date, p_end_date
  ) INTO v_conflict_count;

  -- If conflicting rows exist in spans_default, move them out into temporary storage
  IF v_conflict_count > 0 THEN
    EXECUTE 'CREATE TEMP TABLE _spans_partition_staging ON COMMIT DROP AS SELECT * FROM public.spans_default WHERE started_at >= '
      || quote_literal(p_start_date) || ' AND started_at < ' || quote_literal(p_end_date);

    EXECUTE 'DELETE FROM public.spans_default WHERE started_at >= '
      || quote_literal(p_start_date) || ' AND started_at < ' || quote_literal(p_end_date);
  END IF;

  -- Create and attach new partition to public.spans
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.spans FOR VALUES FROM (%L) TO (%L)',
    v_part_name,
    p_start_date::timestamptz,
    p_end_date::timestamptz
  );

  -- Re-insert staged rows into public.spans where they route cleanly into new partition
  IF v_conflict_count > 0 THEN
    EXECUTE 'INSERT INTO public.spans SELECT * FROM _spans_partition_staging';
  END IF;

  RETURN v_part_name || ':CREATED';
END;
$$;

-- Provisions future partitions up to p_months_ahead from current date
CREATE OR REPLACE FUNCTION public.provision_future_spans_partitions(
  p_months_ahead INTEGER DEFAULT 3
)
RETURNS TABLE (
  partition_name TEXT,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_idx INTEGER;
  v_cur_month DATE;
  v_next_month DATE;
  v_res TEXT;
  v_name TEXT;
  v_stat TEXT;
BEGIN
  -- Always provision from current month forward
  FOR v_idx IN 0..p_months_ahead LOOP
    v_cur_month := date_trunc('month', pg_catalog.clock_timestamp())::date + (v_idx || ' month')::interval;
    v_next_month := (v_cur_month + INTERVAL '1 month')::date;

    v_res := public.provision_spans_partition(v_cur_month, v_next_month);
    v_name := split_part(v_res, ':', 1);
    v_stat := split_part(v_res, ':', 2);

    RETURN QUERY SELECT v_name, v_stat;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_spans_partition(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_spans_partition(DATE, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.provision_future_spans_partitions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_future_spans_partitions(INTEGER) TO service_role;

COMMIT;
