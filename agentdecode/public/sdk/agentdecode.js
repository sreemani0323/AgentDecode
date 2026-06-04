/**
 * AgentDecode SDK — Standalone Edition
 * 
 * Zero-dependency JavaScript SDK for AgentDecode observability.
 * Works in Browser, Node.js 18+, Deno, Bun, and any JS runtime with fetch().
 *
 * Usage:
 *   import { AgentDecode } from './agentdecode.js'
 *   // or: const { AgentDecode } = require('./agentdecode.js')
 *
 *   const lens = new AgentDecode({
 *     apiKey: 'al_sk_...',
 *     endpoint: 'https://your-app.vercel.app/api/ingest',
 *     projectName: 'my-agent',
 *   })
 *
 *   const span = lens.startSpan('llm.call', { spanType: 'llm', model: 'gpt-4o' })
 *   // ... do work ...
 *   span.end({ output: result, inputTokens: 100, outputTokens: 50 })
 *
 *   await lens.flush()  // Send all collected spans to AgentDecode
 */

;(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else if (typeof define === 'function' && define.amd) {
    define(factory)
  } else {
    root.AgentDecode = factory().AgentDecode
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  class SpanHandle {
    constructor(span, lens) {
      this._span = span
      this._lens = lens
    }

    end(data) {
      data = data || {}
      this._span.ended_at = new Date().toISOString()
      this._span.duration_ms = new Date(this._span.ended_at).getTime() - new Date(this._span.started_at).getTime()
      this._span.status = data.status || (data.error ? 'error' : 'ok')
      if (data.output !== undefined) this._span.output = data.output
      if (data.error) this._span.error_message = String(data.error)
      if (data.inputTokens) this._span.input_tokens = data.inputTokens
      if (data.outputTokens) this._span.output_tokens = data.outputTokens
      if (data.costUsd) this._span.cost_usd = data.costUsd
      if (data.model) this._span.model = data.model
      if (data.metadata) this._span.metadata = Object.assign(this._span.metadata || {}, data.metadata)
    }

    setError(error) {
      this._span.status = 'error'
      this._span.error_message = String(error)
      if (!this._span.ended_at) {
        this._span.ended_at = new Date().toISOString()
        this._span.duration_ms = new Date(this._span.ended_at).getTime() - new Date(this._span.started_at).getTime()
      }
    }
  }

  class AgentDecode {
    constructor(options) {
      if (!options || !options.apiKey) {
        throw new Error('AgentDecode: apiKey is required')
      }
      if (!options.endpoint) {
        throw new Error('AgentDecode: endpoint is required (e.g. https://your-app.vercel.app/api/ingest)')
      }
      this._apiKey = options.apiKey
      this._endpoint = options.endpoint.replace(/\/$/, '')
      this._sessionName = options.sessionName || options.projectName || 'default'
      this._sessionId = options.sessionId || null
      this._spans = []
      this._autoFlush = options.autoFlush !== false
      this._flushIntervalMs = options.flushIntervalMs || 5000
      this._maxBatchSize = options.maxBatchSize || 50
      this._debug = options.debug || false
      this._timer = null

      if (this._autoFlush && typeof setInterval !== 'undefined') {
        this._timer = setInterval(() => {
          if (this._spans.length > 0) this.flush().catch(() => {})
        }, this._flushIntervalMs)
        // Don't prevent process from exiting in Node.js
        if (this._timer && typeof this._timer.unref === 'function') {
          this._timer.unref()
        }
      }
    }

    startSpan(name, options) {
      options = options || {}
      var span = {
        name: name,
        span_type: options.spanType || options.span_type || 'chain',
        status: 'running',
        started_at: new Date().toISOString(),
        ended_at: null,
        duration_ms: null,
        model: options.model || null,
        input: options.input || null,
        output: null,
        error_message: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        metadata: options.metadata || {},
        parent_span_id: options.parentSpanId || null,
      }
      this._spans.push(span)
      return new SpanHandle(span, this)
    }

    async trace(name, fn, options) {
      var handle = this.startSpan(name, options)
      try {
        var result = await fn(handle)
        if (!handle._span.ended_at) {
          handle.end({ output: result })
        }
        return result
      } catch (err) {
        handle.setError(err)
        throw err
      }
    }

    async flush() {
      if (this._spans.length === 0) return { ok: true, spans_flushed: 0 }

      var batch = this._spans.splice(0, this._maxBatchSize)
      
      // Ensure all spans have ended
      var now = new Date().toISOString()
      batch.forEach(function (span) {
        if (!span.ended_at) {
          span.ended_at = now
          span.status = span.status === 'running' ? 'ok' : span.status
          span.duration_ms = new Date(span.ended_at).getTime() - new Date(span.started_at).getTime()
        }
      })

      var payload = {
        session_name: this._sessionName,
        spans: batch,
      }
      if (this._sessionId) {
        payload.session_id = this._sessionId
      }

      if (this._debug) {
        console.log('[AgentDecode] Flushing', batch.length, 'spans')
      }

      try {
        var response = await fetch(this._endpoint, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + this._apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })

        if (!response.ok) {
          var errText = await response.text()
          if (this._debug) console.error('[AgentDecode] Flush failed:', response.status, errText)
          // Put spans back for retry
          this._spans = batch.concat(this._spans)
          return { ok: false, error: errText }
        }

        var data = await response.json()
        if (data.session_id && !this._sessionId) {
          this._sessionId = data.session_id
        }
        return { ok: true, spans_flushed: batch.length, session_id: data.session_id }
      } catch (err) {
        if (this._debug) console.error('[AgentDecode] Flush error:', err)
        this._spans = batch.concat(this._spans)
        return { ok: false, error: String(err) }
      }
    }

    async shutdown() {
      if (this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
      return this.flush()
    }

    get pendingSpans() {
      return this._spans.length
    }
  }

  return { AgentDecode: AgentDecode, SpanHandle: SpanHandle }
})
