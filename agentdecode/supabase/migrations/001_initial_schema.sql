-- =============================================================================
-- AgentDecode — Initial Database Schema
-- Migration: 001_initial_schema.sql
-- Description: Complete schema for an AI agent observability platform.
-- =============================================================================
-- This migration creates all core tables, indexes, constraints, Row Level
-- Security policies, and triggers required by AgentDecode.
--
-- IMPORTANT — Data Ingest Path:
-- The SDK / ingest API endpoints (sessions, spans, eval_scores, etc.) are
-- called with the Supabase **service_role** key, which bypasses RLS entirely.
-- This is intentional: telemetry arrives from backend services that
-- authenticate via project-scoped API keys, not end-user JWTs.
-- The RLS policies below therefore only govern access through the
-- **anon / authenticated** roles used by the dashboard frontend.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()


-- ---------------------------------------------------------------------------
-- 1. profiles — extends Supabase auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  avatar_url text,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Public profile for each authenticated user, auto-created on signup.';


-- ---------------------------------------------------------------------------
-- 2. organizations
-- ---------------------------------------------------------------------------
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  owner_id   uuid        references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.organizations is
  'Top-level tenant. Every resource is scoped to an organization.';

create index idx_organizations_owner_id on public.organizations (owner_id);
create unique index idx_organizations_slug on public.organizations (slug);


-- ---------------------------------------------------------------------------
-- 3. org_members — many-to-many between organizations and profiles
-- ---------------------------------------------------------------------------
create table public.org_members (
  org_id  uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role    text not null default 'member'
            check (role in ('owner', 'member')),
  primary key (org_id, user_id)
);

comment on table public.org_members is
  'Organization membership with role. Used by every RLS policy for scoping.';

create index idx_org_members_user_id on public.org_members (user_id);


-- ---------------------------------------------------------------------------
-- 4. projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid        not null references public.organizations (id) on delete cascade,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now()
);

comment on table public.projects is
  'A project groups sessions, spans, and configuration within an org.';

create index idx_projects_org_id on public.projects (org_id);


-- ---------------------------------------------------------------------------
-- 5. api_keys
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid        not null references public.projects (id) on delete cascade,
  key_hash    text        not null unique,   -- SHA-256 hash of the full key
  key_prefix  text        not null,          -- first 12 chars, displayed in UI
  name        text,                          -- user-given label, e.g. "prod-key"
  last_used_at timestamptz,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.api_keys is
  'Hashed API keys used by SDKs to authenticate ingest requests.';

create index idx_api_keys_project_id on public.api_keys (project_id);


-- ---------------------------------------------------------------------------
-- 6. sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid        not null references public.projects (id) on delete cascade,
  external_id   text,                                          -- caller-supplied correlation id
  name          text,
  status        text        not null default 'running'
                  check (status in ('running', 'success', 'error')),
  started_at    timestamptz not null,
  ended_at      timestamptz,
  total_tokens  integer     not null default 0,
  total_cost_usd numeric(10,6) not null default 0,
  span_count    integer     not null default 0,
  error_count   integer     not null default 0,
  created_at    timestamptz not null default now()
);

comment on table public.sessions is
  'A single agent execution / conversation. Aggregates spans.';

create index idx_sessions_project_started
  on public.sessions (project_id, started_at desc);

create index idx_sessions_external_id
  on public.sessions (project_id, external_id)
  where external_id is not null;


-- ---------------------------------------------------------------------------
-- 7. spans
-- ---------------------------------------------------------------------------
create table public.spans (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid        not null references public.sessions (id) on delete cascade,
  project_id     uuid        not null references public.projects (id),
  parent_span_id uuid        references public.spans (id) on delete set null,
  name           text        not null,
  span_type      text        check (span_type in ('llm', 'tool', 'chain', 'retrieval', 'agent')),
  status         text        not null default 'ok'
                   check (status in ('ok', 'error')),
  started_at     timestamptz not null,
  ended_at       timestamptz,
  duration_ms    integer,
  model          text,
  input          jsonb,
  output         jsonb,
  error_message  text,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(10,6),
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.spans is
  'Individual unit of work within a session (LLM call, tool invocation, etc.).';

create index idx_spans_session_started
  on public.spans (session_id, started_at asc);

create index idx_spans_project_errors
  on public.spans (project_id, status)
  where status = 'error';

create index idx_spans_parent
  on public.spans (parent_span_id)
  where parent_span_id is not null;


-- ---------------------------------------------------------------------------
-- 8. eval_scores
-- ---------------------------------------------------------------------------
create table public.eval_scores (
  span_id      uuid primary key references public.spans (id) on delete cascade,
  score        numeric(3,1) not null check (score >= 0 and score <= 10),
  reasoning    text,
  flagged      boolean     not null default false,
  generated_at timestamptz not null default now()
);

comment on table public.eval_scores is
  'Automated evaluation score attached to a span (0-10 scale).';

create index idx_eval_scores_flagged
  on public.eval_scores (flagged)
  where flagged = true;


-- ---------------------------------------------------------------------------
-- 9. ai_explanations
-- ---------------------------------------------------------------------------
create table public.ai_explanations (
  span_id       uuid primary key references public.spans (id) on delete cascade,
  diagnosis     text        not null,
  suggested_fix text        not null,
  generated_at  timestamptz not null default now()
);

comment on table public.ai_explanations is
  'AI-generated root-cause analysis and fix suggestions for error spans.';


-- ---------------------------------------------------------------------------
-- 10. issues
-- ---------------------------------------------------------------------------
create table public.issues (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid        not null references public.projects (id) on delete cascade,
  title             text        not null,
  error_fingerprint text        not null,
  status            text        not null default 'open'
                      check (status in ('open', 'resolved', 'ignored')),
  occurrence_count  integer     not null default 1,
  first_seen_at     timestamptz,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.issues is
  'De-duplicated error groups identified by a stable fingerprint.';

create index idx_issues_project_id on public.issues (project_id);

create index idx_issues_fingerprint
  on public.issues (project_id, error_fingerprint);


-- ---------------------------------------------------------------------------
-- 11. issue_spans — join table linking issues to offending spans
-- ---------------------------------------------------------------------------
create table public.issue_spans (
  issue_id uuid not null references public.issues (id) on delete cascade,
  span_id  uuid not null references public.spans (id)  on delete cascade,
  primary key (issue_id, span_id)
);

comment on table public.issue_spans is
  'Associates an issue with every span occurrence that triggered it.';

create index idx_issue_spans_span_id on public.issue_spans (span_id);


-- ---------------------------------------------------------------------------
-- 12. alert_rules
-- ---------------------------------------------------------------------------
create table public.alert_rules (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid        not null references public.projects (id) on delete cascade,
  name           text        not null,
  metric         text        not null
                   check (metric in ('error_rate', 'latency_p95', 'cost_spike')),
  threshold      numeric     not null,
  window_minutes integer     not null default 60,
  notify_email   text        not null,
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now()
);

comment on table public.alert_rules is
  'User-defined alerting rules evaluated periodically by a background job.';

create index idx_alert_rules_project_id on public.alert_rules (project_id);


-- ===========================================================================
--  ROW LEVEL SECURITY
-- ===========================================================================
-- Strategy:
--   • Every table has RLS enabled.
--   • SELECT / INSERT / UPDATE / DELETE policies are scoped to the
--     authenticated user's organization membership (via org_members).
--   • The service_role key (used by the ingest API) bypasses RLS entirely —
--     no policy is needed for writes that arrive through backend services.
-- ===========================================================================

-- ---- Helper: reusable function to check org membership --------------------
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.org_members
     where org_id  = p_org_id
       and user_id = auth.uid()
  );
$$;

-- ---- Helper: check org membership through a project -----------------------
create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.projects   p
      join public.org_members om on om.org_id = p.org_id
     where p.id       = p_project_id
       and om.user_id = auth.uid()
  );
$$;


-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles: users can view their own profile"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles: users can update their own profile"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Insert is handled by the trigger (service role), but allow the user to
-- insert their own row as a fallback.
create policy "profiles: users can insert their own profile"
  on public.profiles for insert
  with check (id = auth.uid());


-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;

create policy "organizations: members can view their org"
  on public.organizations for select
  using (public.is_org_member(id));

create policy "organizations: owner can update their org"
  on public.organizations for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "organizations: authenticated users can create orgs"
  on public.organizations for insert
  with check (auth.uid() is not null);

create policy "organizations: owner can delete their org"
  on public.organizations for delete
  using (owner_id = auth.uid());


-- ---------------------------------------------------------------------------
-- org_members
-- ---------------------------------------------------------------------------
alter table public.org_members enable row level security;

create policy "org_members: members can view fellow members"
  on public.org_members for select
  using (public.is_org_member(org_id));

-- Only org owners may add or remove members.
create policy "org_members: owners can insert members"
  on public.org_members for insert
  with check (
    exists (
      select 1 from public.org_members
       where org_id  = org_members.org_id
         and user_id = auth.uid()
         and role    = 'owner'
    )
    -- Also allow a user to insert themselves (needed by the auto-create trigger
    -- fallback and initial org setup).
    or user_id = auth.uid()
  );

create policy "org_members: owners can delete members"
  on public.org_members for delete
  using (
    exists (
      select 1 from public.org_members om
       where om.org_id  = org_members.org_id
         and om.user_id = auth.uid()
         and om.role    = 'owner'
    )
  );

create policy "org_members: owners can update member roles"
  on public.org_members for update
  using (
    exists (
      select 1 from public.org_members om
       where om.org_id  = org_members.org_id
         and om.user_id = auth.uid()
         and om.role    = 'owner'
    )
  )
  with check (
    exists (
      select 1 from public.org_members om
       where om.org_id  = org_members.org_id
         and om.user_id = auth.uid()
         and om.role    = 'owner'
    )
  );


-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;

create policy "projects: org members can view projects"
  on public.projects for select
  using (public.is_org_member(org_id));

create policy "projects: org members can create projects"
  on public.projects for insert
  with check (public.is_org_member(org_id));

create policy "projects: org members can update projects"
  on public.projects for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

create policy "projects: org members can delete projects"
  on public.projects for delete
  using (public.is_org_member(org_id));


-- ---------------------------------------------------------------------------
-- api_keys
-- ---------------------------------------------------------------------------
alter table public.api_keys enable row level security;

create policy "api_keys: org members can view keys"
  on public.api_keys for select
  using (public.is_project_member(project_id));

create policy "api_keys: org members can create keys"
  on public.api_keys for insert
  with check (public.is_project_member(project_id));

create policy "api_keys: org members can update keys"
  on public.api_keys for update
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "api_keys: org members can delete keys"
  on public.api_keys for delete
  using (public.is_project_member(project_id));


-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
alter table public.sessions enable row level security;

-- NOTE: Writes to sessions come from the ingest API using the service_role
-- key, which bypasses RLS. Only dashboard reads need policies.
create policy "sessions: org members can view sessions"
  on public.sessions for select
  using (public.is_project_member(project_id));

create policy "sessions: org members can update sessions"
  on public.sessions for update
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "sessions: org members can delete sessions"
  on public.sessions for delete
  using (public.is_project_member(project_id));


-- ---------------------------------------------------------------------------
-- spans
-- ---------------------------------------------------------------------------
alter table public.spans enable row level security;

-- NOTE: Span ingestion uses the service_role key (bypasses RLS).
create policy "spans: org members can view spans"
  on public.spans for select
  using (public.is_project_member(project_id));

create policy "spans: org members can update spans"
  on public.spans for update
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "spans: org members can delete spans"
  on public.spans for delete
  using (public.is_project_member(project_id));


-- ---------------------------------------------------------------------------
-- eval_scores
-- ---------------------------------------------------------------------------
alter table public.eval_scores enable row level security;

create policy "eval_scores: org members can view scores"
  on public.eval_scores for select
  using (
    exists (
      select 1 from public.spans s
       where s.id = eval_scores.span_id
         and public.is_project_member(s.project_id)
    )
  );

create policy "eval_scores: org members can update scores"
  on public.eval_scores for update
  using (
    exists (
      select 1 from public.spans s
       where s.id = eval_scores.span_id
         and public.is_project_member(s.project_id)
    )
  );

create policy "eval_scores: org members can delete scores"
  on public.eval_scores for delete
  using (
    exists (
      select 1 from public.spans s
       where s.id = eval_scores.span_id
         and public.is_project_member(s.project_id)
    )
  );


-- ---------------------------------------------------------------------------
-- ai_explanations
-- ---------------------------------------------------------------------------
alter table public.ai_explanations enable row level security;

create policy "ai_explanations: org members can view explanations"
  on public.ai_explanations for select
  using (
    exists (
      select 1 from public.spans s
       where s.id = ai_explanations.span_id
         and public.is_project_member(s.project_id)
    )
  );

create policy "ai_explanations: org members can update explanations"
  on public.ai_explanations for update
  using (
    exists (
      select 1 from public.spans s
       where s.id = ai_explanations.span_id
         and public.is_project_member(s.project_id)
    )
  );

create policy "ai_explanations: org members can delete explanations"
  on public.ai_explanations for delete
  using (
    exists (
      select 1 from public.spans s
       where s.id = ai_explanations.span_id
         and public.is_project_member(s.project_id)
    )
  );


-- ---------------------------------------------------------------------------
-- issues
-- ---------------------------------------------------------------------------
alter table public.issues enable row level security;

create policy "issues: org members can view issues"
  on public.issues for select
  using (public.is_project_member(project_id));

create policy "issues: org members can create issues"
  on public.issues for insert
  with check (public.is_project_member(project_id));

create policy "issues: org members can update issues"
  on public.issues for update
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "issues: org members can delete issues"
  on public.issues for delete
  using (public.is_project_member(project_id));


-- ---------------------------------------------------------------------------
-- issue_spans
-- ---------------------------------------------------------------------------
alter table public.issue_spans enable row level security;

create policy "issue_spans: org members can view issue-span links"
  on public.issue_spans for select
  using (
    exists (
      select 1 from public.issues i
       where i.id = issue_spans.issue_id
         and public.is_project_member(i.project_id)
    )
  );

create policy "issue_spans: org members can create issue-span links"
  on public.issue_spans for insert
  with check (
    exists (
      select 1 from public.issues i
       where i.id = issue_spans.issue_id
         and public.is_project_member(i.project_id)
    )
  );

create policy "issue_spans: org members can delete issue-span links"
  on public.issue_spans for delete
  using (
    exists (
      select 1 from public.issues i
       where i.id = issue_spans.issue_id
         and public.is_project_member(i.project_id)
    )
  );


-- ---------------------------------------------------------------------------
-- alert_rules
-- ---------------------------------------------------------------------------
alter table public.alert_rules enable row level security;

create policy "alert_rules: org members can view alert rules"
  on public.alert_rules for select
  using (public.is_project_member(project_id));

create policy "alert_rules: org members can create alert rules"
  on public.alert_rules for insert
  with check (public.is_project_member(project_id));

create policy "alert_rules: org members can update alert rules"
  on public.alert_rules for update
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "alert_rules: org members can delete alert rules"
  on public.alert_rules for delete
  using (public.is_project_member(project_id));


-- ===========================================================================
--  TRIGGERS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Trigger 1: Auto-create a profile when a new user signs up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- Trigger 2: Auto-create a personal organization when a profile is created
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id   uuid;
  v_slug     text;
  v_counter  integer := 0;
  v_base     text;
begin
  -- Derive a URL-safe slug from the user's name or id.
  v_base := coalesce(
    nullif(
      regexp_replace(
        lower(trim(new.full_name)),
        '[^a-z0-9]+', '-', 'g'
      ),
      ''
    ),
    'user-' || left(new.id::text, 8)
  );
  -- Remove leading/trailing hyphens.
  v_base := trim(both '-' from v_base);

  -- Ensure slug uniqueness by appending a counter if needed.
  v_slug := v_base;
  loop
    exit when not exists (
      select 1 from public.organizations where slug = v_slug
    );
    v_counter := v_counter + 1;
    v_slug := v_base || '-' || v_counter::text;
  end loop;

  -- Create the personal organization.
  insert into public.organizations (name, slug, owner_id)
  values (
    coalesce(nullif(trim(new.full_name), ''), 'My Organization'),
    v_slug,
    new.id
  )
  returning id into v_org_id;

  -- Add the user as the owner member.
  insert into public.org_members (org_id, user_id, role)
  values (v_org_id, new.id, 'owner');

  return new;
end;
$$;

create trigger on_profile_created
  after insert on public.profiles
  for each row
  execute function public.handle_new_profile();


-- ===========================================================================
--  GRANTS
-- ===========================================================================
-- The authenticated role needs access to all public tables for the dashboard.
-- The service_role already has full access and bypasses RLS.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select        on public.profiles        to authenticated;
grant update        on public.profiles        to authenticated;
grant insert        on public.profiles        to authenticated;

grant all           on public.organizations   to authenticated;
grant all           on public.org_members     to authenticated;
grant all           on public.projects        to authenticated;
grant all           on public.api_keys        to authenticated;
grant all           on public.sessions        to authenticated;
grant all           on public.spans           to authenticated;
grant all           on public.eval_scores     to authenticated;
grant all           on public.ai_explanations to authenticated;
grant all           on public.issues          to authenticated;
grant all           on public.issue_spans     to authenticated;
grant all           on public.alert_rules     to authenticated;


-- ===========================================================================
--  Done.
-- ===========================================================================
