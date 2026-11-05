import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { hashApiKey } from '@/lib/utils'
import { checkAndFireAlerts } from '@/lib/alerts'
import * as rateLimitModule from '@/lib/rate-limit'
import { checkEnv } from '@/lib/env'
import { validateIngestPayload, MAX_REQUEST_BODY_BYTES } from '@/lib/validation'

export async function POST(request: Request) {
  // 0. Check maintenance admission gate
  if (process.env.GATEWAY_WRITE_MAINTENANCE === 'true') {
    return NextResponse.json(
      {
        error: 'MAINTENANCE_IN_PROGRESS',
        message: 'Database migration or maintenance in progress; retain telemetry in client buffer',
        retryable: true,
      },
      {
        status: 503,
        headers: {
          'Retry-After': '30',
        },
      }
    )
  }

  // 0.1 Check critical env vars
  const envCheck = checkEnv()
  if (!envCheck.ok) {
    const missingKeys = envCheck.missing.map((m) => m.key).join(', ')
    return NextResponse.json(
      { error: `Server misconfigured. Missing: ${missingKeys}` },
      { status: 503 }
    )
  }

  // 0.2 Check request body size via Content-Length header up-front
  const contentLengthHeader = request.headers.get('content-length')
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10)
    if (!isNaN(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      return NextResponse.json(
        {
          error: `Payload Too Large: Request body exceeds maximum allowed size of ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)}MB`,
        },
        { status: 413 }
      )
    }
  }

  // 1. Get Authorization header
  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
  }

  const apiKeyRaw = authHeader.replace('Bearer ', '')

  // 2. Pre-auth rate limit check
  const checkDistributed = (rateLimitModule as any).checkDistributedRateLimit
  const ingestLimiter = rateLimitModule.ingestRateLimiter
  const getClientIdent = rateLimitModule.getClientIdentifier

  if (typeof checkDistributed === 'function') {
    const preRate = await checkDistributed(request, 'ingest', { apiKey: apiKeyRaw })
    if (!preRate.allowed) {
      return preRate.response
    }
  } else if (ingestLimiter && typeof ingestLimiter.check === 'function') {
    const clientId = typeof getClientIdent === 'function'
      ? getClientIdent(request, apiKeyRaw)
      : `key:${apiKeyRaw}`
    const rateCheck = ingestLimiter.check(clientId)
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          error: 'Rate limit exceeded. Please slow down.',
          retry_after_ms: rateCheck.retryAfterMs,
        },
        {
          status: 429,
          headers: {
            'Retry-After': Math.max(1, Math.ceil(rateCheck.retryAfterMs / 1000)).toString(),
            'X-RateLimit-Remaining': '0',
          },
        }
      )
    }
  }

  // 3. Hash the provided key
  const keyHash = await hashApiKey(apiKeyRaw)

  // 4. Use service client (bypasses RLS)
  const supabase = createServiceClient()

  // 5. Look up api_keys where key_hash matches and is_active
  const { data: apiKeyRecord, error: keyError } = await supabase
    .from('api_keys')
    .select('id, project_id')
    .eq('key_hash', keyHash)
    .eq('is_active', true)
    .single()

  if (keyError || !apiKeyRecord) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  const projectId = apiKeyRecord.project_id

  // 6. Post-auth project-scoped rate limit check
  if (typeof checkDistributed === 'function') {
    const postRate = await checkDistributed(request, 'ingest', { projectId, supabase })
    if (!postRate.allowed) {
      return postRate.response
    }
  }

  // 7. Update last_used_at
  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKeyRecord.id)

  // 8. Stream/read and validate body with byte-length guard
  let rawBody: unknown
  try {
    if (request.body && typeof (request.body as any).getReader === 'function') {
      const reader = (request.body as any).getReader()
      const chunks: Uint8Array[] = []
      let totalBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.byteLength
          if (totalBytes > MAX_REQUEST_BODY_BYTES) {
            return NextResponse.json(
              {
                error: `Payload Too Large: Request body exceeds maximum allowed size of ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)}MB`,
              },
              { status: 413 }
            )
          }
          chunks.push(value)
        }
      }

      const merged = new Uint8Array(totalBytes)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      const text = new TextDecoder().decode(merged)
      rawBody = JSON.parse(text)
    } else {
      const text = await request.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BODY_BYTES) {
        return NextResponse.json(
          {
            error: `Payload Too Large: Request body exceeds maximum allowed size of ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)}MB`,
          },
          { status: 413 }
        )
      }
      rawBody = JSON.parse(text)
    }
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validation = validateIngestPayload(rawBody)
  if (!validation.success) {
    return NextResponse.json(
      { error: validation.error, details: validation.details },
      { status: 400 }
    )
  }

  const body = validation.data

  try {
    // 9. Find or create session (atomic upsert to prevent race conditions)
    let sessionId: string

    const earliestStart = body.spans.reduce((earliest: string, span: any) => {
      return span.started_at < earliest ? span.started_at : earliest
    }, body.spans[0].started_at)

    if (body.session_id) {
      // Use upsert with onConflict to atomically create-or-find the session
      const { data: session, error: sessionError } = await supabase
        .from('sessions')
        .upsert(
          {
            project_id: projectId,
            external_id: body.session_id,
            name: body.session_name || 'Unnamed Session',
            status: 'running',
            started_at: earliestStart,
          },
          { onConflict: 'project_id,external_id', ignoreDuplicates: false }
        )
        .select('id')
        .single()

      if (sessionError || !session) {
        return NextResponse.json(
          { error: 'Failed to create/find session: ' + (sessionError?.message || 'unknown') },
          { status: 500 }
        )
      }
      sessionId = session.id
    } else {
      // No external session_id — always create a new session
      const { data: newSession, error: sessionError } = await supabase
        .from('sessions')
        .insert({
          project_id: projectId,
          name: body.session_name || 'Unnamed Session',
          status: 'running',
          started_at: earliestStart,
        })
        .select('id')
        .single()

      if (sessionError || !newSession) {
        return NextResponse.json(
          { error: 'Failed to create session: ' + (sessionError?.message || 'unknown') },
          { status: 500 }
        )
      }
      sessionId = newSession.id
    }

    // 10. Insert all spans with client_span_id -> DB UUID mapping
    // Sort: root spans first, then children
    const sortedSpans = [...body.spans].sort((a: any, b: any) => {
      const aIsRoot = !a.parent_span_id && !a.parent_client_span_id
      const bIsRoot = !b.parent_span_id && !b.parent_client_span_id
      if (aIsRoot && !bIsRoot) return -1
      if (!aIsRoot && bIsRoot) return 1
      return 0
    })

    const preparedSpans = sortedSpans.map((span: any) => {
      let durationMs = span.duration_ms
      if (!durationMs && span.started_at && span.ended_at) {
        durationMs = new Date(span.ended_at).getTime() - new Date(span.started_at).getTime()
      }
      const isLegacy = span.is_legacy ?? (!span.trace_id || span.trace_id.startsWith('legacy_'))
      const traceId = span.trace_id || `legacy_${sessionId.replace(/-/g, '')}`
      const spanId = span.span_id || `legacy_${crypto.randomUUID().replace(/-/g, '')}`

      return {
        session_id: sessionId,
        project_id: projectId,
        parent_span_id: span.parent_span_id || null,
        parent_span_id_hex: span.parent_span_id_hex || null,
        parent_client_span_id: span.parent_client_span_id || null,
        client_span_id: span.client_span_id || null,
        name: span.name,
        span_type: span.span_type || 'chain',
        status: span.status || 'ok',
        started_at: span.started_at,
        ended_at: span.ended_at || null,
        duration_ms: durationMs || null,
        model: span.model || null,
        input: span.input || null,
        output: span.output || null,
        error_message: span.error_message || null,
        input_tokens: span.input_tokens || null,
        output_tokens: span.output_tokens || null,
        cost_usd: span.cost_usd || null,
        metadata: span.metadata || {},
        trace_id: traceId,
        span_id: spanId,
        is_legacy: isLegacy,
        attributes: span.attributes || {},
        links: span.links || [],
        workflow_step: span.workflow_step || null,
        iteration_index: span.iteration_index || null,
      }
    })

    let spanIds: string[] = []
    let spansToInsert: any[] = []
    let usedRpc = false
    let rpcErrorMessage = ''

    // Attempt single-transaction batch RPC
    if (typeof (supabase as any).rpc === 'function') {
      try {
        const { data: rpcSpans, error: rpcErr } = await (supabase as any).rpc(
          'ingest_spans_batch_transactional',
          {
            p_project_id: projectId,
            p_session_id: sessionId,
            p_spans: preparedSpans,
          }
        )
        if (!rpcErr && Array.isArray(rpcSpans) && rpcSpans.length > 0) {
          spanIds = rpcSpans.map((r: any) => r.out_db_id || r.db_id)
          spansToInsert = preparedSpans
          usedRpc = true
        } else if (rpcErr) {
          rpcErrorMessage = rpcErr.message || 'Transactional RPC error'
        }
      } catch (err: any) {
        rpcErrorMessage = err?.message || 'Transactional RPC threw exception'
      }
    }

    if (!usedRpc) {
      // In production or default mode, FAIL CLOSED: eliminate silent fallback to direct table inserts
      const allowFallback =
        process.env.NODE_ENV === 'test' && process.env.ALLOW_INGEST_FALLBACK === 'true'

      if (!allowFallback) {
        console.error(
          '[Ingest] Transactional ingestion failed or unavailable; failing closed:',
          rpcErrorMessage
        )
        return NextResponse.json(
          {
            error: 'Ingestion temporarily unavailable; please retry',
            details: rpcErrorMessage || 'Transactional ingestion RPC unavailable',
            retryable: true,
          },
          {
            status: 503,
            headers: {
              'Retry-After': '5',
            },
          }
        )
      }

      // Explicit test-only fallback path for environments mocking only tables
      const clientToDbId = new Map<string, string>()
      for (const span of preparedSpans) {
        let resolvedParentId = span.parent_span_id || null
        if (!resolvedParentId && span.parent_client_span_id) {
          resolvedParentId = clientToDbId.get(span.parent_client_span_id) || null
        }

        const spanRow = {
          session_id: sessionId,
          project_id: projectId,
          parent_span_id: resolvedParentId,
          name: span.name,
          span_type: span.span_type,
          status: span.status,
          started_at: span.started_at,
          ended_at: span.ended_at,
          duration_ms: span.duration_ms,
          model: span.model,
          input: span.input,
          output: span.output,
          error_message: span.error_message,
          input_tokens: span.input_tokens,
          output_tokens: span.output_tokens,
          cost_usd: span.cost_usd,
          metadata: span.metadata,
        }

        const { data: inserted, error: insertErr } = await supabase
          .from('spans')
          .insert(spanRow)
          .select('id')
          .single()

        if (insertErr || !inserted) {
          return NextResponse.json(
            { error: 'Failed to insert span: ' + (insertErr?.message || 'unknown') },
            { status: 500 }
          )
        }

        const dbId = inserted.id
        spanIds.push(dbId)
        spansToInsert.push(spanRow)

        if (span.client_span_id) {
          clientToDbId.set(span.client_span_id, dbId)
        }
      }

      // Schedule evaluations via transactional outbox
      for (let i = 0; i < spansToInsert.length; i++) {
        if (spansToInsert[i].span_type === 'llm') {
          const traceId = spansToInsert[i].trace_id || `legacy_${sessionId.replace(/-/g, '')}`
          const spanDbId = spanIds[i]
          Promise.resolve(
            supabase
              .from('evaluation_outbox')
              .upsert(
                {
                  project_id: projectId,
                  trace_id: traceId,
                  span_id: spanDbId,
                  eval_type: 'span_score',
                  trace_version: 1,
                  status: 'pending',
                  scheduled_at: new Date(Date.now() + 15000).toISOString(),
                  payload: {
                    span_id: spanDbId,
                    input: spansToInsert[i].input,
                    output: spansToInsert[i].output,
                  },
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'project_id,trace_id,eval_type' }
              )
          ).catch(() => {})
        }
      }
    }

    // 11. Update session aggregates
    const { data: allSpans } = await supabase
      .from('spans')
      .select('status, input_tokens, output_tokens, cost_usd, ended_at, started_at')
      .eq('session_id', sessionId)

    if (allSpans) {
      const spanCount = allSpans.length
      const errorCount = allSpans.filter((s: any) => s.status === 'error').length
      const totalTokens = allSpans.reduce((sum: number, s: any) => {
        return sum + (s.input_tokens || 0) + (s.output_tokens || 0)
      }, 0)
      const totalCost = allSpans.reduce((sum: number, s: any) => {
        return sum + (s.cost_usd || 0)
      }, 0)

      let sessionStatus: string = 'running'
      const hasErrors = errorCount > 0
      const allHaveEndedAt = allSpans.every((s: any) => s.ended_at != null)

      if (hasErrors) {
        sessionStatus = 'error'
      } else if (allHaveEndedAt && allSpans.length > 0) {
        sessionStatus = 'success'
      }

      let latestEndedAt: string | null = null
      if (allHaveEndedAt && allSpans.length > 0) {
        latestEndedAt = allSpans.reduce((latest: string, s: any) => {
          return s.ended_at > latest ? s.ended_at : latest
        }, allSpans[0].ended_at)
      }

      await supabase
        .from('sessions')
        .update({
          span_count: spanCount,
          error_count: errorCount,
          total_tokens: totalTokens,
          total_cost_usd: totalCost,
          status: sessionStatus,
          ...(latestEndedAt ? { ended_at: latestEndedAt } : {}),
        })
        .eq('id', sessionId)
    }

    // Fire-and-forget: Check alert rules
    checkAndFireAlerts(projectId).catch(() => {})

    // 12. Auto-group errors into issues
    const errorSpans = body.spans.filter((s: any) => s.status === 'error')

    for (let i = 0; i < errorSpans.length; i++) {
      const span = errorSpans[i]
      const originalIndex = body.spans.indexOf(span)
      const spanDbId = spanIds[originalIndex]

      const fingerprintInput =
        projectId + ':' + span.name + ':' + (span.error_message || '').slice(0, 50)
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
          .insert({
            issue_id: existingIssue.id,
            span_id: spanDbId,
          })
      } else {
        const title = span.name + ': ' + (span.error_message || 'Unknown error').slice(0, 80)
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
            .insert({
              issue_id: newIssue.id,
              span_id: spanDbId,
            })
        }
      }
    }

    // 13. Return response
    return NextResponse.json({
      session_id: sessionId,
      span_ids: spanIds,
      spans_ingested: spanIds.length,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 })
  }
}
