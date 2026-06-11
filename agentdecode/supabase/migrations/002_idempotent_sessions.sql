-- Drop the old non-unique index
DROP INDEX IF EXISTS public.idx_sessions_external_id;

-- Create a partial UNIQUE index so that (project_id, external_id) is unique
-- when external_id is not null. This enables the ingest route's ON CONFLICT
-- / 23505 race-condition handling to work correctly.
CREATE UNIQUE INDEX idx_sessions_project_external_id
  ON public.sessions (project_id, external_id)
  WHERE external_id IS NOT NULL;
