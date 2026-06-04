import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hashApiKey } from '@/lib/utils'
import { scoreSpanWithGroq } from '@/lib/groq'
import { checkAndFireAlerts } from '@/lib/alerts'
import { ingestRateLimiter, getClientIdentifier } from '@/lib/rate-limit'
import { checkEnv } from '@/lib/env'

export async function POST(request: Request) {
  // 0. Check critical env vars
  const envCheck = checkEnv()
  if (!envCheck.ok) {
    const missingKeys = envCheck.missing.map(m => m.key).join(', ')
    return NextResponse.json(
      { error: `Server misconfigured. Missing: ${missingKeys}` },
      { status: 503 }
    )
  }

  // 1. Get Authorization header
  const authHeader = request.headers.get('authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
  }

  const apiKeyRaw = authHeader.replace('Bearer ', '')

  // 2. Rate limit check (uses API key as identifier)
  const clientId = getClientIdentifier(request, apiKeyRaw)
  const rateCheck = ingestRateLimiter.check(clientId)

  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded. Please slow down.',
        retry_after_ms: rateCheck.retryAfterMs,
      },
      {
        status: 429,
        headers: {
          'Retry-After': Math.ceil(rateCheck.retryAfterMs / 1000).toString(),
          'X-RateLimit-Remaining': '0',
        },
      }
    )
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

  // 8. Update last_used_at
  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKeyRecord.id)

  // Parse body
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.spans || !Array.isArray(body.spans) || body.spans.length === 0) {
    return NextResponse.json({ error: 'spans array is required and must not be empty' }, { status: 400 })
  }

  try {
    // 9. Find or create session
    let sessionId: string

    if (body.session_id) {
      // Try to find existing session with this external_id
      const { data: existingSession } = await supabase
        .from('sessions')
        .select('id')
        .eq('external_id', body.session_id)
        .eq('project_id', projectId)
        .single()

      if (existingSession) {
        sessionId = existingSession.id
      } else {
        // Create new session with external_id (handle race condition)
        const earliestStart = body.spans.reduce((earliest: string, span: any) => {
          return span.started_at < earliest ? span.started_at : earliest
        }, body.spans[0].started_at)

        const { data: newSession, error: sessionError } = await supabase
          .from('sessions')
          .insert({
            project_id: projectId,
            external_id: body.session_id,
            name: body.session_name || 'Unnamed Session',
            status: 'running',
            started_at: earliestStart,
          })
          .select('id')
          .maybeSingle()

        if (sessionError) {
          // If it's a unique constraint violation (race condition), just fetch it
          if (sessionError.code === '23505') {
            const { data: retrySession } = await supabase
              .from('sessions')
              .select('id')
              .eq('external_id', body.session_id)
              .eq('project_id', projectId)
              .single()
              
            if (retrySession) {
              sessionId = retrySession.id
            } else {
              return NextResponse.json({ error: 'Failed to create or find session after race: ' + sessionError.message }, { status: 500 })
            }
          } else {
            return NextResponse.json({ error: 'Failed to create session: ' + sessionError.message }, { status: 500 })
          }
        } else if (newSession) {
          sessionId = newSession.id
        } else {
          return NextResponse.json({ error: 'Failed to create session: unknown error' }, { status: 500 })
        }
      }
    } else {
      // No external session_id — create a new session
      const earliestStart = body.spans.reduce((earliest: string, span: any) => {
        return span.started_at < earliest ? span.started_at : earliest
      }, body.spans[0].started_at)

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
        return NextResponse.json({ error: 'Failed to create session: ' + (sessionError?.message || 'unknown') }, { status: 500 })
      }
      sessionId = newSession.id
    }

    // 10. Insert all spans
    const spansToInsert = body.spans.map((span: any) => {
      let durationMs = span.duration_ms
      if (!durationMs && span.started_at && span.ended_at) {
        durationMs = new Date(span.ended_at).getTime() - new Date(span.started_at).getTime()
      }

      return {
        session_id: sessionId,
        project_id: projectId,
        parent_span_id: span.parent_span_id || null,
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
      }
    })

    const { data: insertedSpans, error: spansError } = await supabase
      .from('spans')
      .insert(spansToInsert)
      .select('id')

    if (spansError || !insertedSpans) {
      return NextResponse.json({ error: 'Failed to insert spans: ' + (spansError?.message || 'unknown') }, { status: 500 })
    }

    const spanIds = insertedSpans.map((s: any) => s.id)

    // Fire-and-forget: Score LLM spans with Groq
    for (let i = 0; i < spansToInsert.length; i++) {
      if (spansToInsert[i].span_type === 'llm') {
        scoreSpanWithGroq(spanIds[i], spansToInsert[i].input, spansToInsert[i].output).catch(() => {})
      }
    }

    // 11. Update session aggregates
    // Get ALL spans for this session (including previously ingested ones)
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

      // Determine session status
      let sessionStatus: string = 'running'
      const hasErrors = errorCount > 0
      const allHaveEndedAt = allSpans.every((s: any) => s.ended_at != null)

      if (hasErrors) {
        sessionStatus = 'error'
      } else if (allHaveEndedAt && allSpans.length > 0) {
        sessionStatus = 'success'
      }

      // Find latest ended_at
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
      // Find the matching inserted span ID
      // errorSpans are a subset of body.spans, find their index in the original array
      const originalIndex = body.spans.indexOf(span)
      const spanDbId = spanIds[originalIndex]

      // Simple fingerprint: base64 of project_id + span.name + first 50 chars of error_message
      const fingerprintInput = projectId + ':' + span.name + ':' + (span.error_message || '').slice(0, 50)
      const fingerprint = btoa(encodeURIComponent(fingerprintInput))

      // Check if issue with same fingerprint exists
      const { data: existingIssue } = await supabase
        .from('issues')
        .select('id, occurrence_count')
        .eq('project_id', projectId)
        .eq('error_fingerprint', fingerprint)
        .single()

      if (existingIssue) {
        // Update existing issue
        await supabase
          .from('issues')
          .update({
            occurrence_count: existingIssue.occurrence_count + 1,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existingIssue.id)

        // Insert into issue_spans
        await supabase
          .from('issue_spans')
          .insert({
            issue_id: existingIssue.id,
            span_id: spanDbId,
          })
      } else {
        // Create new issue
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
