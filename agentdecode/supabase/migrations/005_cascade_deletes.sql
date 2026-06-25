-- Migration: Add ON DELETE CASCADE to spans.project_id FK
-- The spans table references projects(id) without CASCADE,
-- which prevents project deletion when spans exist.

ALTER TABLE public.spans DROP CONSTRAINT IF EXISTS spans_project_id_fkey;
ALTER TABLE public.spans ADD CONSTRAINT spans_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
