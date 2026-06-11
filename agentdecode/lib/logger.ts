/**
 * Lightweight structured logger for AgentDecode.
 *
 * Works in both Node.js and Edge Runtime (no Node.js-specific APIs).
 * Each log outputs a JSON line: { timestamp, level, message, ...context }
 *
 * @example
 * ```ts
 * import { logger } from '@/lib/logger'
 * logger.info('Request processed', { route: '/api/ingest', duration: 42 })
 * logger.error('Failed to insert spans', error, { sessionId: '123' })
 * ```
 */

/** Supported log levels in ascending severity order. */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

type LogLevel = (typeof LOG_LEVELS)[number]

/** Arbitrary key-value context attached to a log entry. */
type LogContext = Record<string, unknown>

/** Shape of each JSON log line emitted. */
interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  [key: string]: unknown
}

/**
 * Resolve the effective minimum log level from the environment.
 *
 * - Reads `LOG_LEVEL` env var (case-insensitive).
 * - Falls back to `'info'` in production, `'debug'` otherwise.
 */
function resolveLogLevel(): LogLevel {
  const raw = (
    typeof process !== 'undefined' ? process.env?.LOG_LEVEL : undefined
  )
    ?.toLowerCase()
    ?.trim() as LogLevel | undefined

  if (raw && LOG_LEVELS.includes(raw)) {
    return raw
  }

  const isProd =
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV === 'production'

  return isProd ? 'info' : 'debug'
}

/**
 * Return `true` if a message at `level` should be emitted given the
 * current minimum `minLevel`.
 */
function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minLevel)
}

/**
 * Write a structured JSON log line to the appropriate console stream.
 */
function emit(level: LogLevel, entry: LogEntry): void {
  const line = JSON.stringify(entry)

  switch (level) {
    case 'debug':
      console.debug(line)
      break
    case 'info':
      console.info(line)
      break
    case 'warn':
      console.warn(line)
      break
    case 'error':
      console.error(line)
      break
  }
}

/**
 * Build and emit a log entry.
 */
function log(
  level: LogLevel,
  minLevel: LogLevel,
  message: string,
  context?: LogContext,
): void {
  if (!shouldLog(level, minLevel)) return

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  }

  emit(level, entry)
}

/**
 * Extract useful context from an `Error` object.
 */
function errorToContext(err: Error): LogContext {
  return {
    error_message: err.message,
    error_name: err.name,
    ...(err.stack ? { error_stack: err.stack } : {}),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Structured logger singleton.
 *
 * Methods:
 * - `debug(msg, ctx?)` – verbose development-only messages
 * - `info(msg, ctx?)`  – standard operational messages
 * - `warn(msg, ctx?)`  – potential issues worth investigating
 * - `error(msg, errorOrCtx?, ctx?)` – failures requiring attention
 */
export const logger = (() => {
  const minLevel = resolveLogLevel()

  return {
    /**
     * Log a debug-level message.
     * @param message - Human-readable description of what happened.
     * @param context - Optional structured key-value pairs.
     */
    debug(message: string, context?: LogContext): void {
      log('debug', minLevel, message, context)
    },

    /**
     * Log an info-level message.
     * @param message - Human-readable description of what happened.
     * @param context - Optional structured key-value pairs.
     */
    info(message: string, context?: LogContext): void {
      log('info', minLevel, message, context)
    },

    /**
     * Log a warn-level message.
     * @param message - Human-readable description of what happened.
     * @param context - Optional structured key-value pairs.
     */
    warn(message: string, context?: LogContext): void {
      log('warn', minLevel, message, context)
    },

    /**
     * Log an error-level message.
     *
     * Accepts an optional `Error` object as the second argument; its
     * `message`, `name`, and `stack` will be merged into the log entry.
     *
     * @param message     - Human-readable description of what went wrong.
     * @param errorOrCtx  - An `Error` instance or a context object.
     * @param context     - Additional context (used when `errorOrCtx` is an Error).
     */
    error(
      message: string,
      errorOrCtx?: Error | LogContext,
      context?: LogContext,
    ): void {
      let merged: LogContext = {}

      if (errorOrCtx instanceof Error) {
        merged = { ...errorToContext(errorOrCtx), ...context }
      } else if (errorOrCtx) {
        merged = { ...errorOrCtx, ...context }
      } else if (context) {
        merged = context
      }

      log('error', minLevel, message, merged)
    },
  }
})()
