/*
 * AgentDecode Landing Page
 * Accent: Deep Teal (#197066) — chosen for trust/precision, fitting a B2B observability tool
 * Fonts: Satoshi (Fontshare, body) + Syne (Google Fonts, display headings)
 * Rationale: Satoshi's geometric warmth avoids Inter's ubiquity; Syne's unusual letterforms
 *   at large sizes read as a deliberate choice, creating contrast without chaos.
 * Design decisions:
 *   - Mock dashboard in hero shows real product UI, not stock imagery
 *   - Code snippet in showcase section demonstrates the 2-line setup promise
 *   - Eval scoring panel in second showcase proves the quality monitoring claim
 *   - Light theme throughout (dark is only inside product mock frames)
 */

"use client"

import { useEffect, useState, useRef, useCallback } from 'react'
import Link from 'next/link'
import './landing.css'

export default function LandingPage() {
  const [loaded, setLoaded] = useState(false)
  const [navScrolled, setNavScrolled] = useState(false)
  const progressRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Font load delay — avoids FOUT during reveal
    const timer = setTimeout(() => setLoaded(true), 80)

    // Nav border on scroll
    const handleScroll = () => {
      setNavScrolled(window.scrollY > 80)

      // Progress bar
      if (progressRef.current) {
        const pct = window.scrollY / (document.body.scrollHeight - window.innerHeight) * 100
        progressRef.current.style.width = pct + '%'
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })

    // IntersectionObserver for scroll reveals
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    )

    document.querySelectorAll('.scroll-reveal').forEach((el) => {
      observer.observe(el)
    })

    // Start hero float after load transition completes
    const floatTimer = setTimeout(() => {
      const visual = document.querySelector('.hero-visual')
      if (visual) visual.classList.add('float-active')
    }, 1100)

    return () => {
      clearTimeout(timer)
      clearTimeout(floatTimer)
      window.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }
  }, [])

  return (
    <div className={`landing-page ${loaded ? 'lp-loaded' : ''}`}>
      {/* Font links */}
      <link
        rel="preconnect"
        href="https://api.fontshare.com"
        crossOrigin="anonymous"
      />
      <link
        href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&f[]=clash-display@400,700&display=swap"
        rel="stylesheet"
      />

      {/* Scroll progress bar */}
      <div className="lp-progress-bar" ref={progressRef} />

      {/* ═══ NAVIGATION ═══ */}
      <nav className={`lp-nav ${navScrolled ? 'nav-scrolled' : ''}`}>
        <Link href="/" className="lp-nav-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
          </svg>
          AgentDecode
        </Link>

        <div className="lp-nav-right">
          <ul className="lp-nav-links">
            <li><Link href="#features">Features</Link></li>
            <li><Link href="#how-it-works">How it works</Link></li>
            <li><a href="https://github.com/agentdecode" target="_blank" rel="noopener noreferrer">GitHub</a></li>
          </ul>
          <Link href="/login" className="lp-nav-login">Log in</Link>
          <Link href="/signup" className="lp-btn-primary">Get started free</Link>
        </div>
      </nav>

      <main>
        {/* ═══ HERO ═══ */}
        <section className="lp-hero" aria-label="Introduction">
          <div className="hero-copy">
            <div className="hero-eyebrow">
              <span className="reveal-clip">
                <span className="reveal-inner" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <span className="eyebrow-dot" />
                  Now open source
                </span>
              </span>
            </div>

            <h1 className="hero-headline">
              <span className="reveal-clip">
                <span className="reveal-inner">
                  See every step your AI agents take
                </span>
              </span>
            </h1>

            <p className="hero-sub">
              <span className="reveal-clip">
                <span className="reveal-inner">
                  Trace sessions, catch silent failures, and score LLM quality automatically — with a simple HTTP API.
                </span>
              </span>
            </p>

            <div className="hero-actions">
              <span className="reveal-clip">
                <span className="reveal-inner" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <Link href="/signup" className="lp-btn-primary lp-btn-lg">
                    Start tracing free
                  </Link>
                  <Link href="/dashboard" className="lp-btn-secondary lp-btn-lg">
                    Watch it work
                  </Link>
                </span>
              </span>
            </div>

            <div className="hero-proof">
              <span className="reveal-clip">
                <span className="reveal-inner" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span className="proof-text">Join developers tracing their AI agents with AgentDecode</span>
                </span>
              </span>
            </div>
          </div>

          {/* Hero Visual — Product mock */}
          <div className="hero-visual">
            <div className="mock-bar">
              <div className="mock-dots">
                <span /><span /><span />
              </div>
              <div className="mock-url">localhost:3000/sessions/a92ac8a2</div>
            </div>
            <div className="mock-body">
              <div className="mock-sidebar">
                <div className="mock-sidebar-title">Sessions</div>
                <div className="mock-session-item active">
                  <span className="mock-status-dot red" />
                  Support Agent
                </div>
                <div className="mock-session-item">
                  <span className="mock-status-dot yellow" />
                  RAG Pipeline
                </div>
                <div className="mock-session-item">
                  <span className="mock-status-dot green" />
                  Code Review
                </div>
                <div className="mock-session-item">
                  <span className="mock-status-dot green" />
                  Data Extract
                </div>
              </div>
              <div className="mock-main">
                <div className="mock-main-title">Customer Support Agent</div>
                {/* Span tree */}
                <div className="mock-span">
                  <span className="mock-status-dot green" />
                  <span className="mock-span-name">classify_intent</span>
                  <span className="mock-span-type type-llm">llm</span>
                  <span className="mock-eval-badge good">8.5/10</span>
                  <span className="mock-span-duration">340ms</span>
                </div>
                <div className="mock-span error-span">
                  <span className="mock-indent-line" />
                  <span className="mock-status-dot red" />
                  <span className="mock-span-name error-name">search_knowledge_base</span>
                  <span className="mock-span-type type-tool">tool</span>
                  <span className="mock-error-msg">timeout after 3 retries</span>
                  <span className="mock-span-duration">3.2s</span>
                </div>
                <div className="mock-span">
                  <span className="mock-indent-line" />
                  <span className="mock-status-dot green" />
                  <span className="mock-span-name">generate_response</span>
                  <span className="mock-span-type type-llm">llm</span>
                  <span className="mock-eval-badge warn">5.2/10</span>
                  <span className="mock-span-duration">1.2s</span>
                </div>
                <div className="mock-span">
                  <span className="mock-indent-line" />
                  <span className="mock-status-dot green" />
                  <span className="mock-span-name">send_reply</span>
                  <span className="mock-span-type type-tool">tool</span>
                  <span className="mock-span-duration">89ms</span>
                </div>
              </div>
            </div>
          </div>
        </section>



        {/* ═══ PROBLEM / SOLUTION ═══ */}
        <section className="lp-section">
          <div className="lp-section-narrow">
            <span className="lp-section-label scroll-reveal">The problem</span>
            <h2 className="lp-section-heading scroll-reveal">
              Your agents fail silently. You find out from users.
            </h2>
            <p className="lp-body-text scroll-reveal">
              An LLM returns a plausible-sounding answer that&apos;s completely wrong. A tool call times out
              but the agent continues anyway. A retrieval step finds irrelevant documents and the model
              hallucinates around them. None of these throw exceptions. Your logs say &ldquo;200 OK.&rdquo;
            </p>
            <p className="lp-body-text scroll-reveal">
              AgentDecode records every step your agent takes — every LLM call, tool invocation, and retrieval —
              then scores output quality automatically. When something goes wrong, you see exactly where,
              why, and how often.
            </p>
          </div>
        </section>

        {/* ═══ FEATURES ═══ */}
        <section className="lp-section lp-section-alt" id="features">
          <div className="lp-section-inner">
            <div style={{ textAlign: 'center', maxWidth: 'var(--container-sm)', margin: '0 auto' }}>
              <span className="lp-section-label scroll-reveal">What it does</span>
              <h2 className="lp-section-heading scroll-reveal">
                Everything you need to debug agent pipelines
              </h2>
            </div>

            <div className="lp-features-grid">
              {/* Feature 1 */}
              <div className="lp-feature-card scroll-reveal">
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
                  </svg>
                </div>
                <h3 className="lp-feature-title">Session tracing</h3>
                <p className="lp-feature-desc">
                  See every LLM call, tool use, and retrieval in a hierarchical timeline.
                  Click any span to inspect inputs, outputs, and token counts.
                </p>
              </div>

              {/* Feature 2 */}
              <div className="lp-feature-card scroll-reveal">
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <h3 className="lp-feature-title">Error grouping</h3>
                <p className="lp-feature-desc">
                  Identical errors are automatically fingerprinted and grouped into issues.
                  Track occurrence counts, first-seen dates, and linked spans.
                </p>
              </div>

              {/* Feature 3 */}
              <div className="lp-feature-card scroll-reveal">
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </div>
                <h3 className="lp-feature-title">Eval scoring</h3>
                <p className="lp-feature-desc">
                  Every LLM response is scored for quality by a second model, automatically.
                  Low-quality outputs are flagged before your users notice.
                </p>
              </div>

              {/* Feature 4 */}
              <div className="lp-feature-card scroll-reveal">
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </div>
                <h3 className="lp-feature-title">Alert rules</h3>
                <p className="lp-feature-desc">
                  Set thresholds on error rate, P95 latency, or cost per session.
                  Get notified by email the moment something crosses a line.
                </p>
              </div>

              {/* Feature 5 */}
              <div className="lp-feature-card scroll-reveal">
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                </div>
                <h3 className="lp-feature-title">Simple HTTP API</h3>
                <p className="lp-feature-desc">
                  Send traces from any language using a single REST endpoint.
                  No complex SDKs or infrastructure to manage.
                </p>
              </div>

              {/* Feature 6 */}
              <div className="lp-feature-card scroll-reveal">
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <h3 className="lp-feature-title">Open source</h3>
                <p className="lp-feature-desc">
                  Self-host on your own Supabase instance. Full source on GitHub.
                  Your traces stay on your infrastructure.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ═══ PRODUCT SHOWCASE ═══ */}
        <section className="lp-section" id="how-it-works">
          <div className="lp-section-inner">

            {/* Showcase 1: Setup code */}
            <div className="lp-showcase-row">
              <div className="lp-showcase-text">
                <span className="lp-section-label scroll-reveal">Setup</span>
                <h2 className="lp-section-heading lp-section-heading-sm scroll-reveal">
                  Instrument your agent with a simple POST
                </h2>
                <p className="lp-body-text scroll-reveal">
                  Use your HTTP client of choice to send trace data directly to the ingest API.
                  Every call is recorded with inputs, outputs, duration, and token counts — from any language.
                </p>
              </div>
              <div className="lp-showcase-visual scroll-reveal">
                <div className="mock-bar">
                  <div className="mock-dots"><span /><span /><span /></div>
                  <div className="mock-url">POST /api/ingest</div>
                </div>
                <div className="mock-code-block" style={{ fontSize: '13px' }}>
                  <span className="fn">fetch</span>(<span className="str">'https://agentdecode.dev/api/ingest'</span>, {'{'}<br />
                  &nbsp;&nbsp;method: <span className="str">'POST'</span>,<br />
                  &nbsp;&nbsp;headers: {'{'}<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;<span className="str">'Authorization'</span>: <span className="str">'Bearer al_your_api_key'</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;<span className="str">'Content-Type'</span>: <span className="str">'application/json'</span><br />
                  &nbsp;&nbsp;{'}'},<br />
                  &nbsp;&nbsp;body: <span className="fn">JSON.stringify</span>({'{\n'}
                  &nbsp;&nbsp;&nbsp;&nbsp;projectId: <span className="str">'...'</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;sessionId: <span className="str">'...'</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;spans: [{'{'}<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;name: <span className="str">'generate_response'</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;type: <span className="str">'llm'</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;status: <span className="str">'success'</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;{'}'}]<br />
                  &nbsp;&nbsp;{'}'})<br />
                  {'}'})
                </div>
              </div>
            </div>

            {/* Showcase 2: Eval scoring */}
            <div className="lp-showcase-row reversed">
              <div className="lp-showcase-text">
                <span className="lp-section-label scroll-reveal">Quality monitoring</span>
                <h2 className="lp-section-heading lp-section-heading-sm scroll-reveal">
                  Catch bad outputs before your users do
                </h2>
                <p className="lp-body-text scroll-reveal">
                  Every LLM response is scored from 0–10 by a separate evaluation model.
                  Scores below threshold are flagged as silent failures — the kind that
                  return 200 OK but give your users wrong answers.
                </p>
              </div>
              <div className="lp-showcase-visual scroll-reveal">
                <div className="mock-bar">
                  <div className="mock-dots"><span /><span /><span /></div>
                  <div className="mock-url">Eval Scores — Last 24h</div>
                </div>
                <div className="mock-eval-panel">
                  <div className="mock-eval-row">
                    <span className="mock-eval-name">classify_intent</span>
                    <div className="mock-eval-bar">
                      <div className="mock-eval-bar-fill high" style={{ width: '85%' }} />
                    </div>
                    <span className="mock-eval-score high">8.5</span>
                  </div>
                  <div className="mock-eval-row">
                    <span className="mock-eval-name">generate_response</span>
                    <div className="mock-eval-bar">
                      <div className="mock-eval-bar-fill mid" style={{ width: '52%' }} />
                    </div>
                    <span className="mock-eval-score mid">5.2 ⚠</span>
                  </div>
                  <div className="mock-eval-row">
                    <span className="mock-eval-name">summarize_docs</span>
                    <div className="mock-eval-bar">
                      <div className="mock-eval-bar-fill high" style={{ width: '92%' }} />
                    </div>
                    <span className="mock-eval-score high">9.2</span>
                  </div>
                  <div className="mock-eval-row">
                    <span className="mock-eval-name">extract_entities</span>
                    <div className="mock-eval-bar">
                      <div className="mock-eval-bar-fill low" style={{ width: '28%' }} />
                    </div>
                    <span className="mock-eval-score low">2.8 ✗</span>
                  </div>
                  <div className="mock-eval-row">
                    <span className="mock-eval-name">rewrite_query</span>
                    <div className="mock-eval-bar">
                      <div className="mock-eval-bar-fill high" style={{ width: '78%' }} />
                    </div>
                    <span className="mock-eval-score high">7.8</span>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </section>



        {/* ═══ FINAL CTA ═══ */}
        <section className="lp-final-cta">
          <div className="lp-final-cta-inner scroll-reveal">
            <h2 className="lp-section-heading">
              Start debugging your agents today
            </h2>
            <p className="lp-final-cta-sub">
              Free for individual developers. Set up in under five minutes.
            </p>
            <Link href="/signup" className="lp-btn-primary lp-btn-lg">
              Get started free
            </Link>
          </div>
        </section>
      </main>

      {/* ═══ FOOTER ═══ */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <div className="lp-footer-logo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
              </svg>
              AgentDecode
            </div>
            <p className="lp-footer-desc">
              Open-source observability for AI agents.
              Trace, debug, and monitor your agent pipelines.
            </p>
          </div>

          <div>
            <div className="lp-footer-col-title">Product</div>
            <ul className="lp-footer-links">
              <li><Link href="#features">Features</Link></li>
              <li><Link href="/dashboard">Dashboard</Link></li>
              <li><a href="https://github.com/agentdecode" target="_blank" rel="noopener noreferrer">GitHub</a></li>
            </ul>
          </div>

          <div>
            <div className="lp-footer-col-title">Developers</div>
            <ul className="lp-footer-links">
              <li><Link href="/dashboard/docs">Documentation</Link></li>
              <li><Link href="/dashboard/docs">API Reference</Link></li>
            </ul>
          </div>
        </div>

        <div className="lp-footer-bottom">
          <span className="lp-footer-copyright">&copy; 2026 AgentDecode. All rights reserved.</span>
        </div>
      </footer>
    </div>
  )
}
