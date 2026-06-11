"use server"

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { scoreSpanWithGroq } from '@/lib/groq'
import { logger } from '@/lib/logger'

// ─── Session archetypes ──────────────────────────────────────────
// Each archetype defines a realistic AI agent pipeline with nested spans.
// At least one archetype has deliberate errors to populate the issues table.

interface MockSpan {
  name: string
  span_type: 'llm' | 'tool' | 'chain' | 'retrieval' | 'agent'
  status: 'ok' | 'error'
  model?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  error_message?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  duration_ms: number
  children?: MockSpan[]
}

interface SessionArchetype {
  name: string
  status: 'success' | 'error'
  spans: MockSpan[]
}

const ARCHETYPES: SessionArchetype[] = [
  // ── 1. Customer Support Agent (success) ─────────────────────────
  {
    name: 'Customer Support Agent',
    status: 'success',
    spans: [
      {
        name: 'support_agent',
        span_type: 'agent',
        status: 'ok',
        duration_ms: 4200,
        children: [
          {
            name: 'classify_intent',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o-mini',
            input: { messages: [{ role: 'user', content: 'I need to cancel my subscription and get a refund for this month.' }] },
            output: { intent: 'cancellation_refund', confidence: 0.94 },
            input_tokens: 42,
            output_tokens: 18,
            cost_usd: 0.0003,
            duration_ms: 380,
          },
          {
            name: 'lookup_customer',
            span_type: 'tool',
            status: 'ok',
            input: { tool: 'crm_api', query: 'user_id=usr_9281' },
            output: { name: 'Alex Rivera', plan: 'Pro', billing_cycle: 'monthly', last_payment: '2026-05-28' },
            duration_ms: 120,
          },
          {
            name: 'check_refund_policy',
            span_type: 'retrieval',
            status: 'ok',
            input: { query: 'cancellation refund policy monthly plan' },
            output: { documents: ['Policy 4.2: Monthly plans may be cancelled at any time. Refunds are issued pro-rata for unused days remaining in the billing cycle.'] },
            duration_ms: 210,
          },
          {
            name: 'generate_response',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o',
            input: { messages: [{ role: 'system', content: 'You are a helpful support agent.' }, { role: 'user', content: 'Cancel and refund.' }], context: 'Pro plan, monthly billing, policy allows pro-rata refund.' },
            output: { response: "I've processed your cancellation and initiated a pro-rata refund of $12.40 for the remaining 8 days of your billing cycle. You'll see this reflected in 3-5 business days. Is there anything else I can help with?" },
            input_tokens: 185,
            output_tokens: 62,
            cost_usd: 0.0042,
            duration_ms: 1400,
          },
          {
            name: 'process_cancellation',
            span_type: 'tool',
            status: 'ok',
            input: { action: 'cancel_subscription', user_id: 'usr_9281', refund_amount: 12.40 },
            output: { success: true, confirmation_id: 'CNX-20260603-4821' },
            duration_ms: 340,
          },
        ],
      },
    ],
  },

  // ── 2. RAG Pipeline (success, but one low-quality LLM response) ─
  {
    name: 'Research RAG Pipeline',
    status: 'success',
    spans: [
      {
        name: 'rag_pipeline',
        span_type: 'chain',
        status: 'ok',
        duration_ms: 6800,
        children: [
          {
            name: 'rewrite_query',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o-mini',
            input: { messages: [{ role: 'user', content: 'What are the side effects of combining metformin with lisinopril in elderly patients?' }] },
            output: { rewritten_queries: ['metformin lisinopril drug interaction elderly', 'ACE inhibitor biguanide combination adverse effects geriatric'] },
            input_tokens: 34,
            output_tokens: 28,
            cost_usd: 0.0002,
            duration_ms: 290,
          },
          {
            name: 'vector_search',
            span_type: 'retrieval',
            status: 'ok',
            input: { query_embedding: '[0.023, -0.118, ...]', top_k: 5, collection: 'medical_literature' },
            output: { documents: ['Doc 1: Lactic acidosis risk increases...', 'Doc 2: Renal function monitoring recommended...', 'Doc 3: Hyperkalemia risk with ACE inhibitors...'], similarity_scores: [0.92, 0.87, 0.83] },
            duration_ms: 180,
          },
          {
            name: 'synthesize_answer',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o',
            input: { messages: [{ role: 'system', content: 'Synthesize an answer from the provided medical literature.' }], documents: ['Lactic acidosis risk...', 'Renal monitoring...', 'Hyperkalemia...'] },
            output: { response: 'When combining metformin and lisinopril in elderly patients, clinicians should monitor for: (1) increased risk of lactic acidosis due to potential renal impairment, (2) hyperkalemia from ACE inhibitor effects, and (3) hypotension. Regular renal function tests (eGFR) are recommended every 3-6 months.' },
            input_tokens: 420,
            output_tokens: 95,
            cost_usd: 0.0078,
            duration_ms: 2100,
          },
          {
            name: 'fact_check',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o-mini',
            input: { claim: 'Lactic acidosis risk increases when combining metformin with ACE inhibitors in elderly patients.', evidence: 'Doc 1: Lactic acidosis risk increases with renal impairment. Metformin is renally cleared.' },
            output: { verdict: 'PARTIALLY_SUPPORTED', explanation: 'The claim conflates two separate mechanisms. Metformin increases lactic acidosis risk via renal clearance issues, not directly via ACE inhibitor interaction.' },
            input_tokens: 110,
            output_tokens: 45,
            cost_usd: 0.0004,
            duration_ms: 520,
          },
        ],
      },
    ],
  },

  // ── 3. Data Extraction Agent (ERROR — tool timeout) ─────────────
  {
    name: 'Invoice Data Extraction',
    status: 'error',
    spans: [
      {
        name: 'extraction_agent',
        span_type: 'agent',
        status: 'error',
        error_message: 'Pipeline failed: downstream tool timeout',
        duration_ms: 9500,
        children: [
          {
            name: 'parse_pdf',
            span_type: 'tool',
            status: 'ok',
            input: { file: 'invoice_2026_Q2.pdf', parser: 'pymupdf' },
            output: { pages: 3, text_length: 4820, tables_detected: 2 },
            duration_ms: 890,
          },
          {
            name: 'extract_line_items',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o',
            input: { messages: [{ role: 'system', content: 'Extract structured line items from this invoice text.' }], text: 'INVOICE #INV-2026-4821... Widget Pro x 50 @ $24.99... Enterprise License x 1 @ $2,400...' },
            output: { line_items: [{ description: 'Widget Pro', quantity: 50, unit_price: 24.99, total: 1249.50 }, { description: 'Enterprise License', quantity: 1, unit_price: 2400, total: 2400 }] },
            input_tokens: 380,
            output_tokens: 120,
            cost_usd: 0.0065,
            duration_ms: 1800,
          },
          {
            name: 'validate_against_erp',
            span_type: 'tool',
            status: 'error',
            error_message: 'Connection timeout after 3 retries: ERP API at erp.internal:8443 unreachable',
            input: { endpoint: 'erp.internal:8443/api/v2/invoices/validate', payload: { invoice_id: 'INV-2026-4821' } },
            output: undefined,
            duration_ms: 6200,
          },
        ],
      },
    ],
  },

  // ── 4. Code Review Agent (success) ──────────────────────────────
  {
    name: 'PR Code Review Agent',
    status: 'success',
    spans: [
      {
        name: 'code_review_agent',
        span_type: 'agent',
        status: 'ok',
        duration_ms: 5400,
        children: [
          {
            name: 'fetch_pr_diff',
            span_type: 'tool',
            status: 'ok',
            input: { repo: 'acme/backend', pr_number: 847, provider: 'github' },
            output: { files_changed: 4, additions: 128, deletions: 42, diff_summary: '+128 -42 in src/auth/session.ts, src/auth/middleware.ts, tests/auth.test.ts, README.md' },
            duration_ms: 320,
          },
          {
            name: 'analyze_security',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o',
            input: { messages: [{ role: 'system', content: 'You are a senior security engineer reviewing code changes. Flag any vulnerabilities.' }], diff: 'function validateSession(token) { const decoded = jwt.verify(token, process.env.JWT_SECRET)... }' },
            output: { findings: [{ severity: 'medium', description: 'JWT secret loaded from env at runtime — consider using a secrets manager for rotation support.', line: 'src/auth/session.ts:24' }], overall_risk: 'low' },
            input_tokens: 520,
            output_tokens: 85,
            cost_usd: 0.0072,
            duration_ms: 1600,
          },
          {
            name: 'analyze_performance',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o-mini',
            input: { messages: [{ role: 'system', content: 'Analyze this code diff for performance issues.' }], diff: 'const sessions = await db.query("SELECT * FROM sessions WHERE user_id = $1", [userId])...' },
            output: { findings: [{ severity: 'high', description: 'SELECT * on sessions table without LIMIT — this will degrade as the table grows. Add pagination.', line: 'src/auth/middleware.ts:15' }], overall_risk: 'medium' },
            input_tokens: 340,
            output_tokens: 72,
            cost_usd: 0.0008,
            duration_ms: 480,
          },
          {
            name: 'generate_review_comment',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o',
            input: { security_findings: [{ severity: 'medium' }], performance_findings: [{ severity: 'high' }] },
            output: { review: "## Code Review Summary\n\n**Security**: Low risk. Consider using a secrets manager for JWT key rotation.\n\n**Performance**: ⚠️ `SELECT *` without LIMIT on sessions table (middleware.ts:15) will cause latency spikes at scale. Add `LIMIT 1` since you only need the current session.\n\n**Verdict**: Request changes." },
            input_tokens: 280,
            output_tokens: 110,
            cost_usd: 0.0055,
            duration_ms: 1200,
          },
          {
            name: 'post_review_comment',
            span_type: 'tool',
            status: 'ok',
            input: { repo: 'acme/backend', pr_number: 847, action: 'REQUEST_CHANGES' },
            output: { comment_id: 'ghc_9281047', posted: true },
            duration_ms: 280,
          },
        ],
      },
    ],
  },

  // ── 5. Multi-step Booking Agent (ERROR — hallucination) ─────────
  {
    name: 'Travel Booking Agent',
    status: 'error',
    spans: [
      {
        name: 'booking_agent',
        span_type: 'agent',
        status: 'error',
        error_message: 'Agent produced invalid booking: flight does not exist',
        duration_ms: 7200,
        children: [
          {
            name: 'parse_booking_request',
            span_type: 'llm',
            status: 'ok',
            model: 'gpt-4o-mini',
            input: { messages: [{ role: 'user', content: 'Book me the cheapest direct flight from SFO to JFK next Tuesday, window seat.' }] },
            output: { departure: 'SFO', arrival: 'JFK', date: '2026-06-10', preferences: { seat_type: 'window', sort: 'price_asc', stops: 'direct' } },
            input_tokens: 38,
            output_tokens: 45,
            cost_usd: 0.0003,
            duration_ms: 310,
          },
          {
            name: 'search_flights',
            span_type: 'tool',
            status: 'ok',
            input: { api: 'amadeus', departure: 'SFO', arrival: 'JFK', date: '2026-06-10', direct_only: true },
            output: { results: [{ flight: 'UA 234', price: 342, departure_time: '07:15', arrival_time: '15:45' }, { flight: 'DL 891', price: 389, departure_time: '11:30', arrival_time: '20:00' }] },
            duration_ms: 620,
          },
          {
            name: 'select_and_book',
            span_type: 'llm',
            status: 'error',
            model: 'gpt-4o',
            error_message: 'Hallucinated flight number: model selected "AA 100" which was not in the search results',
            input: { available_flights: [{ flight: 'UA 234', price: 342 }, { flight: 'DL 891', price: 389 }], user_preference: 'cheapest' },
            output: { selected_flight: 'AA 100', price: 299, reasoning: 'Selected the cheapest American Airlines option.' },
            input_tokens: 210,
            output_tokens: 55,
            cost_usd: 0.0038,
            duration_ms: 1100,
          },
          {
            name: 'confirm_booking',
            span_type: 'tool',
            status: 'error',
            error_message: 'Flight AA 100 does not exist in the system. Booking aborted.',
            input: { flight: 'AA 100', passenger: 'user_current', seat_preference: 'window' },
            output: undefined,
            duration_ms: 180,
          },
        ],
      },
    ],
  },
]

// ─── Flatten span tree into array with parent references ─────────

function flattenSpans(
  spans: MockSpan[],
  sessionStartMs: number,
  parentId: string | null = null,
  offsetMs: number = 0,
): Array<MockSpan & { parent_span_id: string | null; started_at: string; ended_at: string }> {
  const result: Array<MockSpan & { parent_span_id: string | null; started_at: string; ended_at: string }> = []
  let currentOffset = offsetMs

  for (const span of spans) {
    const startedAt = new Date(sessionStartMs + currentOffset).toISOString()
    const endedAt = new Date(sessionStartMs + currentOffset + span.duration_ms).toISOString()

    result.push({
      ...span,
      parent_span_id: parentId,
      started_at: startedAt,
      ended_at: endedAt,
    })

    // Placeholder index — we'll assign real IDs after insert
    const thisIndex = result.length - 1

    if (span.children && span.children.length > 0) {
      // Children will get real parent IDs later; use '__INDEX__N' as placeholder
      const childFlat = flattenSpans(span.children, sessionStartMs, `__INDEX__${thisIndex}`, currentOffset + 50)
      result.push(...childFlat)
    }

    currentOffset += span.duration_ms + 100 // 100ms gap between sibling spans
  }

  return result
}

// ─── Main server action ──────────────────────────────────────────

export async function generateMockTraffic(projectId: string): Promise<{ success: boolean; sessionsCreated: number; spansCreated: number; error?: string }> {
  // ── Auth check: verify the calling user has access to this project ──
  const userSupabase = await createClient()
  const { data: { user } } = await userSupabase.auth.getUser()

  if (!user) {
    return { success: false, sessionsCreated: 0, spansCreated: 0, error: 'Unauthorized' }
  }

  // Create service client to bypass RLS for membership lookup (Server Action cookie context issue)
  const serviceSupabase = createServiceClient()

  // Look up the project's org_id
  const { data: project } = await serviceSupabase
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .single()

  if (!project) {
    return { success: false, sessionsCreated: 0, spansCreated: 0, error: 'Project not found' }
  }

  const { data: membership } = await serviceSupabase
    .from('org_members')
    .select('role')
    .eq('user_id', user.id)
    .eq('org_id', project.org_id)
    .maybeSingle()

  if (!membership) {
    return { success: false, sessionsCreated: 0, spansCreated: 0, error: 'Unauthorized' }
  }

  // ── Proceed with service client (bypasses RLS for bulk insert) ──
  const supabase = serviceSupabase

  let totalSessions = 0
  let totalSpans = 0

  try {
    // Verify project exists
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .single()

    if (!project) {
      return { success: false, sessionsCreated: 0, spansCreated: 0, error: 'Project not found' }
    }

    for (const archetype of ARCHETYPES) {
      // Stagger sessions across the last 24 hours for realistic chart data
      const hoursAgo = Math.floor(Math.random() * 20) + 1
      const sessionStartMs = Date.now() - (hoursAgo * 60 * 60 * 1000) + Math.floor(Math.random() * 3600000)

      // Flatten the span tree
      const flatSpans = flattenSpans(archetype.spans, sessionStartMs)

      const sessionStartedAt = flatSpans[0].started_at
      const sessionEndedAt = flatSpans[flatSpans.length - 1].ended_at

      // 1. Create session
      const { data: session, error: sessionError } = await supabase
        .from('sessions')
        .insert({
          project_id: projectId,
          name: archetype.name,
          status: archetype.status,
          started_at: sessionStartedAt,
          ended_at: sessionEndedAt,
          total_tokens: flatSpans.reduce((sum, s) => sum + (s.input_tokens || 0) + (s.output_tokens || 0), 0),
          total_cost_usd: flatSpans.reduce((sum, s) => sum + (s.cost_usd || 0), 0),
          span_count: flatSpans.length,
          error_count: flatSpans.filter(s => s.status === 'error').length,
        })
        .select('id')
        .single()

      if (sessionError || !session) {
        logger.error('Failed to create session in mock traffic generation', new Error(sessionError?.message || 'Unknown error'))
        continue
      }

      totalSessions++

      // 2. Insert spans one-by-one to preserve parent references
      const insertedSpanIds: string[] = []

      for (let i = 0; i < flatSpans.length; i++) {
        const span = flatSpans[i]

        // Resolve parent_span_id from placeholder
        let resolvedParentId: string | null = null
        if (span.parent_span_id && span.parent_span_id.startsWith('__INDEX__')) {
          const parentIndex = parseInt(span.parent_span_id.replace('__INDEX__', ''), 10)
          resolvedParentId = insertedSpanIds[parentIndex] || null
        }

        const { data: insertedSpan, error: spanError } = await supabase
          .from('spans')
          .insert({
            session_id: session.id,
            project_id: projectId,
            parent_span_id: resolvedParentId,
            name: span.name,
            span_type: span.span_type,
            status: span.status,
            started_at: span.started_at,
            ended_at: span.ended_at,
            duration_ms: span.duration_ms,
            model: span.model || null,
            input: span.input || null,
            output: span.output || null,
            error_message: span.error_message || null,
            input_tokens: span.input_tokens || null,
            output_tokens: span.output_tokens || null,
            cost_usd: span.cost_usd || null,
            metadata: {},
          })
          .select('id')
          .single()

        if (spanError || !insertedSpan) {
          logger.error('Failed to insert span in mock traffic generation', new Error(spanError?.message || 'Unknown error'))
          insertedSpanIds.push('')
          continue
        }

        insertedSpanIds.push(insertedSpan.id)
        totalSpans++

        // 3. Fire-and-forget Groq eval for LLM spans
        if (span.span_type === 'llm' && insertedSpan.id) {
          scoreSpanWithGroq(insertedSpan.id, span.input, span.output).catch(() => {})
        }

        // 4. Auto-group errors into issues
        if (span.status === 'error' && span.error_message) {
          const fingerprintInput = projectId + ':' + span.name + ':' + span.error_message.slice(0, 50)
          const fingerprint = btoa(encodeURIComponent(fingerprintInput))

          const { data: existingIssue } = await supabase
            .from('issues')
            .select('id, occurrence_count')
            .eq('project_id', projectId)
            .eq('error_fingerprint', fingerprint)
            .single()

          if (existingIssue) {
            await supabase
              .from('issues')
              .update({
                occurrence_count: existingIssue.occurrence_count + 1,
                last_seen_at: new Date().toISOString(),
              })
              .eq('id', existingIssue.id)

            await supabase
              .from('issue_spans')
              .insert({ issue_id: existingIssue.id, span_id: insertedSpan.id })
          } else {
            const title = span.name + ': ' + span.error_message.slice(0, 80)
            const now = new Date().toISOString()

            const { data: newIssue } = await supabase
              .from('issues')
              .insert({
                project_id: projectId,
                title,
                error_fingerprint: fingerprint,
                status: 'open',
                occurrence_count: 1,
                first_seen_at: now,
                last_seen_at: now,
              })
              .select('id')
              .single()

            if (newIssue) {
              await supabase
                .from('issue_spans')
                .insert({ issue_id: newIssue.id, span_id: insertedSpan.id })
            }
          }
        }
      }
    }

    return { success: true, sessionsCreated: totalSessions, spansCreated: totalSpans }
  } catch (err: any) {
    logger.error('generateMockTraffic failed', err as Error)
    return { success: false, sessionsCreated: totalSessions, spansCreated: totalSpans, error: err.message }
  }
}
