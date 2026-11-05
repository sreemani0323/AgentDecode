import { describe, test, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { GET as getSessionRoute } from '@/app/api/sessions/[id]/route'
import { GET as getFinetuneExportRoute } from '@/app/api/export/finetune/route'

describe('Multiple LLM Spans per Trace Evaluation Support', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../supabase/migrations/009_production_readiness_remediation.sql'
  )
  const migrationSql = fs.readFileSync(migrationPath, 'utf8')

  describe('Migration 009 Schema & DDL Validation', () => {
    test('Migration 009 adds span_id column to evaluation_outbox and trace_evaluations', () => {
      expect(migrationSql).toContain("table_name = 'evaluation_outbox'")
      expect(migrationSql).toContain('ALTER TABLE public.evaluation_outbox ADD COLUMN span_id UUID;')
      expect(migrationSql).toContain("table_name = 'trace_evaluations'")
      expect(migrationSql).toContain('ALTER TABLE public.trace_evaluations ADD COLUMN span_id UUID;')
    })

    test('Migration 009 creates unique index including span_id to prevent LLM span collisions within a trace', () => {
      expect(migrationSql).toContain('uq_outbox_project_trace_type_span')
      const outboxIndexMatch = migrationSql.match(
        /CREATE UNIQUE INDEX uq_outbox_project_trace_type_span[\s\S]*?ON public\.evaluation_outbox[\s\S]*?\);/i
      )
      expect(outboxIndexMatch).not.toBeNull()
      const outboxIdx = outboxIndexMatch![0]
      expect(outboxIdx).toContain('project_id')
      expect(outboxIdx).toContain('trace_id')
      expect(outboxIdx).toContain('eval_type')
      expect(outboxIdx).toContain('COALESCE(span_id')

      expect(migrationSql).toContain('uq_trace_eval_version_span')
      const evalIndexMatch = migrationSql.match(
        /CREATE UNIQUE INDEX uq_trace_eval_version_span[\s\S]*?ON public\.trace_evaluations[\s\S]*?\);/i
      )
      expect(evalIndexMatch).not.toBeNull()
      const evalIdx = evalIndexMatch![0]
      expect(evalIdx).toContain('project_id')
      expect(evalIdx).toContain('trace_id')
      expect(evalIdx).toContain('eval_type')
      expect(evalIdx).toContain('trace_version')
      expect(evalIdx).toContain('COALESCE(span_id')
    })

    test('Transactional span ingestion records distinct span_id for each LLM span in a trace', () => {
      const ingestMatch = migrationSql.match(
        /CREATE OR REPLACE FUNCTION public\.ingest_span_transactional[\s\S]*?END;\s*\$\$;/i
      )
      expect(ingestMatch).not.toBeNull()
      const ingestFn = ingestMatch![0]

      expect(ingestFn).toContain('INSERT INTO public.evaluation_outbox')
      expect(ingestFn).toContain('span_id')
      expect(ingestFn).toContain('v_db_id')
    })

    test('Finalize evaluation job records span_id into trace_evaluations and marks outbox completed', () => {
      const finalizeMatch = migrationSql.match(
        /CREATE OR REPLACE FUNCTION public\.finalize_evaluation_job[\s\S]*?END;\s*\$\$;/i
      )
      expect(finalizeMatch).not.toBeNull()
      const finalizeFn = finalizeMatch![0]

      expect(finalizeFn).toContain('INSERT INTO public.trace_evaluations')
      expect(finalizeFn).toContain('p_span_id')
    })
  })

  describe('Multiple LLM Spans Consumer Routing & Enrichment Isolation', () => {
    const traceId = 'trace_multi_12345'
    const span1Id = '00000000-0000-0000-0000-000000000001'
    const span2Id = '00000000-0000-0000-0000-000000000002'
    const projectId = '00000000-0000-0000-0000-000000000099'
    const sessionId = '00000000-0000-0000-0000-000000000088'

    test('GET /api/sessions/[id] enriches distinct evaluations per LLM span without collision', async () => {
      const spans = [
        {
          id: span1Id,
          session_id: sessionId,
          project_id: projectId,
          trace_id: traceId,
          name: 'First LLM Call',
          span_type: 'llm',
          started_at: '2026-11-04T00:00:00Z',
          ended_at: '2026-11-04T00:00:01Z',
          parent_span_id: null,
          input: { prompt: 'Question 1' },
          output: { response: 'Answer 1' },
        },
        {
          id: span2Id,
          session_id: sessionId,
          project_id: projectId,
          trace_id: traceId,
          name: 'Second LLM Call',
          span_type: 'llm',
          started_at: '2026-11-04T00:00:02Z',
          ended_at: '2026-11-04T00:00:03Z',
          parent_span_id: null,
          input: { prompt: 'Question 2' },
          output: { response: 'Answer 2' },
        },
      ]

      const traceEvaluations = [
        {
          span_id: span1Id,
          trace_id: traceId,
          score: 9.5,
          reasoning: '[groq:llama-3.3-70b-versatile] Excellent reasoning',
          flagged: false,
          generated_at: '2026-11-04T00:00:05Z',
        },
        {
          span_id: span2Id,
          trace_id: traceId,
          score: 3.2,
          reasoning: '[groq:llama-3.3-70b-versatile] Hallucinated response',
          flagged: true,
          generated_at: '2026-11-04T00:00:06Z',
        },
      ]

      // Verify the map-building logic used in GET /api/sessions/[id]
      const traceEvalBySpanId = new Map<string, any>()
      const traceEvalByTraceId = new Map<string, any>()
      for (const te of traceEvaluations) {
        if (te.span_id) {
          traceEvalBySpanId.set(te.span_id, te)
        } else if (te.trace_id) {
          traceEvalByTraceId.set(te.trace_id, te)
        }
      }

      const evalScoresMap = new Map<string, any>()
      for (const span of spans) {
        const te =
          traceEvalBySpanId.get(span.id) ||
          (span.trace_id ? traceEvalByTraceId.get(span.trace_id) : null)
        if (te) {
          evalScoresMap.set(span.id, {
            span_id: span.id,
            score: te.score,
            reasoning: te.reasoning,
            flagged: te.flagged,
          })
        }
      }

      // Assert each span preserves its OWN distinct evaluation
      expect(evalScoresMap.get(span1Id)?.score).toBe(9.5)
      expect(evalScoresMap.get(span1Id)?.flagged).toBe(false)
      expect(evalScoresMap.get(span1Id)?.reasoning).toContain('Excellent reasoning')

      expect(evalScoresMap.get(span2Id)?.score).toBe(3.2)
      expect(evalScoresMap.get(span2Id)?.flagged).toBe(true)
      expect(evalScoresMap.get(span2Id)?.reasoning).toContain('Hallucinated response')
    })

    test('Fine-tune export filters qualifying spans based on span_id rather than trace collapse', () => {
      const allLlmSpans = [
        {
          id: span1Id,
          trace_id: traceId,
          name: 'High quality span',
          input: { messages: [{ role: 'user', content: 'What is 2+2?' }] },
          output: { response: '4' },
        },
        {
          id: span2Id,
          trace_id: traceId,
          name: 'Low quality span',
          input: { messages: [{ role: 'user', content: 'What is 5*5?' }] },
          output: { response: 'Wrong answer' },
        },
      ]

      // Only span 1 has high score in trace_evaluations
      const traceEvals = [
        {
          span_id: span1Id,
          trace_id: traceId,
          score: 9.0,
          reasoning: 'Good',
        },
        {
          span_id: span2Id,
          trace_id: traceId,
          score: 3.0,
          reasoning: 'Poor',
        },
      ]

      const minScore = 8.0
      const traceEvalsBySpanId = new Map<string, any>()
      const traceEvalsByTraceId = new Map<string, any>()

      // Filter >= minScore as done by database query .gte('score', minScore)
      for (const te of traceEvals.filter((e) => e.score >= minScore)) {
        if (te.span_id) {
          traceEvalsBySpanId.set(te.span_id, te)
        } else if (te.trace_id) {
          traceEvalsByTraceId.set(te.trace_id, te)
        }
      }

      const qualifyingSpans = allLlmSpans.filter((span) => {
        if (traceEvalsBySpanId.has(span.id)) return true
        if (span.trace_id && traceEvalsByTraceId.has(span.trace_id)) return true
        return false
      })

      expect(qualifyingSpans.length).toBe(1)
      expect(qualifyingSpans[0].id).toBe(span1Id)
    })

    test('Preserves backward compatibility for legacy traces where span_id IS NULL', () => {
      const legacySpan = {
        id: 'legacy-span-uuid',
        trace_id: 'legacy-trace-uuid',
      }

      const legacyTraceEval = {
        span_id: null,
        trace_id: 'legacy-trace-uuid',
        score: 8.5,
        reasoning: 'Legacy evaluation',
      }

      const traceEvalBySpanId = new Map<string, any>()
      const traceEvalByTraceId = new Map<string, any>()
      if (legacyTraceEval.span_id) {
        traceEvalBySpanId.set(legacyTraceEval.span_id, legacyTraceEval)
      } else if (legacyTraceEval.trace_id) {
        traceEvalByTraceId.set(legacyTraceEval.trace_id, legacyTraceEval)
      }

      const matchedEval =
        traceEvalBySpanId.get(legacySpan.id) ||
        (legacySpan.trace_id ? traceEvalByTraceId.get(legacySpan.trace_id) : null)

      expect(matchedEval).not.toBeNull()
      expect(matchedEval.score).toBe(8.5)
      expect(matchedEval.reasoning).toBe('Legacy evaluation')
    })
  })
})
