// Database row types
export interface Profile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

export interface OrgMember {
  org_id: string;
  user_id: string;
  role: 'owner' | 'member';
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  project_id: string;
  key_hash: string;
  key_prefix: string;
  name: string | null;
  last_used_at: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Session {
  id: string;
  project_id: string;
  external_id: string | null;
  name: string | null;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  total_tokens: number;
  total_cost_usd: number;
  span_count: number;
  error_count: number;
  created_at: string;
}

export interface Span {
  id: string;
  session_id: string;
  project_id: string;
  parent_span_id: string | null;
  name: string;
  span_type: SpanType;
  status: 'ok' | 'error';
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  model: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface EvalScore {
  span_id: string;
  score: number;
  reasoning: string | null;
  flagged: boolean;
  generated_at: string;
}

export interface AiExplanation {
  span_id: string;
  diagnosis: string;
  suggested_fix: string;
  generated_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  error_fingerprint: string;
  status: 'open' | 'resolved' | 'ignored';
  occurrence_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface IssueSpan {
  issue_id: string;
  span_id: string;
}

export interface AlertRule {
  id: string;
  project_id: string;
  name: string;
  metric: 'error_rate' | 'latency_p95' | 'cost_spike';
  threshold: number;
  window_minutes: number;
  notify_email: string;
  is_active: boolean;
  created_at: string;
}

// Helper types
export type SpanType = 'llm' | 'tool' | 'chain' | 'retrieval' | 'agent';
export type SessionStatus = 'running' | 'success' | 'error';
export type IssueStatus = 'open' | 'resolved' | 'ignored';
export type SpanStatus = 'ok' | 'error';
export type OrgRole = 'owner' | 'member';
export type AlertMetric = 'error_rate' | 'latency_p95' | 'cost_spike';

export interface SpanWithEval extends Span {
  eval_score?: EvalScore;
}

export interface SessionWithStats extends Session {
  spans?: SpanWithEval[];
}

export interface SpanWithChildren extends Span {
  children: SpanWithChildren[];
  eval_score?: EvalScore;
  ai_explanation?: AiExplanation;
}

export interface ProjectWithStats extends Project {
  session_count?: number;
  error_count?: number;
  total_cost_usd?: number;
}

// API request/response types
export interface IngestSpanPayload {
  session_id?: string;
  session_name?: string;
  spans: Array<{
    id?: string;
    parent_span_id?: string;
    name: string;
    span_type: SpanType;
    status?: SpanStatus;
    started_at: string;
    ended_at?: string;
    duration_ms?: number;
    model?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    error_message?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface IngestResponse {
  session_id: string;
  span_ids: string[];
}
