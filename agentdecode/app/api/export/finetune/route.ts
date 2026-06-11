import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * GET /api/export/finetune?project_id=xxx&min_score=9
 *
 * Exports high-quality LLM traces as a JSONL file formatted for
 * OpenAI / Llama fine-tuning. Finds all LLM spans in the project
 * with eval_scores >= min_score, then formats each as a
 * {"messages": [...]} training example.
 *
 * Auth: requires logged-in user with access to the project.
 * Cost: $0 — just a Postgres query + text formatting.
 */
export async function GET(request: NextRequest) {
  const rateLimit = checkRateLimit(request, 'read')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('project_id')
  const minScore = parseFloat(searchParams.get('min_score') || '8')

  if (!projectId) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  if (isNaN(minScore) || minScore < 0 || minScore > 10) {
    return NextResponse.json({ error: 'min_score must be between 0 and 10' }, { status: 400 })
  }

  // Auth check — use the user's session (RLS enforced)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify user has access to this project (RLS will handle this)
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  // Fetch all LLM spans with high eval scores
  // Join spans with eval_scores where score >= min_score
  const { data: spans, error } = await supabase
    .from('spans')
    .select(`
      id,
      name,
      model,
      input,
      output,
      eval_scores!inner (
        score,
        reasoning
      )
    `)
    .eq('project_id', projectId)
    .eq('span_type', 'llm')
    .gte('eval_scores.score', minScore)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: 'Failed to query spans: ' + error.message }, { status: 500 })
  }

  if (!spans || spans.length === 0) {
    return NextResponse.json({
      error: `No LLM spans found with eval score >= ${minScore}. Try lowering the threshold.`,
      total: 0,
    }, { status: 404 })
  }

  // Format each span as a JSONL training example
  // OpenAI fine-tuning format: {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
  const lines: string[] = []

  for (const span of spans) {
    const input = span.input as Record<string, any> | null
    const output = span.output as Record<string, any> | null

    if (!input || !output) continue

    // Try to extract messages from the input
    const messages: Array<{ role: string; content: string }> = []

    // If input has a messages array, use it directly
    if (input.messages && Array.isArray(input.messages)) {
      for (const msg of input.messages) {
        if (msg.role && msg.content) {
          messages.push({ role: msg.role, content: String(msg.content) })
        }
      }
    } else {
      // Fallback: treat the entire input as a user message
      messages.push({ role: 'user', content: JSON.stringify(input) })
    }

    // Extract assistant response from output
    let assistantContent = ''
    if (output.response) {
      assistantContent = String(output.response)
    } else if (output.content) {
      assistantContent = String(output.content)
    } else if (output.text) {
      assistantContent = String(output.text)
    } else if (output.choices && Array.isArray(output.choices) && output.choices[0]?.message?.content) {
      assistantContent = String(output.choices[0].message.content)
    } else {
      // Fallback: stringify the entire output
      assistantContent = JSON.stringify(output)
    }

    if (!assistantContent) continue

    messages.push({ role: 'assistant', content: assistantContent })

    const trainingExample = { messages }
    lines.push(JSON.stringify(trainingExample))
  }

  if (lines.length === 0) {
    return NextResponse.json({
      error: 'No exportable training examples found. Spans may be missing structured input/output.',
      total: 0,
    }, { status: 404 })
  }

  const jsonlContent = lines.join('\n')
  const filename = `${project.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_finetune_${new Date().toISOString().slice(0, 10)}.jsonl`

  return new NextResponse(jsonlContent, {
    status: 200,
    headers: {
      'Content-Type': 'application/jsonl',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Total-Examples': String(lines.length),
      'X-Min-Score': String(minScore),
    },
  })
}
