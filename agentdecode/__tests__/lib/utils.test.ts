import { describe, test, expect } from 'vitest'
import {
  cn,
  generateApiKey,
  hashApiKey,
  formatDuration,
  formatCost,
  formatTokens,
  getSpanTypeColor,
  getStatusColor,
  getStatusBgColor
} from '@/lib/utils'

describe('utils', () => {
  describe('cn', () => {
    test('merges class names correctly', () => {
      expect(cn('bg-red-500', 'text-white')).toBe('bg-red-500 text-white')
      expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500')
      expect(cn('px-2 py-1', 'p-3')).toBe('p-3')
      expect(cn('text-red-500', null, undefined, false && 'hidden', 'text-blue-500')).toBe('text-blue-500')
    })
  })

  describe('generateApiKey', () => {
    test('generates an API key with correct format', () => {
      const apiKey = generateApiKey()
      expect(apiKey.startsWith('al_')).toBe(true)
      // prefix 'al_' + 16 bytes in hex (32 characters)
      expect(apiKey).toHaveLength(3 + 32)
      expect(apiKey.slice(3)).toMatch(/^[0-9a-f]{32}$/)
    })

    test('generates unique keys', () => {
      const key1 = generateApiKey()
      const key2 = generateApiKey()
      expect(key1).not.toBe(key2)
    })
  })

  describe('hashApiKey', () => {
    test('hashes API key consistently', async () => {
      const key = 'al_testkey123'
      const hash1 = await hashApiKey(key)
      const hash2 = await hashApiKey(key)
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[0-9a-f]{64}$/) // SHA-256 is 64 hex characters
    })

    test('hashes different keys to different values', async () => {
      const hash1 = await hashApiKey('al_key1')
      const hash2 = await hashApiKey('al_key2')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('formatDuration', () => {
    test('formats ms under 1000ms', () => {
      expect(formatDuration(0)).toBe('0ms')
      expect(formatDuration(500)).toBe('500ms')
      expect(formatDuration(999)).toBe('999ms')
    })

    test('formats ms under 60000ms', () => {
      expect(formatDuration(1000)).toBe('1.0s')
      expect(formatDuration(1500)).toBe('1.5s')
      expect(formatDuration(59900)).toBe('59.9s')
    })

    test('formats ms 60000ms and above', () => {
      expect(formatDuration(60000)).toBe('1m 0s')
      expect(formatDuration(61500)).toBe('1m 1s')
      expect(formatDuration(125000)).toBe('2m 5s')
    })
  })

  describe('formatCost', () => {
    test('formats small positive costs', () => {
      expect(formatCost(0.00005)).toBe('<$0.0001')
      expect(formatCost(0.000099)).toBe('<$0.0001')
    })

    test('formats zero cost', () => {
      expect(formatCost(0)).toBe('$0.0000')
    })

    test('formats larger costs', () => {
      expect(formatCost(0.0001)).toBe('$0.0001')
      expect(formatCost(0.12345)).toBe('$0.1235')
      expect(formatCost(1.2)).toBe('$1.2000')
    })
  })

  describe('formatTokens', () => {
    test('formats tokens under 1000', () => {
      expect(formatTokens(0)).toBe('0')
      expect(formatTokens(999)).toBe('999')
    })

    test('formats tokens between 1000 and 1000000', () => {
      expect(formatTokens(1000)).toBe('1.0K')
      expect(formatTokens(1500)).toBe('1.5K')
      expect(formatTokens(999999)).toBe('1000.0K') // Note: boundary behavior in float calculation
    })

    test('formats tokens 1000000 and above', () => {
      expect(formatTokens(1000000)).toBe('1.0M')
      expect(formatTokens(2500000)).toBe('2.5M')
    })
  })

  describe('getSpanTypeColor', () => {
    test('returns correct Tailwind color classes', () => {
      expect(getSpanTypeColor('llm')).toBe('bg-purple-500')
      expect(getSpanTypeColor('tool')).toBe('bg-blue-500')
      expect(getSpanTypeColor('retrieval')).toBe('bg-green-500')
      expect(getSpanTypeColor('chain')).toBe('bg-yellow-500')
      expect(getSpanTypeColor('agent')).toBe('bg-orange-500')
      expect(getSpanTypeColor('unknown')).toBe('bg-gray-500')
    })
  })

  describe('getStatusColor', () => {
    test('returns correct text color classes', () => {
      expect(getStatusColor('ok')).toBe('text-green-400')
      expect(getStatusColor('success')).toBe('text-green-400')
      expect(getStatusColor('error')).toBe('text-red-400')
      expect(getStatusColor('running')).toBe('text-yellow-400')
      expect(getStatusColor('other')).toBe('text-gray-400')
    })
  })

  describe('getStatusBgColor', () => {
    test('returns correct background and border classes', () => {
      expect(getStatusBgColor('ok')).toBe('bg-green-500/10 text-green-400 border-green-500/20')
      expect(getStatusBgColor('success')).toBe('bg-green-500/10 text-green-400 border-green-500/20')
      expect(getStatusBgColor('error')).toBe('bg-red-500/10 text-red-400 border-red-500/20')
      expect(getStatusBgColor('running')).toBe('bg-yellow-500/10 text-yellow-400 border-yellow-500/20')
      expect(getStatusBgColor('other')).toBe('bg-gray-500/10 text-gray-400 border-gray-500/20')
    })
  })
})
