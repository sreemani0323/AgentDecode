-- ============================================================================
-- Migration: 008_atomic_identity_and_outbox_functions.sql
-- Description: Stored procedures and atomic functions for single-transaction
--              identity registration, span ingestion, pending parent resolution
--              with mutual exclusion advisory locking, outbox claims, and
--              6-condition worker finalization.
-- Database Target: PostgreSQL 18
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Two-Statement Atomic Identity Registration Function
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
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_db_id UUID;
  v_first_started_at TIMESTAMPTZ;
  v_attempt INTEGER := 0;
BEGIN
  WHILE v_attempt < 3 LOOP
    v_attempt := v_attempt + 1;

    -- Statement 1: Attempt registration
    INSERT INTO public.span_identity_ledger (
      project_id, trace_id, span_id, db_id, first_started_at, created_at
    )
    VALUES (
      p_project_id, p_trace_id, p_span_id, gen_random_uuid(), p_started_at, clock_timestamp()
    )
    ON CONFLICT (project_id, trace_id, span_id) DO NOTHING
    RETURNING span_identity_ledger.db_id, span_identity_ledger.first_started_at
    INTO v_db_id, v_first_started_at;

    IF v_db_id IS NOT NULL THEN
      RETURN QUERY SELECT v_db_id, v_first_started_at, true;
      RETURN;
    END IF;

    -- Statement 2: Read committed identity with shared row lock
    SELECT l.db_id, l.first_started_at
    INTO v_db_id, v_first_started_at
    FROM public.span_identity_ledger l
    WHERE l.project_id = p_project_id
      AND l.trace_id = p_trace_id
      AND l.span_id = p_span_id
    FOR SHARE;

    IF v_db_id IS NOT NULL THEN
      RETURN QUERY SELECT v_db_id, v_first_started_at, false;
      RETURN;
    END IF;

    -- Conflict occurred but conflicting transaction rolled back or pruned; backoff
    PERFORM pg_sleep(0.005 * v_attempt);
  END LOOP;

  RAISE EXCEPTION 'Failed to register span identity after 3 attempts for project %, trace %, span %',
    p_project_id, p_trace_id, p_span_id
    USING ERRCODE = '55P03';
END;
$$;

DROP FUNCTION IF EXISTS public.ingest_span_transactional CASCADE;
DROP FUNCTION IF EXISTS public.ingest_spans_batch_transactional CASCADE;

-- ----------------------------------------------------------------------------
-- 2. Single-Transaction Atomic Span Ingestion with Advisory Locking
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
  p_started_at TIMESTAMPTZ DEFAULT clock_timestamp(),
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
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_db_id UUID;
  v_first_started_at TIMESTAMPTZ;
  v_was_inserted BOOLEAN;
  v_resolved_parent_id UUID := p_parent_db_id;
  v_is_parent_pending BOOLEAN := false;
  v_parent_ledger_id UUID;
  v_lock1 INTEGER;
  v_lock2 INTEGER;
  r RECORD;
BEGIN
  -- 1. Mutual-Exclusion Advisory Locking to eliminate parent/child race condition
  IF p_parent_span_id_hex IS NOT NULL AND p_parent_span_id_hex <> '' THEN
    v_lock1 := hashtext(p_parent_span_id_hex);
    v_lock2 := hashtext(p_span_id);
    IF v_lock1 < v_lock2 THEN
      PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text || ':' || p_trace_id), v_lock1);
      PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text || ':' || p_trace_id), v_lock2);
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text || ':' || p_trace_id), v_lock2);
      PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text || ':' || p_trace_id), v_lock1);
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text || ':' || p_trace_id), hashtext(p_span_id));
  END IF;

  -- 2. Register Span Identity (Two-Statement Pattern)
  INSERT INTO public.span_identity_ledger (
    project_id, trace_id, span_id, db_id, first_started_at, created_at
  )
  VALUES (
    p_project_id, p_trace_id, p_span_id, gen_random_uuid(), p_started_at, clock_timestamp()
  )
  ON CONFLICT (project_id, trace_id, span_id) DO NOTHING
  RETURNING span_identity_ledger.db_id, span_identity_ledger.first_started_at
  INTO v_db_id, v_first_started_at;

  IF v_db_id IS NOT NULL THEN
    v_was_inserted := true;
  ELSE
    SELECT l.db_id, l.first_started_at
    INTO v_db_id, v_first_started_at
    FROM public.span_identity_ledger l
    WHERE l.project_id = p_project_id
      AND l.trace_id = p_trace_id
      AND l.span_id = p_span_id
    FOR SHARE;
    v_was_inserted := false;
  END IF;

  -- 3. Resolve Parent
  IF v_resolved_parent_id IS NULL AND p_parent_span_id_hex IS NOT NULL AND p_parent_span_id_hex <> '' THEN
    SELECT l.db_id INTO v_parent_ledger_id
    FROM public.span_identity_ledger l
    WHERE l.project_id = p_project_id
      AND l.trace_id = p_trace_id
      AND l.span_id = p_parent_span_id_hex;

    IF v_parent_ledger_id IS NOT NULL THEN
      v_resolved_parent_id := v_parent_ledger_id;
    ELSE
      v_is_parent_pending := true;
      INSERT INTO public.pending_parent_resolutions (
        project_id, trace_id, parent_span_id_hex, child_span_id, child_started_at, created_at, expires_at
      )
      VALUES (
        p_project_id, p_trace_id, p_parent_span_id_hex, v_db_id, v_first_started_at, clock_timestamp(), clock_timestamp() + INTERVAL '1 hour'
      );
    END IF;
  END IF;

  -- 4. Insert into spans table (only if new span)
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
      p_output_tokens, p_cost_usd, COALESCE(p_metadata, '{}'::jsonb), clock_timestamp(),
      p_trace_id, p_span_id, p_is_legacy, COALESCE(p_attributes, '{}'::jsonb), COALESCE(p_links, '[]'::jsonb),
      p_workflow_step, p_iteration_index
    );
  END IF;

  -- 5. Resolve any pending children that arrived earlier waiting for this span
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

  -- 6. Schedule evaluation outbox atomically within same transaction
  IF p_span_type = 'llm' THEN
    INSERT INTO public.evaluation_outbox (
      project_id, trace_id, eval_type, trace_version, status,
      scheduled_at, payload, created_at, updated_at
    )
    VALUES (
      p_project_id, p_trace_id, 'span_score', 1, 'pending',
      clock_timestamp() + INTERVAL '15 seconds',
      jsonb_build_object('span_id', v_db_id, 'input', p_input, 'output', p_output),
      clock_timestamp(), clock_timestamp()
    )
    ON CONFLICT (project_id, trace_id, eval_type) DO UPDATE
      SET trace_version = evaluation_outbox.trace_version + 1,
          status = 'reopened',
          lease_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          scheduled_at = clock_timestamp() + INTERVAL '15 seconds',
          payload = evaluation_outbox.payload || jsonb_build_object('span_id', v_db_id, 'input', p_input, 'output', p_output),
          updated_at = clock_timestamp();
  END IF;

  RETURN QUERY SELECT v_db_id, p_trace_id, p_span_id, v_first_started_at, v_was_inserted, v_resolved_parent_id, v_is_parent_pending;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Batch Atomic Span Ingestion Function
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
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_elem JSONB;
  v_res RECORD;
  v_client_map JSONB := '{}'::jsonb;
  v_parent_client_id TEXT;
  v_resolved_parent_uuid UUID;
  v_client_id TEXT;
BEGIN
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_spans)
  LOOP
    v_client_id := v_elem->>'client_span_id';
    v_parent_client_id := v_elem->>'parent_client_span_id';
    v_resolved_parent_uuid := NULL;

    IF v_elem ? 'parent_span_id' AND v_elem->>'parent_span_id' IS NOT NULL THEN
      v_resolved_parent_uuid := (v_elem->>'parent_span_id')::UUID;
    ELSIF v_parent_client_id IS NOT NULL AND v_client_map ? v_parent_client_id THEN
      v_resolved_parent_uuid := (v_client_map->>v_parent_client_id)::UUID;
    END IF;

    SELECT * INTO v_res FROM public.ingest_span_transactional(
      p_project_id := p_project_id,
      p_session_id := p_session_id,
      p_trace_id := v_elem->>'trace_id',
      p_span_id := v_elem->>'span_id',
      p_parent_span_id_hex := v_elem->>'parent_span_id_hex',
      p_parent_db_id := v_resolved_parent_uuid,
      p_name := COALESCE(v_elem->>'name', 'unnamed_span'),
      p_span_type := COALESCE(v_elem->>'span_type', 'chain'),
      p_status := COALESCE(v_elem->>'status', 'ok'),
      p_started_at := (v_elem->>'started_at')::TIMESTAMPTZ,
      p_ended_at := (v_elem->>'ended_at')::TIMESTAMPTZ,
      p_duration_ms := (v_elem->>'duration_ms')::INTEGER,
      p_model := v_elem->>'model',
      p_input := v_elem->'input',
      p_output := v_elem->'output',
      p_error_message := v_elem->>'error_message',
      p_input_tokens := (v_elem->>'input_tokens')::INTEGER,
      p_output_tokens := (v_elem->>'output_tokens')::INTEGER,
      p_cost_usd := (v_elem->>'cost_usd')::NUMERIC,
      p_metadata := COALESCE(v_elem->'metadata', '{}'::jsonb),
      p_is_legacy := COALESCE((v_elem->>'is_legacy')::BOOLEAN, false),
      p_attributes := COALESCE(v_elem->'attributes', '{}'::jsonb),
      p_links := COALESCE(v_elem->'links', '[]'::jsonb),
      p_workflow_step := (v_elem->>'workflow_step')::INTEGER,
      p_iteration_index := (v_elem->>'iteration_index')::INTEGER
    );

    IF v_client_id IS NOT NULL THEN
      v_client_map := jsonb_set(v_client_map, ARRAY[v_client_id], to_jsonb(v_res.out_db_id::text));
    END IF;

    RETURN QUERY SELECT v_res.out_db_id, v_res.out_trace_id, v_res.out_span_id, v_res.out_first_started_at, v_res.out_was_inserted, v_client_id;
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Worker Claim Function (Quiescence & FOR UPDATE SKIP LOCKED)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_evaluation_job(
  p_worker_id VARCHAR(64),
  p_lease_duration_seconds INTEGER DEFAULT 180
)
RETURNS TABLE (
  outbox_id UUID,
  project_id UUID,
  trace_id VARCHAR(64),
  eval_type VARCHAR(32),
  trace_version INTEGER,
  lease_token UUID,
  payload JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lease_token UUID := gen_random_uuid();
  v_lease_expires TIMESTAMPTZ := clock_timestamp() + (p_lease_duration_seconds || ' seconds')::interval;
BEGIN
  RETURN QUERY
  UPDATE public.evaluation_outbox o
  SET status = 'running',
      claimed_by = p_worker_id,
      lease_token = v_lease_token,
      lease_expires_at = v_lease_expires,
      updated_at = clock_timestamp()
  WHERE o.id = (
    SELECT sub.id
    FROM public.evaluation_outbox sub
    WHERE sub.retry_count < sub.max_retries
      AND (
        (sub.status IN ('pending', 'reopened') AND sub.scheduled_at <= clock_timestamp())
        OR (sub.status = 'running' AND sub.lease_expires_at < clock_timestamp())
      )
    ORDER BY sub.scheduled_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING o.id, o.project_id, o.trace_id, o.eval_type, o.trace_version, o.lease_token, o.payload;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. 6-Condition Atomic Worker Finalization Function
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project_id UUID;
  v_trace_id VARCHAR(64);
  v_eval_type VARCHAR(32);
  v_trace_version INTEGER;
  v_lease_token UUID;
  v_status VARCHAR(32);
  v_lease_expires_at TIMESTAMPTZ;
BEGIN
  -- 1. Lock outbox row FOR UPDATE
  SELECT o.project_id, o.trace_id, o.eval_type, o.trace_version, o.lease_token, o.status, o.lease_expires_at
  INTO v_project_id, v_trace_id, v_eval_type, v_trace_version, v_lease_token, v_status, v_lease_expires_at
  FROM public.evaluation_outbox o
  WHERE o.id = p_outbox_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- 2. Verify all 6 strict conditions
  IF v_status <> 'running'
     OR v_lease_token IS DISTINCT FROM p_lease_token
     OR v_trace_version <> p_trace_version
     OR v_lease_expires_at <= clock_timestamp() THEN
    RETURN false;
  END IF;

  -- 3. Persist score to trace_evaluations
  INSERT INTO public.trace_evaluations (
    project_id, trace_id, eval_type, trace_version, score, reasoning, flagged, generated_at
  )
  VALUES (
    v_project_id, v_trace_id, v_eval_type, v_trace_version, p_score, p_reasoning, p_flagged, clock_timestamp()
  )
  ON CONFLICT (project_id, trace_id, eval_type, trace_version) DO UPDATE
    SET score = EXCLUDED.score,
        reasoning = EXCLUDED.reasoning,
        flagged = EXCLUDED.flagged,
        generated_at = EXCLUDED.generated_at;

  -- 4. If span_id is provided, also idempotently persist to span-level eval_scores
  IF p_span_id IS NOT NULL THEN
    INSERT INTO public.eval_scores (
      span_id, score, reasoning, flagged, generated_at
    )
    VALUES (
      p_span_id, p_score, p_reasoning, p_flagged, clock_timestamp()
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
      updated_at = clock_timestamp()
  WHERE id = p_outbox_id;

  RETURN true;
END;
$$;

-- Grants
GRANT EXECUTE ON FUNCTION public.register_span_identity(UUID, VARCHAR, VARCHAR, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_span_transactional(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, JSONB, TEXT, INTEGER, INTEGER, NUMERIC, JSONB, BOOLEAN, JSONB, JSONB, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_spans_batch_transactional(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_evaluation_job(VARCHAR, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_evaluation_job(UUID, VARCHAR, UUID, INTEGER, NUMERIC, TEXT, BOOLEAN, UUID) TO service_role;

COMMIT;
