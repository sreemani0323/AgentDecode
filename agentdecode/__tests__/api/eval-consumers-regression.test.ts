import { describe, test, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock rate-limit
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
}))

// Mock in-memory DB tables for eval consumers
let mockDb: {
  sessions: any[]
  projects: any[]
  org_members: any[]
  spans: any[]
  eval_scores: any[]
  trace_evaluations: any[]
  ai_explanations: any[]
}

function createQueryBuilder(table: string) {
  let filters: Array<{ col: string; op: string; val: any }> = []
  let selectCols = '*'
  let orderCol: string | null = null
  let orderAsc = true
  let limitCount: number | null = null

  const builder: any = {
    select: (cols: string = '*') => {
      selectCols = cols
      return builder
    },
    eq: (col: string, val: any) => {
      filters.push({ col, op: 'eq', val })
      return builder
    },
    in: (col: string, vals: any[]) => {
      filters.push({ col, op: 'in', val: vals })
      return builder
    },
    gte: (col: string, val: any) => {
      filters.push({ col, op: 'gte', val })
      return builder
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col
      orderAsc = opts?.ascending ?? true
      return builder
    },
    limit: (n: number) => {
      limitCount = n
      return builder
    },
    single: async () => {
      const rows = await execute()
      if (rows.length === 0) {
        return { data: null, error: { message: 'Row not found' } }
      }
      return { data: rows[0], error: null }
    },
    then: (resolve: any, reject?: any) => {
      return execute().then(rows => resolve({ data: rows, error: null }), reject)
    },
  }

  async function execute() {
    const list = (mockDb as any)[table] || []
    let result = list.filter((row: any) => {
      return filters.every(f => {
        if (f.op === 'eq') return row[f.col] === f.val
        if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(row[f.col])
        if (f.op === 'gte') return row[f.col] >= f.val
        return true
      })
    })

    if (orderCol) {
      result.sort((a: any, b: any) => {
        if (a[orderCol!] < b[orderCol!]) return orderAsc ? -1 : 1
        if (a[orderCol!] > b[orderCol!]) return orderAsc ? 1 : -1
        return 0
      })
    }

    if (limitCount !== null) {
      result = result.slice(0, limitCount)
    }

    return result
  }

  return builder
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'test-user-123' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => createQueryBuilder(table)),
  })),
}))

describe('Evaluation Consumers Compatibility & Regression Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = {
      sessions: [
        {
          id: 'sess-1',
          project_id: 'proj-1',
          name: 'Session 1',
          started_at: '2026-11-03T10:00:00.000Z',
        },
      ],
      projects: [
        {
          id: 'proj-1',
          org_id: 'org-1',
          name: 'Test Project',
        },
      ],
      org_members: [
        {
          org_id: 'org-1',
          user_id: 'test-user-123',
        },
      ],
      spans: [
        {
          id: 'span-root',
          session_id: 'sess-1',
          project_id: 'proj-1',
          parent_span_id: null,
          name: 'agent_run',
          span_type: 'agent',
          trace_id: 'trace-abc-123',
          started_at: '2026-11-03T10:00:00.000Z',
          created_at: '2026-11-03T10:00:00.000Z',
        },
        {
          id: 'span-llm-1',
          session_id: 'sess-1',
          project_id: 'proj-1',
          parent_span_id: 'span-root',
          name: 'llm_call_direct_eval',
          span_type: 'llm',
          model: 'gpt-4o',
          input: { prompt: 'Translate hello' },
          output: { text: 'Bonjour' },
          trace_id: 'trace-abc-123',
          started_at: '2026-11-03T10:00:01.000Z',
          created_at: '2026-11-03T10:00:01.000Z',
        },
        {
          id: 'span-llm-2',
          session_id: 'sess-1',
          project_id: 'proj-1',
          parent_span_id: 'span-root',
          name: 'llm_call_trace_eval',
          span_type: 'llm',
          model: 'claude-3-5',
          input: { prompt: 'Summarize text' },
          output: { text: 'Summary' },
          trace_id: 'trace-xyz-789',
          started_at: '2026-11-03T10:00:02.000Z',
          created_at: '2026-11-03T10:00:02.000Z',
        },
      ],
      eval_scores: [
        {
          span_id: 'span-llm-1',
          score: 9.5,
          reasoning: 'Excellent direct span evaluation',
          flagged: false,
          generated_at: '2026-11-03T10:00:05.000Z',
        },
      ],
      trace_evaluations: [
        {
          project_id: 'proj-1',
          trace_id: 'trace-xyz-789',
          score: 8.8,
          reasoning: 'High quality trace evaluation fallback',
          flagged: false,
          trace_version: 1,
          generated_at: '2026-11-03T10:00:06.000Z',
        },
      ],
      ai_explanations: [],
    }
  })

  test('GET /api/spans/[id]/eval returns score from eval_scores when present', async () => {
    const { GET } = await import('@/app/api/spans/[id]/eval/route')
    const req = new Request('http://localhost:3000/api/spans/span-llm-1/eval')
    const res = await GET(req, { params: Promise.resolve({ id: 'span-llm-1' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.eval_score).not.toBeNull()
    expect(json.eval_score.score).toBe(9.5)
    expect(json.eval_score.reasoning).toContain('Excellent direct span evaluation')
  })

  test('GET /api/spans/[id]/eval falls back to trace_evaluations when span-level record is missing', async () => {
    const { GET } = await import('@/app/api/spans/[id]/eval/route')
    const req = new Request('http://localhost:3000/api/spans/span-llm-2/eval')
    const res = await GET(req, { params: Promise.resolve({ id: 'span-llm-2' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.eval_score).not.toBeNull()
    expect(json.eval_score.score).toBe(8.8)
    expect(json.eval_score.reasoning).toContain('High quality trace evaluation fallback')
  })

  test('GET /api/sessions/[id] builds hierarchical tree and joins eval_scores + trace_evaluations', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/route')
    const req = new NextRequest('http://localhost:3000/api/sessions/sess-1')
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    const tree = json.session.spans
    expect(tree).toHaveLength(1) // Root span
    expect(tree[0].id).toBe('span-root')
    expect(tree[0].children).toHaveLength(2)

    // Child 1: has direct eval_scores
    const child1 = tree[0].children.find((c: any) => c.id === 'span-llm-1')
    expect(child1).toBeDefined()
    expect(child1.eval_scores).not.toBeNull()
    expect(child1.eval_scores.score).toBe(9.5)

    // Child 2: synthesized from trace_evaluations
    const child2 = tree[0].children.find((c: any) => c.id === 'span-llm-2')
    expect(child2).toBeDefined()
    expect(child2.eval_scores).not.toBeNull()
    expect(child2.eval_scores.score).toBe(8.8)
  })

  test('GET /api/export/finetune exports spans qualifying from both eval_scores and trace_evaluations', async () => {
    const { GET } = await import('@/app/api/export/finetune/route')
    const req = new NextRequest('http://localhost:3000/api/export/finetune?project_id=proj-1&min_score=8.5')
    const res = await GET(req)

    expect(res.status).toBe(200)
    const text = await res.text()
    const lines = text.trim().split('\n').map(l => JSON.parse(l))

    // Both spans have score >= 8.5 (9.5 and 8.8)
    expect(lines).toHaveLength(2)
    expect(lines[0].messages).toBeDefined()
    expect(lines[1].messages).toBeDefined()
  })

  test('GET /api/export/finetune filters out spans below min_score threshold', async () => {
    const { GET } = await import('@/app/api/export/finetune/route')
    const req = new NextRequest('http://localhost:3000/api/export/finetune?project_id=proj-1&min_score=9.0')
    const res = await GET(req)

    expect(res.status).toBe(200)
    const text = await res.text()
    const lines = text.trim().split('\n').map(l => JSON.parse(l))

    // Only span-llm-1 has score >= 9.0 (9.5); span-llm-2 (8.8) is filtered out
    expect(lines).toHaveLength(1)
    expect(lines[0].messages[0].role).toBe('user')
    expect(lines[0].messages[1].role).toBe('assistant')
    expect(lines[0].messages[1].content).toBe('Bonjour')
  })
})
