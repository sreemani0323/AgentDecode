import { createServiceClient } from '../lib/supabase/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const [key, ...vals] = line.split('=')
    if (key && vals.length > 0) {
      process.env[key.trim()] = vals.join('=').trim()
    }
  }
}

// Initialize client using project's createServiceClient utility
let supabase: ReturnType<typeof createServiceClient>
try {
  supabase = createServiceClient()
} catch (err: any) {
  console.error('Failed to initialize Supabase client:', err.message)
  process.exit(1)
}

async function seed() {
  console.log('Looking for existing project named "Customer Support Agent"...')

  // 1. Get or create an organization
  let orgId: string
  const { data: orgs, error: orgErr } = await supabase
    .from('organizations')
    .select('id')
    .limit(1)

  if (orgErr) {
    if (orgErr.message.includes('fetch failed')) {
      console.error('\nError: Failed to connect to Supabase (fetch failed).')
      console.error('This usually occurs when your Supabase project is paused or deleted,')
      console.error('or if you have network connectivity issues (e.g. DNS resolution failed for the project URL).\n')
      console.error('Project URL in use:', process.env.NEXT_PUBLIC_SUPABASE_URL)
      console.error('Please verify that your Supabase project is active/resumed in your Supabase dashboard.\n')
    } else {
      console.error('Error fetching organization:', orgErr.message)
    }
    return
  }

  if (orgs && orgs.length > 0) {
    orgId = orgs[0].id
  } else {
    // Create a demo org
    console.log('No organization found. Creating "Demo Organization"...')
    const { data: newOrg, error: newOrgErr } = await supabase
      .from('organizations')
      .insert({
        name: 'Demo Organization',
        slug: 'demo-organization-' + Math.random().toString(36).substring(2, 7)
      })
      .select('id')
      .single()

    if (newOrgErr || !newOrg) {
      console.error('Failed to create default organization:', newOrgErr?.message || 'Unknown error')
      return
    }
    orgId = newOrg.id
  }

  // 2. Clean up any existing "Customer Support Agent" project
  const { data: existingProjects } = await supabase
    .from('projects')
    .select('id')
    .eq('name', 'Customer Support Agent')

  if (existingProjects && existingProjects.length > 0) {
    console.log('Cleaning up existing "Customer Support Agent" project data...')
    for (const proj of existingProjects) {
      await supabase.from('projects').delete().eq('id', proj.id)
    }
  }

  // 3. Create the new project
  console.log('Creating project "Customer Support Agent"...')
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .insert({
      org_id: orgId,
      name: 'Customer Support Agent',
      description: 'Production support bot handling order inquiries, refunds, and escalations'
    })
    .select('id')
    .single()

  if (projErr || !project) {
    console.error('Failed to create project:', projErr?.message || 'Unknown error')
    return
  }
  const projectId = project.id
  console.log(`Created project with ID: ${projectId}`)

  const now = new Date()
  const startTimes = [
    new Date(now.getTime() - 6.5 * 24 * 3600 * 1000),
    new Date(now.getTime() - 6.0 * 24 * 3600 * 1000),
    new Date(now.getTime() - 5.2 * 24 * 3600 * 1000),
    new Date(now.getTime() - 4.8 * 24 * 3600 * 1000),
    new Date(now.getTime() - 4.1 * 24 * 3600 * 1000),
    new Date(now.getTime() - 3.5 * 24 * 3600 * 1000),
    new Date(now.getTime() - 3.0 * 24 * 3600 * 1000),
    new Date(now.getTime() - 2.4 * 24 * 3600 * 1000),
    new Date(now.getTime() - 2.0 * 24 * 3600 * 1000),
    new Date(now.getTime() - 1.5 * 24 * 3600 * 1000),
    new Date(now.getTime() - 1.1 * 24 * 3600 * 1000),
    new Date(now.getTime() - 0.8 * 24 * 3600 * 1000),
    // Error sessions
    new Date(now.getTime() - 5.0 * 24 * 3600 * 1000), // Error Session 1 (Index 12)
    new Date(now.getTime() - 3.2 * 24 * 3600 * 1000), // Error Session 2 (Index 13)
    new Date(now.getTime() - 0.5 * 24 * 3600 * 1000), // Error Session 3 (Index 14)
  ]

  const sessionsToInsert: Record<string, unknown>[] = []
  const spansToInsert: Record<string, unknown>[] = []
  const evalsToInsert: Record<string, unknown>[] = []
  const explanationsToInsert: Record<string, unknown>[] = []
  const issueSpansToInsert: Record<string, unknown>[] = []

  // Pre-generate issue IDs
  const kbTimeoutIssueId = crypto.randomUUID()
  const rateLimitIssueId = crypto.randomUUID()

  const kbTimeoutErrorSpans: { id: string; started_at: Date }[] = []
  const rateLimitErrorSpans: { id: string; started_at: Date }[] = []

  for (let i = 0; i < 15; i++) {
    const sessionId = crypto.randomUUID()
    const startedAt = startTimes[i]
    const isErrorSession = i >= 12
    const status = isErrorSession ? 'error' : 'success'
    const extId = `session_${i + 1}_${Math.random().toString(36).substring(2, 5)}`
    const name = `Customer Support Session #${i + 1}`

    const rootSpanId = crypto.randomUUID()
    let currentOffsetMs = 0

    const childSpans: any[] = []
    let totalTokens = 0
    let totalCost = 0

    const addAgentChild = (
      spanName: string,
      type: 'llm' | 'tool' | 'chain' | 'retrieval' | 'agent',
      spanStatus: 'ok' | 'error',
      duration: number,
      model: string | null,
      input: any,
      output: any,
      errMessage: string | null = null
    ) => {
      const spanId = crypto.randomUUID()
      const spanStart = new Date(startedAt.getTime() + currentOffsetMs)
      const spanEnd = new Date(spanStart.getTime() + duration)
      
      let inputTokens = null
      let outputTokens = null
      let cost = null

      if (type === 'llm') {
        inputTokens = Math.floor(50 + Math.random() * 450)
        outputTokens = Math.floor(20 + Math.random() * 180)
        
        const rate = model === 'gpt-4o' 
          ? { input: 0.005, output: 0.015 } 
          : { input: 0.00015, output: 0.0006 }
        
        cost = (inputTokens * rate.input + outputTokens * rate.output) / 1000
        totalTokens += (inputTokens + outputTokens)
        totalCost += cost
      }

      const span = {
        id: spanId,
        session_id: sessionId,
        project_id: projectId,
        parent_span_id: rootSpanId,
        name: spanName,
        span_type: type,
        status: spanStatus,
        started_at: spanStart.toISOString(),
        ended_at: spanEnd.toISOString(),
        duration_ms: duration,
        model,
        input,
        output,
        error_message: errMessage,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: cost,
        metadata: { env: 'production' }
      }

      childSpans.push(span)
      currentOffsetMs += duration

      // Generate eval_scores for ALL LLM spans (ok and error)
      if (type === 'llm') {
        let score = 0
        let reasoning = ''
        let flagged = false

        if (spanStatus === 'error') {
          // Error spans get low scores
          score = parseFloat((1.0 + Math.random() * 3.0).toFixed(1))
          reasoning = 'Request failed before model could generate output.'
          flagged = true
        } else {
          const r = Math.random()
          if (r < 0.70) {
            score = parseFloat((7.0 + Math.random() * 3.0).toFixed(1))
            reasoning = 'The response directly answered the customer query with accurate details.'
            flagged = false
          } else if (r < 0.90) {
            score = parseFloat((5.0 + Math.random() * 2.0).toFixed(1))
            reasoning = 'The response was clear, but missed referencing refund rules.'
            flagged = false
          } else {
            score = parseFloat((Math.random() * 5.0).toFixed(1))
            reasoning = 'Response contains formatting issues or incomplete resolution.'
            flagged = true
          }
        }

        evalsToInsert.push({
          span_id: spanId,
          score,
          reasoning,
          flagged,
          generated_at: spanEnd.toISOString()
        })
      }

      return span
    }

    if (!isErrorSession) {
      // Success session
      addAgentChild(
        'classify_intent',
        'llm',
        'ok',
        Math.floor(300 + Math.random() * 500),
        'gpt-4o-mini',
        { message: 'I would like to request a refund for order #2881. It arrived broken.' },
        { intent: 'refund_request', confidence: 0.97 }
      )

      addAgentChild(
        'search_knowledge_base',
        'retrieval',
        'ok',
        Math.floor(200 + Math.random() * 400),
        null,
        { query: 'refund eligibility broken order' },
        {
          documents: [
            { title: 'Refund Policy', snippet: 'Damaged or broken goods are eligible for full refunds within 30 days.' }
          ]
        }
      )

      addAgentChild(
        'generate_response',
        'llm',
        'ok',
        Math.floor(1500 + Math.random() * 2000),
        'gpt-4o',
        {
          intent: 'refund_request',
          docs: ['Damaged or broken goods are eligible for full refunds within 30 days.']
        },
        { text: 'I am sorry to hear your order #2881 arrived broken. I will process a full refund right away.' }
      )

      addAgentChild(
        'send_reply',
        'tool',
        'ok',
        Math.floor(150 + Math.random() * 250),
        null,
        { recipient: 'customer@example.com', body: 'I am sorry to hear your order #2881 arrived broken. I will process a full refund right away.' },
        { status: 'sent', message_id: 'msg_' + Math.random().toString(36).substring(2, 8) }
      )

      if (i === 4 || i === 8) {
        addAgentChild(
          'escalate_to_human',
          'tool',
          'ok',
          Math.floor(400 + Math.random() * 500),
          null,
          { ticket_reason: 'large_refund_value' },
          { escalated: true, queue: 'tier-2-support', ticket_id: 'ticket_' + Math.random().toString(36).substring(2, 8) }
        )
      }
    } else if (i === 12) {
      // Error Session 1: KB timeout (3 times)
      addAgentChild(
        'classify_intent',
        'llm',
        'ok',
        Math.floor(300 + Math.random() * 500),
        'gpt-4o-mini',
        { message: 'Can you check if order #9928 is shipped? I paid extra for express shipping.' },
        { intent: 'shipping_status', confidence: 0.99 }
      )

      const span1 = addAgentChild(
        'search_knowledge_base',
        'retrieval',
        'error',
        5000,
        null,
        { query: 'express shipping policies tracking' },
        null,
        'Knowledge base timeout after 5000ms'
      )
      kbTimeoutErrorSpans.push({ id: span1.id, started_at: new Date(span1.started_at) })

      const span2 = addAgentChild(
        'search_knowledge_base',
        'retrieval',
        'error',
        5000,
        null,
        { query: 'express shipping policies tracking' },
        null,
        'Knowledge base timeout after 5000ms'
      )
      kbTimeoutErrorSpans.push({ id: span2.id, started_at: new Date(span2.started_at) })

      const span3 = addAgentChild(
        'search_knowledge_base',
        'retrieval',
        'error',
        5000,
        null,
        { query: 'express shipping policies tracking' },
        null,
        'Knowledge base timeout after 5000ms'
      )
      kbTimeoutErrorSpans.push({ id: span3.id, started_at: new Date(span3.started_at) })

      addAgentChild(
        'escalate_to_human',
        'tool',
        'ok',
        Math.floor(500 + Math.random() * 500),
        null,
        { ticket_reason: 'kb_query_failures' },
        { escalated: true, queue: 'tier-2-support', ticket_id: 'ticket_kb_err_1' }
      )
    } else if (i === 13) {
      // Error Session 2: KB timeout (1 time)
      addAgentChild(
        'classify_intent',
        'llm',
        'ok',
        Math.floor(300 + Math.random() * 500),
        'gpt-4o-mini',
        { message: 'I got charged twice for my subscription. Please help!' },
        { intent: 'double_charge_billing', confidence: 0.96 }
      )

      const span = addAgentChild(
        'search_knowledge_base',
        'retrieval',
        'error',
        5000,
        null,
        { query: 'double billing charges' },
        null,
        'Knowledge base timeout after 5000ms'
      )
      kbTimeoutErrorSpans.push({ id: span.id, started_at: new Date(span.started_at) })

      addAgentChild(
        'escalate_to_human',
        'tool',
        'ok',
        Math.floor(500 + Math.random() * 500),
        null,
        { ticket_reason: 'kb_query_failures' },
        { escalated: true, queue: 'billing-escalation', ticket_id: 'ticket_billing_err_1' }
      )
    } else if (i === 14) {
      // Error Session 3: Rate limit exceeded (2 times)
      const span1 = addAgentChild(
        'classify_intent',
        'llm',
        'error',
        Math.floor(200 + Math.random() * 200),
        'gpt-4o-mini',
        { message: 'Cancel my account immediately. It is too slow.' },
        null,
        'Rate limit exceeded on OpenAI API'
      )
      rateLimitErrorSpans.push({ id: span1.id, started_at: new Date(span1.started_at) })

      const span2 = addAgentChild(
        'generate_response',
        'llm',
        'error',
        Math.floor(200 + Math.random() * 200),
        'gpt-4o',
        { message: 'Cancel account message' },
        null,
        'Rate limit exceeded on OpenAI API'
      )
      rateLimitErrorSpans.push({ id: span2.id, started_at: new Date(span2.started_at) })

      addAgentChild(
        'escalate_to_human',
        'tool',
        'ok',
        Math.floor(500 + Math.random() * 500),
        null,
        { ticket_reason: 'internal_agent_api_failures' },
        { escalated: true, queue: 'general-support', ticket_id: 'ticket_rate_limit_1' }
      )
    }

    // Assemble the root span for the session
    const rootSpan = {
      id: rootSpanId,
      session_id: sessionId,
      project_id: projectId,
      parent_span_id: null,
      name: 'agent_run',
      span_type: 'agent',
      status: isErrorSession ? 'error' : 'ok',
      started_at: startedAt.toISOString(),
      ended_at: new Date(startedAt.getTime() + currentOffsetMs).toISOString(),
      duration_ms: currentOffsetMs,
      model: null,
      input: childSpans[0]?.input || { info: 'Session started' },
      output: childSpans[childSpans.length - 1]?.output || { info: 'Session completed' },
      error_message: isErrorSession ? 'Agent execution encountered errors' : null,
      input_tokens: totalTokens > 0 ? Math.floor(totalTokens * 0.6) : null,
      output_tokens: totalTokens > 0 ? Math.floor(totalTokens * 0.4) : null,
      cost_usd: totalCost,
      metadata: { env: 'production' }
    }

    spansToInsert.push(rootSpan)
    for (const child of childSpans) {
      spansToInsert.push(child)
    }

    sessionsToInsert.push({
      id: sessionId,
      project_id: projectId,
      external_id: extId,
      name: name,
      status: status,
      started_at: startedAt.toISOString(),
      ended_at: rootSpan.ended_at,
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      span_count: childSpans.length + 1,
      error_count: isErrorSession ? childSpans.filter(s => s.status === 'error').length : 0
    })
  }

  // Generate Explanations for 3 of the error spans
  explanationsToInsert.push({
    span_id: kbTimeoutErrorSpans[0].id,
    diagnosis: 'The query to the Pinecone vector database timed out after 5000ms. This was caused by high query concurrency on the Pinecone free-tier starter index, which experienced a temporary node degradation.',
    suggested_fix: 'Implement a short-lived cache (Redis or local LRU cache) for common semantic queries, increase Pinecone client timeout to 10000ms with exponential retries, or consider upgrading to a Pinecone serverless index for production workloads.',
    generated_at: new Date(kbTimeoutErrorSpans[0].started_at.getTime() + 1000).toISOString()
  })

  explanationsToInsert.push({
    span_id: kbTimeoutErrorSpans[3].id, // Last KB error
    diagnosis: 'Retry request to Pinecone vector database timed out again. The primary index host remained unresponsive under the retry window, indicating a persistent network timeout between Next.js server and Pinecone US-East region.',
    suggested_fix: 'Configure the client to failover to a static fallback response or cached local embeddings database (e.g. SQLite-VSS) when consecutive timeout exceptions occur in the same session.',
    generated_at: new Date(kbTimeoutErrorSpans[3].started_at.getTime() + 1000).toISOString()
  })

  explanationsToInsert.push({
    span_id: rateLimitErrorSpans[0].id,
    diagnosis: 'The OpenAI API returned a 429 error code ("Rate limit exceeded"). The organization has consumed its token-per-minute (TPM) limit on the gpt-4o-mini model in the current billing tier.',
    suggested_fix: 'Implement token-bucket rate limiting on the client-side to queue requests before sending, upgrade the OpenAI usage tier (Tier 1 to Tier 2), or add a fallback to an alternate LLM provider (e.g., Anthropic Claude-3-Haiku or Groq Llama-3) in your gateway router.',
    generated_at: new Date(rateLimitErrorSpans[0].started_at.getTime() + 1000).toISOString()
  })

  // Create Issues
  const kbTimes = kbTimeoutErrorSpans.map(s => s.started_at.getTime())
  const minKbTime = new Date(Math.min(...kbTimes))
  const maxKbTime = new Date(Math.max(...kbTimes))

  const rlTimes = rateLimitErrorSpans.map(s => s.started_at.getTime())
  const minRlTime = new Date(Math.min(...rlTimes))
  const maxRlTime = new Date(Math.max(...rlTimes))

  const issuesToInsert = [
    {
      id: kbTimeoutIssueId,
      project_id: projectId,
      title: 'Knowledge base timeout after 5000ms',
      error_fingerprint: 'kb_timeout',
      status: 'open',
      occurrence_count: 4,
      first_seen_at: minKbTime.toISOString(),
      last_seen_at: maxKbTime.toISOString(),
      created_at: minKbTime.toISOString()
    },
    {
      id: rateLimitIssueId,
      project_id: projectId,
      title: 'Rate limit exceeded on OpenAI API',
      error_fingerprint: 'rate_limit',
      status: 'open',
      occurrence_count: 2,
      first_seen_at: minRlTime.toISOString(),
      last_seen_at: maxRlTime.toISOString(),
      created_at: minRlTime.toISOString()
    }
  ]

  for (const span of kbTimeoutErrorSpans) {
    issueSpansToInsert.push({
      issue_id: kbTimeoutIssueId,
      span_id: span.id
    })
  }

  for (const span of rateLimitErrorSpans) {
    issueSpansToInsert.push({
      issue_id: rateLimitIssueId,
      span_id: span.id
    })
  }

  // Insert into DB
  try {
    console.log('Inserting sessions...')
    const { error: sessErr } = await supabase.from('sessions').insert(sessionsToInsert)
    if (sessErr) throw sessErr

    console.log('Inserting spans...')
    const { error: spansErr } = await supabase.from('spans').insert(spansToInsert)
    if (spansErr) throw spansErr

    console.log('Inserting eval scores...')
    const { error: evalsErr } = await supabase.from('eval_scores').insert(evalsToInsert)
    if (evalsErr) throw evalsErr

    console.log('Inserting AI explanations...')
    const { error: explsErr } = await supabase.from('ai_explanations').insert(explanationsToInsert)
    if (explsErr) throw explsErr

    console.log('Inserting issues...')
    const { error: issuesErr } = await supabase.from('issues').insert(issuesToInsert)
    if (issuesErr) throw issuesErr

    console.log('Inserting issue_spans...')
    const { error: isErr } = await supabase.from('issue_spans').insert(issueSpansToInsert)
    if (isErr) throw isErr

    console.log('\n=============================================')
    console.log('Created project: Customer Support Agent')
    console.log('Sessions: 15 (12 success, 3 error)')
    console.log(`Spans: ${spansToInsert.length}`)
    console.log('Issues: 2')
    console.log('Visit /dashboard to see it')
    console.log('=============================================\n')
  } catch (err: any) {
    console.error('Error seeding database:', err.message || err)
  }
}

seed().catch(console.error)
