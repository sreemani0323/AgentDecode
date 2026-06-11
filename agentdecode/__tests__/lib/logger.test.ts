import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

describe('logger', () => {
  let consoleDebugSpy: any
  let consoleInfoSpy: any
  let consoleWarnSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    vi.resetModules()

    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('emits json formatted output to console', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug')
    const { logger } = await import('@/lib/logger')

    logger.info('Test info message', { userId: '123' })

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    const logLine = consoleInfoSpy.mock.calls[0][0]
    expect(() => JSON.parse(logLine)).not.toThrow()

    const parsed = JSON.parse(logLine)
    expect(parsed.level).toBe('info')
    expect(parsed.message).toBe('Test info message')
    expect(parsed.userId).toBe('123')
    expect(parsed.timestamp).toBeDefined()
    expect(new Date(parsed.timestamp).getTime()).not.toBeNaN()
  })

  test('emits debug logs and other levels when LOG_LEVEL is debug', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug')
    const { logger } = await import('@/lib/logger')

    logger.debug('debug msg')
    logger.info('info msg')
    logger.warn('warn msg')
    logger.error('error msg')

    expect(consoleDebugSpy).toHaveBeenCalledTimes(1)
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  test('filters debug logs when LOG_LEVEL is info', async () => {
    vi.stubEnv('LOG_LEVEL', 'info')
    const { logger } = await import('@/lib/logger')

    logger.debug('debug msg')
    logger.info('info msg')

    expect(consoleDebugSpy).not.toHaveBeenCalled()
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
  })

  test('filters debug, info, warn when LOG_LEVEL is error', async () => {
    vi.stubEnv('LOG_LEVEL', 'error')
    const { logger } = await import('@/lib/logger')

    logger.debug('debug msg')
    logger.info('info msg')
    logger.warn('warn msg')
    logger.error('error msg')

    expect(consoleDebugSpy).not.toHaveBeenCalled()
    expect(consoleInfoSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  test('falls back to debug in non-production when no LOG_LEVEL is set', async () => {
    vi.stubEnv('LOG_LEVEL', '')
    vi.stubEnv('NODE_ENV', 'development')
    const { logger } = await import('@/lib/logger')

    logger.debug('dev debug')
    expect(consoleDebugSpy).toHaveBeenCalledTimes(1)
  })

  test('falls back to info in production when no LOG_LEVEL is set', async () => {
    vi.stubEnv('LOG_LEVEL', '')
    vi.stubEnv('NODE_ENV', 'production')
    const { logger } = await import('@/lib/logger')

    logger.debug('prod debug')
    logger.info('prod info')

    expect(consoleDebugSpy).not.toHaveBeenCalled()
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
  })

  test('merges standard context parameters correctly', async () => {
    vi.stubEnv('LOG_LEVEL', 'info')
    const { logger } = await import('@/lib/logger')

    logger.info('msg', { foo: 'bar', nested: { val: 1 } })
    const parsed = JSON.parse(consoleInfoSpy.mock.calls[0][0])
    expect(parsed.foo).toBe('bar')
    expect(parsed.nested).toEqual({ val: 1 })
  })

  describe('error logging context merging', () => {
    test('merges Error object and context correctly', async () => {
      vi.stubEnv('LOG_LEVEL', 'error')
      const { logger } = await import('@/lib/logger')

      const err = new Error('Database connection failed')
      err.name = 'CustomDbError'
      logger.error('Failed to query database', err, { attempts: 3 })

      const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
      expect(parsed.level).toBe('error')
      expect(parsed.message).toBe('Failed to query database')
      expect(parsed.error_message).toBe('Database connection failed')
      expect(parsed.error_name).toBe('CustomDbError')
      expect(parsed.error_stack).toBeDefined()
      expect(parsed.attempts).toBe(3)
    })

    test('handles error logging with just context object', async () => {
      vi.stubEnv('LOG_LEVEL', 'error')
      const { logger } = await import('@/lib/logger')

      logger.error('Simple context failure', { code: '500', service: 'auth' })

      const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
      expect(parsed.code).toBe('500')
      expect(parsed.service).toBe('auth')
      expect(parsed.error_message).toBeUndefined()
    })

    test('handles error logging with just Error object', async () => {
      vi.stubEnv('LOG_LEVEL', 'error')
      const { logger } = await import('@/lib/logger')

      const err = new Error('Only error')
      logger.error('Only error failure', err)

      const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
      expect(parsed.error_message).toBe('Only error')
      expect(parsed.error_name).toBe('Error')
      expect(parsed.error_stack).toBeDefined()
    })

    test('handles error logging with no error and no context', async () => {
      vi.stubEnv('LOG_LEVEL', 'error')
      const { logger } = await import('@/lib/logger')

      logger.error('No extra details failure')

      const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
      expect(parsed.level).toBe('error')
      expect(parsed.message).toBe('No extra details failure')
      expect(parsed.error_message).toBeUndefined()
    })
  })
})
