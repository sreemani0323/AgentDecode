-- Unique index on sessions for (project_id, external_id) to prevent duplicate sessions
-- during race conditions. Only applies when external_id is NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_project_external_id 
ON sessions(project_id, external_id) 
WHERE external_id IS NOT NULL;
