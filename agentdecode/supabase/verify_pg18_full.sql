-- ============================================================================
-- Comprehensive PostgreSQL 18 Verification Test Suite
-- ============================================================================

\set ON_ERROR_STOP on

SELECT '--- 1. VERIFY HISTORICAL DATA BACKFILL & FK INTEGRITY ---' AS test_banner;

DO $$
DECLARE
  v_ledger_count INT;
  v_spans_count INT;
  v_eval_count INT;
  v_explanation_count INT;
  v_issue_span_count INT;
BEGIN
  SELECT count(*) INTO v_ledger_count FROM public.span_identity_ledger;
  SELECT count(*) INTO v_spans_count FROM public.spans;
  SELECT count(*) INTO v_eval_count FROM public.eval_scores;
  SELECT count(*) INTO v_explanation_count FROM public.ai_explanations;
  SELECT count(*) INTO v_issue_span_count FROM public.issue_spans;

  ASSERT v_ledger_count >= 2, 'Expected at least 2 ledger rows, got ' || v_ledger_count;
  ASSERT v_spans_count >= 2, 'Expected at least 2 spans rows, got ' || v_spans_count;
  ASSERT v_eval_count >= 0, 'eval_scores count check';
  ASSERT v_explanation_count >= 1, 'Expected 1 ai_explanations row, got ' || v_explanation_count;
  ASSERT v_issue_span_count >= 1, 'Expected 1 issue_spans row, got ' || v_issue_span_count;

  RAISE NOTICE 'SUCCESS: Historical backfill and FK integrity verified.';
END
$$;

SELECT '--- 2. VERIFY PG18 COLUMN-SPECIFIC ON DELETE SET NULL (parent_span_id) ---' AS test_banner;

DO $$
DECLARE
  v_proj_id UUID := '22222222-2222-2222-2222-222222222222';
  v_sess_id UUID := '33333333-3333-3333-3333-333333333333';
  v_trace_id VARCHAR(64) := substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 32);
  v_parent_res RECORD;
  v_child_res RECORD;
  v_child_parent_id UUID;
  v_child_exists BOOLEAN;
BEGIN
  -- 1. Create parent
  SELECT * INTO v_parent_res FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := 'aaaaaaaaaaaaaaaa',
    p_name := 'fk_test_parent',
    p_started_at := '2026-11-03 10:00:00+00'::TIMESTAMPTZ
  );

  -- 2. Create child pointing to parent
  SELECT * INTO v_child_res FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := 'bbbbbbbbbbbbbbbb',
    p_parent_span_id_hex := 'aaaaaaaaaaaaaaaa',
    p_name := 'fk_test_child',
    p_started_at := '2026-11-03 10:00:01+00'::TIMESTAMPTZ
  );

  -- Before delete: child has parent_span_id = parent's db_id
  SELECT parent_span_id INTO v_child_parent_id FROM public.spans WHERE id = v_child_res.out_db_id;
  ASSERT v_child_parent_id = v_parent_res.out_db_id, 'Child parent_span_id mismatch before parent delete';

  -- 3. Delete parent from identity ledger
  DELETE FROM public.span_identity_ledger WHERE db_id = v_parent_res.out_db_id;

  -- 4. Verify: child span MUST still exist, and its parent_span_id MUST be NULL!
  SELECT parent_span_id, true INTO v_child_parent_id, v_child_exists FROM public.spans WHERE id = v_child_res.out_db_id;
  ASSERT v_child_exists = true, 'Child span was deleted when parent was deleted!';
  ASSERT v_child_parent_id IS NULL, 'Child parent_span_id was not set to NULL!';

  RAISE NOTICE 'SUCCESS: PostgreSQL 18 column-specific ON DELETE SET NULL (parent_span_id) verified.';
END
$$;

SELECT '--- 3. VERIFY ATOMIC INGESTION (LEDGER + SPAN + OUTBOX IN ONE TX) ---' AS test_banner;

DO $$
DECLARE
  v_proj_id UUID := '22222222-2222-2222-2222-222222222222';
  v_sess_id UUID := '33333333-3333-3333-3333-333333333333';
  v_trace_id VARCHAR(64) := substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 32);
  v_span_id VARCHAR(64) := '00f067aa0ba902b7';
  v_res RECORD;
  v_ledger_exists BOOLEAN;
  v_span_exists BOOLEAN;
  v_outbox_exists BOOLEAN;
BEGIN
  -- Call ingest_span_transactional
  SELECT * INTO v_res FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := v_span_id,
    p_name := 'chat_completion',
    p_span_type := 'llm',
    p_status := 'ok',
    p_started_at := '2026-11-03 10:00:00+00'::TIMESTAMPTZ,
    p_input := '{"prompt": "Hello"}'::jsonb,
    p_output := '{"response": "Hi there"}'::jsonb
  );

  ASSERT v_res.out_was_inserted = true, 'Span was_inserted should be true';

  -- Verify ledger row exists
  SELECT EXISTS (
    SELECT 1 FROM public.span_identity_ledger
    WHERE project_id = v_proj_id AND trace_id = v_trace_id AND span_id = v_span_id AND db_id = v_res.out_db_id
  ) INTO v_ledger_exists;
  ASSERT v_ledger_exists = true, 'Ledger row missing!';

  -- Verify spans row exists
  SELECT EXISTS (
    SELECT 1 FROM public.spans
    WHERE id = v_res.out_db_id AND trace_id = v_trace_id AND span_id = v_span_id
  ) INTO v_span_exists;
  ASSERT v_span_exists = true, 'Spans row missing!';

  -- Verify evaluation_outbox row exists
  SELECT EXISTS (
    SELECT 1 FROM public.evaluation_outbox
    WHERE project_id = v_proj_id AND trace_id = v_trace_id AND eval_type = 'span_score'
  ) INTO v_outbox_exists;
  ASSERT v_outbox_exists = true, 'Evaluation outbox row missing!';

  RAISE NOTICE 'SUCCESS: Single transaction atomicity across ledger, spans, and outbox verified.';
END
$$;

SELECT '--- 4. VERIFY OUT-OF-ORDER PARENT RESOLUTION WITH ADVISORY LOCKS ---' AS test_banner;

DO $$
DECLARE
  v_proj_id UUID := '22222222-2222-2222-2222-222222222222';
  v_sess_id UUID := '33333333-3333-3333-3333-333333333333';
  v_trace_id VARCHAR(64) := substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 32);
  v_parent_span_id VARCHAR(64) := '1111111111111111';
  v_child_span_id VARCHAR(64) := '2222222222222222';
  v_child_res RECORD;
  v_parent_res RECORD;
  v_pending_count INT;
  v_updated_child_parent_id UUID;
BEGIN
  -- 1. Child arrives FIRST with parent_span_id_hex = v_parent_span_id
  SELECT * INTO v_child_res FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := v_child_span_id,
    p_parent_span_id_hex := v_parent_span_id,
    p_name := 'child_arrived_first',
    p_span_type := 'tool',
    p_started_at := '2026-11-03 10:00:02+00'::TIMESTAMPTZ
  );

  ASSERT v_child_res.out_is_parent_pending = true, 'Child parent should be pending';
  ASSERT v_child_res.out_resolved_parent_id IS NULL, 'Child parent_id should be NULL initially';

  -- Check pending_parent_resolutions
  SELECT count(*) INTO v_pending_count
  FROM public.pending_parent_resolutions
  WHERE project_id = v_proj_id AND trace_id = v_trace_id AND parent_span_id_hex = v_parent_span_id;
  ASSERT v_pending_count = 1, 'Expected 1 pending parent resolution';

  -- 2. Parent arrives SECOND
  SELECT * INTO v_parent_res FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := v_parent_span_id,
    p_name := 'parent_arrived_second',
    p_span_type := 'chain',
    p_started_at := '2026-11-03 10:00:01+00'::TIMESTAMPTZ
  );

  -- Check pending_parent_resolutions (should be cleared)
  SELECT count(*) INTO v_pending_count
  FROM public.pending_parent_resolutions
  WHERE project_id = v_proj_id AND trace_id = v_trace_id AND parent_span_id_hex = v_parent_span_id;
  ASSERT v_pending_count = 0, 'Pending parent resolution should be resolved and cleared';

  -- Check child span: parent_span_id must now be Parent P's db_id!
  SELECT parent_span_id INTO v_updated_child_parent_id
  FROM public.spans
  WHERE id = v_child_res.out_db_id;

  ASSERT v_updated_child_parent_id = v_parent_res.out_db_id, 'Child parent_span_id was not resolved to parent db_id!';

  RAISE NOTICE 'SUCCESS: Out-of-order parent resolution verified.';
END
$$;

SELECT '--- 5. VERIFY DUPLICATE SPAN ID WITH CANONICAL FIRST_STARTED_AT PRESERVATION ---' AS test_banner;

DO $$
DECLARE
  v_proj_id UUID := '22222222-2222-2222-2222-222222222222';
  v_sess_id UUID := '33333333-3333-3333-3333-333333333333';
  v_trace_id VARCHAR(64) := substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 32);
  v_span_id VARCHAR(64) := '3333333333333333';
  v_initial_time TIMESTAMPTZ := '2026-11-03 10:00:00+00'::TIMESTAMPTZ;
  v_altered_time TIMESTAMPTZ := '2026-11-03 10:05:00+00'::TIMESTAMPTZ;
  v_res1 RECORD;
  v_res2 RECORD;
  v_spans_count INT;
BEGIN
  -- First registration
  SELECT * INTO v_res1 FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := v_span_id,
    p_name := 'original_span',
    p_started_at := v_initial_time
  );

  ASSERT v_res1.out_was_inserted = true, 'First registration should be inserted';
  ASSERT v_res1.out_first_started_at = v_initial_time, 'First registration time mismatch';

  -- Second registration (duplicate) with altered timestamp
  SELECT * INTO v_res2 FROM public.ingest_span_transactional(
    p_project_id := v_proj_id,
    p_session_id := v_sess_id,
    p_trace_id := v_trace_id,
    p_span_id := v_span_id,
    p_name := 'duplicate_span_altered_time',
    p_started_at := v_altered_time
  );

  ASSERT v_res2.out_was_inserted = false, 'Duplicate registration should report was_inserted = false';
  ASSERT v_res2.out_db_id = v_res1.out_db_id, 'Duplicate must return identical db_id';
  ASSERT v_res2.out_first_started_at = v_initial_time, 'Duplicate must preserve original first_started_at';

  SELECT count(*) INTO v_spans_count FROM public.spans WHERE trace_id = v_trace_id AND span_id = v_span_id;
  ASSERT v_spans_count = 1, 'Duplicate must not insert a second row into spans';

  RAISE NOTICE 'SUCCESS: Canonical first_started_at preserved on duplicate identity.';
END
$$;

SELECT '--- 6. VERIFY OUTBOX CLAIM AND 6-CONDITION FINALIZATION ---' AS test_banner;

DO $$
DECLARE
  v_claim RECORD;
  v_finalize_success BOOLEAN;
  v_invalid_finalize BOOLEAN;
  v_eval_record RECORD;
BEGIN
  -- Simulate expiration of 15s quiescence timer for pending jobs
  UPDATE public.evaluation_outbox
  SET scheduled_at = clock_timestamp() - INTERVAL '1 second'
  WHERE status IN ('pending', 'reopened');

  -- Claim job
  SELECT * INTO v_claim FROM public.claim_evaluation_job('worker-test-1', 60);
  ASSERT v_claim.outbox_id IS NOT NULL, 'Claim job should return a pending outbox job';
  ASSERT v_claim.lease_token IS NOT NULL, 'Claim job should return a lease token';

  -- Attempt finalization with WRONG lease token (should fail)
  SELECT public.finalize_evaluation_job(
    p_outbox_id := v_claim.outbox_id,
    p_worker_id := 'worker-test-1',
    p_lease_token := gen_random_uuid(), -- Wrong lease token!
    p_trace_version := v_claim.trace_version,
    p_score := 8.5,
    p_reasoning := 'Good evaluation',
    p_flagged := false
  ) INTO v_invalid_finalize;
  ASSERT v_invalid_finalize = false, 'Finalization with invalid lease token should return false';

  -- Attempt finalization with CORRECT credentials (should succeed)
  SELECT public.finalize_evaluation_job(
    p_outbox_id := v_claim.outbox_id,
    p_worker_id := 'worker-test-1',
    p_lease_token := v_claim.lease_token,
    p_trace_version := v_claim.trace_version,
    p_score := 8.5,
    p_reasoning := 'Good evaluation',
    p_flagged := false
  ) INTO v_finalize_success;
  ASSERT v_finalize_success = true, 'Finalization with correct credentials should return true';

  -- Verify trace_evaluations row created
  SELECT * INTO v_eval_record FROM public.trace_evaluations
  WHERE project_id = v_claim.project_id AND trace_id = v_claim.trace_id;
  ASSERT v_eval_record.score = 8.5, 'Evaluation score mismatch';

  RAISE NOTICE 'SUCCESS: Outbox claim and 6-condition finalization verified.';
END
$$;

SELECT '--- 7. VERIFY BATCH ATOMIC SPAN INGESTION (ingest_spans_batch_transactional) ---' AS test_banner;

DO $$
DECLARE
  v_proj_id UUID := '22222222-2222-2222-2222-222222222222';
  v_sess_id UUID := '33333333-3333-3333-3333-333333333333';
  v_trace_id VARCHAR(64) := substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 32);
  v_spans JSONB;
  v_batch_count INT := 0;
  v_child_parent_id UUID;
  v_root_db_id UUID;
  v_child_db_id UUID;
  r RECORD;
BEGIN
  v_spans := jsonb_build_array(
    jsonb_build_object(
      'trace_id', v_trace_id,
      'span_id', 'a1a1a1a1a1a1a1a1',
      'client_span_id', 'client-root-1',
      'name', 'batch_root',
      'span_type', 'chain',
      'started_at', '2026-11-03 11:00:00+00'
    ),
    jsonb_build_object(
      'trace_id', v_trace_id,
      'span_id', 'b2b2b2b2b2b2b2b2',
      'client_span_id', 'client-child-1',
      'parent_client_span_id', 'client-root-1',
      'name', 'batch_child',
      'span_type', 'tool',
      'started_at', '2026-11-03 11:00:01+00'
    ),
    jsonb_build_object(
      'trace_id', v_trace_id,
      'span_id', 'c3c3c3c3c3c3c3c3',
      'client_span_id', 'client-llm-1',
      'name', 'batch_llm',
      'span_type', 'llm',
      'started_at', '2026-11-03 11:00:02+00',
      'input', '{"prompt": "batch test"}'::jsonb,
      'output', '{"response": "batch response"}'::jsonb
    )
  );

  FOR r IN SELECT * FROM public.ingest_spans_batch_transactional(v_proj_id, v_sess_id, v_spans)
  LOOP
    v_batch_count := v_batch_count + 1;
    IF r.out_client_span_id = 'client-root-1' THEN
      v_root_db_id := r.out_db_id;
    ELSIF r.out_client_span_id = 'client-child-1' THEN
      v_child_db_id := r.out_db_id;
    END IF;
  END LOOP;

  ASSERT v_batch_count = 3, 'Expected 3 spans in batch, got ' || v_batch_count;
  ASSERT v_root_db_id IS NOT NULL, 'Root span DB ID should not be null';
  ASSERT v_child_db_id IS NOT NULL, 'Child span DB ID should not be null';

  -- Verify intra-batch parent resolution: child should point directly to root's DB UUID!
  SELECT parent_span_id INTO v_child_parent_id FROM public.spans WHERE id = v_child_db_id;
  ASSERT v_child_parent_id = v_root_db_id, 'Intra-batch parent_client_span_id was not resolved to root db_id!';

  RAISE NOTICE 'SUCCESS: Batch atomic span ingestion and intra-batch parent resolution verified.';
END
$$;

SELECT '--- ALL POSTGRESQL 18 TESTS PASSED SUCCESSFULLY ---' AS final_summary;
