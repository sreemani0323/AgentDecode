-- Insert historical test data to verify migration 006 backfill and FK repointing
DO $$
DECLARE
  v_org_id UUID := '11111111-1111-1111-1111-111111111111';
  v_proj_id UUID := '22222222-2222-2222-2222-222222222222';
  v_sess_id UUID := '33333333-3333-3333-3333-333333333333';
  v_span1 UUID := '44444444-4444-4444-4444-444444444441';
  v_span2 UUID := '44444444-4444-4444-4444-444444444442';
  v_span3 UUID := '44444444-4444-4444-4444-444444444443';
  v_issue_id UUID := '55555555-5555-5555-5555-555555555555';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'Test Org', 'test-org');

  INSERT INTO public.projects (id, org_id, name)
  VALUES (v_proj_id, v_org_id, 'Test Project');

  INSERT INTO public.sessions (id, project_id, name, started_at)
  VALUES (v_sess_id, v_proj_id, 'Historical Session', '2026-10-15 10:00:00+00');

  -- Root span
  INSERT INTO public.spans (
    id, session_id, project_id, parent_span_id, name, span_type, status, started_at, ended_at, duration_ms
  ) VALUES (
    v_span1, v_sess_id, v_proj_id, NULL, 'root_span', 'chain', 'ok', '2026-10-15 10:00:01+00', '2026-10-15 10:00:05+00', 4000
  );

  -- Child span
  INSERT INTO public.spans (
    id, session_id, project_id, parent_span_id, name, span_type, status, started_at, ended_at, duration_ms
  ) VALUES (
    v_span2, v_sess_id, v_proj_id, v_span1, 'child_span', 'llm', 'error', '2026-10-15 10:00:02+00', '2026-10-15 10:00:04+00', 2000
  );

  -- Grandchild span
  INSERT INTO public.spans (
    id, session_id, project_id, parent_span_id, name, span_type, status, started_at, ended_at, duration_ms
  ) VALUES (
    v_span3, v_sess_id, v_proj_id, v_span2, 'grandchild_span', 'tool', 'ok', '2026-10-15 10:00:03+00', '2026-10-15 10:00:04+00', 1000
  );

  -- Dependent records
  INSERT INTO public.eval_scores (span_id, score, reasoning)
  VALUES (v_span1, 0.95, 'High accuracy');

  INSERT INTO public.ai_explanations (span_id, diagnosis, suggested_fix)
  VALUES (v_span2, 'Rate limit exceeded', 'Add retry logic with exponential backoff');

  INSERT INTO public.issues (id, project_id, title, error_fingerprint)
  VALUES (v_issue_id, v_proj_id, 'Rate limit issue', 'fingerprint123');

  INSERT INTO public.issue_spans (issue_id, span_id)
  VALUES (v_issue_id, v_span3);
END
$$;
