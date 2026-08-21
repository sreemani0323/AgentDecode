import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentDecode, SessionRunner } from '../src/client'
import { Session, SpanContext } from '../src/session'
import { Span } from '../src/span'

// ── AgentDecode client tests ──────────────────────────────────────

describe('AgentDecode', () => {
  it('throws on empty apiKey', () => {
    expect(() => new AgentDecode({ apiKey: '' })).toThrow('apiKey is required')
  })

  it('strips trailing slash from endpoint', () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'https://example.com/',
    })
    expect(agent.endpoint).toBe('https://example.com')
  })

  it('uses default endpoint when not provided', () => {
    const agent = new AgentDecode({ apiKey: 'al_test' })
    expect(agent.endpoint).toBe('https://agent-decode.vercel.app')
  })

  it('uses default timeout and maxRetries', () => {
    const agent = new AgentDecode({ apiKey: 'al_test' })
    expect(agent.timeout).toBe(10)
    expect(agent.maxRetries).toBe(3)
  })

  it('accepts custom timeout and maxRetries', () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      timeout: 5,
      maxRetries: 1,
    })
    expect(agent.timeout).toBe(5)
    expect(agent.maxRetries).toBe(1)
  })

  it('creates session with correct options', () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost:3000',
    })
    const runner = agent.session('Test Run', 'session-123')
    expect(runner).toBeInstanceOf(SessionRunner)
  })

  it('trace() returns function result', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    // Mock fetch to prevent real HTTP calls
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}',
    })

    // Patch the session's fetch
    const origSession = agent.session.bind(agent)
    vi.spyOn(agent, 'session').mockImplementation((name, sessionId) => {
      const runner = origSession(name, sessionId)
      runner._session._fetchFn = mockFetch
      return runner
    })

    const result = await agent.trace('test_op', 'tool', async () => {
      return { answer: 42 }
    })

    expect(result).toEqual({ answer: 42 })
  })

  it('trace() captures exception and still flushes', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}',
    })

    const origSession = agent.session.bind(agent)
    vi.spyOn(agent, 'session').mockImplementation((name, sessionId) => {
      const runner = origSession(name, sessionId)
      runner._session._fetchFn = mockFetch
      return runner
    })

    await expect(
      agent.trace('failing_op', 'tool', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Flush should have been called (even on error)
    expect(mockFetch).toHaveBeenCalled()
  })
})

// ── Session tests ─────────────────────────────────────────────────

describe('Session', () => {
  let session: Session
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}',
    })

    session = new Session({
      sessionName: 'Test Session',
      apiKey: 'al_test',
      endpoint: 'http://localhost',
      timeout: 10,
      maxRetries: 3,
    })
    session._fetchFn = mockFetch
  })

  it('span() creates SpanContext', () => {
    const ctx = session.span('test_op', 'llm')
    expect(ctx).toBeInstanceOf(SpanContext)
  })

  it('flush() sends correct payload shape', async () => {
    // Create and finish a span
    await session.span('test_op', 'llm').run(async (span) => {
      span.model = 'gpt-4o'
      span.input = { prompt: 'hello' }
      span.output = { text: 'world' }
    })

    await session.flush()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost/api/ingest')
    expect(options.method).toBe('POST')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(options.headers['Authorization']).toBe('Bearer al_test')

    const body = JSON.parse(options.body)
    expect(body.session_name).toBe('Test Session')
    expect(body.spans).toHaveLength(1)
    expect(body.spans[0].name).toBe('test_op')
    expect(body.spans[0].span_type).toBe('llm')
    expect(body.spans[0].model).toBe('gpt-4o')
    expect(body.spans[0].status).toBe('ok')
    expect(body.spans[0].input).toEqual({ prompt: 'hello' })
    expect(body.spans[0].output).toEqual({ text: 'world' })
    expect(body.spans[0].client_span_id).toBeDefined()
    expect(body.spans[0].started_at).toBeDefined()
    expect(body.spans[0].ended_at).toBeDefined()
    expect(body.spans[0].duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('flush() skips if no spans', async () => {
    await session.flush()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('retries on 5xx server error', async () => {
    let callCount = 0
    mockFetch.mockImplementation(async () => {
      callCount++
      if (callCount < 3) {
        return { ok: false, status: 500, text: async () => 'Server Error' }
      }
      return { ok: true, text: async () => '{}' }
    })

    // Add a span so flush actually sends
    await session.span('op', 'tool').run(async () => {})
    await session.flush()

    expect(callCount).toBe(3)
  })

  it('does not retry on 4xx client error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    })

    await session.span('op', 'tool').run(async () => {})

    await expect(session.flush()).rejects.toThrow('AgentDecode API error 400')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('timeout aborts request', async () => {
    // Create a session with very short timeout
    const shortSession = new Session({
      sessionName: 'Timeout Test',
      apiKey: 'al_test',
      endpoint: 'http://localhost',
      timeout: 0.001, // 1ms timeout
      maxRetries: 1,
    })

    // Mock fetch that takes forever
    shortSession._fetchFn = vi.fn().mockImplementation(async (_url, opts) => {
      // Wait for abort signal
      return new Promise((_, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'))
          })
        }
      })
    })

    await shortSession.span('slow_op', 'tool').run(async () => {})

    await expect(shortSession.flush()).rejects.toThrow()
  })

  it('span auto-nests under active span', async () => {
    await session.span('parent', 'agent').run(async (parentSpan) => {
      // Child span should auto-nest
      await session.span('child', 'tool').run(async () => {})
    })

    await session.flush()

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const parentSpan = body.spans.find((s: any) => s.name === 'parent')
    const childSpan = body.spans.find((s: any) => s.name === 'child')

    expect(childSpan.parent_client_span_id).toBe(parentSpan.client_span_id)
  })
})

// ── Span tests ────────────────────────────────────────────────────

describe('Span', () => {
  it('finish() calculates duration_ms', () => {
    const span = new Span('timed_op', 'tool')
    // Small delay
    const data = span.finish()
    expect(data.duration_ms).toBeGreaterThanOrEqual(0)
    expect(typeof data.duration_ms).toBe('number')
  })

  it('finish() sets status=error when error provided', () => {
    const span = new Span('failing_op', 'llm')
    const data = span.finish(new Error('something broke'))
    expect(data.status).toBe('error')
    expect(data.error_message).toBe('something broke')
  })

  it('finish() sets status=error when errorMessage is set', () => {
    const span = new Span('custom_err', 'tool')
    span.errorMessage = 'custom error'
    const data = span.finish()
    expect(data.status).toBe('error')
    expect(data.error_message).toBe('custom error')
  })

  it('finish() sets status=ok when no error', () => {
    const span = new Span('ok_op', 'agent')
    const data = span.finish()
    expect(data.status).toBe('ok')
    expect(data.error_message).toBeUndefined()
  })

  it('sets ended_at timestamp', () => {
    const span = new Span('timed', 'tool')
    const data = span.finish()
    expect(data.ended_at).toBeDefined()
    // Should be valid ISO string
    expect(new Date(data.ended_at!).toISOString()).toBe(data.ended_at)
  })

  it('captures all settable properties', () => {
    const span = new Span('full_op', 'llm')
    span.model = 'gpt-4o'
    span.input = { prompt: 'hello' }
    span.output = { text: 'world' }
    span.inputTokens = 10
    span.outputTokens = 5
    span.costUsd = 0.001
    span.metadata = { env: 'test' }

    const data = span.finish()
    expect(data.model).toBe('gpt-4o')
    expect(data.input).toEqual({ prompt: 'hello' })
    expect(data.output).toEqual({ text: 'world' })
    expect(data.input_tokens).toBe(10)
    expect(data.output_tokens).toBe(5)
    expect(data.cost_usd).toBe(0.001)
    expect(data.metadata).toEqual({ env: 'test' })
  })

  it('preserves parent_client_span_id', () => {
    const parent = new Span('parent', 'agent')
    const child = new Span('child', 'tool', parent.clientSpanId)
    const data = child.finish()
    expect(data.parent_client_span_id).toBe(parent.clientSpanId)
  })

  it('has unique clientSpanId', () => {
    const a = new Span('a', 'tool')
    const b = new Span('b', 'tool')
    expect(a.clientSpanId).not.toBe(b.clientSpanId)
  })
})

// ── LangChain handler tests ──────────────────────────────────────

describe('AgentDecodeCallbackHandler', async () => {
  const { AgentDecodeCallbackHandler } = await import(
    '../src/integrations/langchain'
  )

  it('captures LLM start + end as a span', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}',
    })

    const handler = new AgentDecodeCallbackHandler(agent, 'test_llm')
    handler._fetchFn = mockFetch

    handler.handleLLMStart({ name: 'gpt-4o' }, ['What is 2+2?'], 'run-1')
    handler.handleLLMEnd(
      {
        generations: [[{ text: '4' }]],
        llmOutput: { token_usage: { prompt_tokens: 10, completion_tokens: 5 } },
      },
      'run-1',
    )

    await handler.flush()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.session_name).toBe('test_llm')
    expect(body.spans).toHaveLength(1)
    expect(body.spans[0].span_type).toBe('llm')
    expect(body.spans[0].model).toBe('gpt-4o')
    expect(body.spans[0].output).toEqual({ text: '4' })
  })

  it('captures LLM error', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}',
    })

    const handler = new AgentDecodeCallbackHandler(agent, 'test_err')
    handler._fetchFn = mockFetch

    handler.handleLLMStart({ name: 'gpt-4o' }, ['test'], 'run-err')
    handler.handleLLMError(new Error('API key invalid'), 'run-err')

    await handler.flush()

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.spans[0].status).toBe('error')
    expect(body.spans[0].error_message).toBe('API key invalid')
  })

  it('captures tool start + end', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}',
    })

    const handler = new AgentDecodeCallbackHandler(agent, 'test_tool')
    handler._fetchFn = mockFetch

    handler.handleToolStart({ name: 'search' }, 'find docs', 'tool-1')
    handler.handleToolEnd('Found 3 docs', 'tool-1')

    await handler.flush()

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.spans[0].name).toBe('tool.search')
    expect(body.spans[0].span_type).toBe('tool')
    expect(body.spans[0].input).toEqual({ input: 'find docs' })
    expect(body.spans[0].output).toEqual({ output: 'Found 3 docs' })
  })

  it('flush skips when no spans', async () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    const mockFetch = vi.fn()
    const handler = new AgentDecodeCallbackHandler(agent, 'empty')
    handler._fetchFn = mockFetch

    await handler.flush()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ── OpenAI instrumentation tests ──────────────────────────────────

describe('instrumentOpenAI', async () => {
  const { instrumentOpenAI } = await import('../src/integrations/openai')

  it('throws on invalid client', () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    expect(() => instrumentOpenAI(agent, {})).toThrow('Invalid OpenAI client')
    expect(() => instrumentOpenAI(agent, null)).toThrow('Invalid OpenAI client')
  })

  it('patches create and returns cleanup', () => {
    const agent = new AgentDecode({
      apiKey: 'al_test',
      endpoint: 'http://localhost',
    })

    const originalCreate = vi.fn()
    const mockClient = {
      chat: {
        completions: {
          create: originalCreate,
        },
      },
    }

    const cleanup = instrumentOpenAI(agent, mockClient)
    expect(typeof cleanup).toBe('function')

    // create should be replaced (it's a different function now)
    expect(mockClient.chat.completions.create).not.toBe(originalCreate)

    // After cleanup, create should be callable without the wrapper
    cleanup()
    // The restored function is the bound version of originalCreate
    // Verify it's no longer the patched version by calling it
    mockClient.chat.completions.create()
    expect(originalCreate).toHaveBeenCalled()
  })
})
