/*---------------------------------------------------------------------------------------------
 *  Tests for monacoLogLanguage.ts
 *  Only tests the exported regex rules — no Monaco runtime required.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { LOG_LEVEL_RULES } from '../monacoLogLanguage.js'

function findRule(line: string): string | null {
  for (const [re, token] of LOG_LEVEL_RULES) {
    if (re.test(line)) {
      // Reset lastIndex for global flags (none here, but be safe)
      re.lastIndex = 0
      return token
    }
  }
  return null
}

describe('LOG_LEVEL_RULES', () => {
  describe('error level', () => {
    it.each([
      '2026-01-01T00:00:00Z [error] something went wrong',
      '2026-01-01T00:00:00Z [Error] uppercase',
      '2026-01-01T00:00:00Z [ERROR] all-caps',
      '2026-01-01T00:00:00Z [err] short form',
      '2026-01-01T00:00:00Z [critical] critical message',
      '2026-01-01T00:00:00Z [fatal] fatal crash',
      '2026-01-01T00:00:00Z [alert] alert level',
      '2026-01-01T00:00:00Z [failure] build failure',
    ])('detects error level: %s', (line) => {
      expect(findRule(line)).toBe('log.error')
    })
  })

  describe('warning level', () => {
    it.each([
      '2026-01-01T00:00:00Z [warn] a warning',
      '2026-01-01T00:00:00Z [warning] full word',
      '2026-01-01T00:00:00Z [WARN] uppercase',
      '2026-01-01T00:00:00Z [WARNING] uppercase full',
      '2026-01-01T00:00:00Z [WW] short form',
    ])('detects warning level: %s', (line) => {
      expect(findRule(line)).toBe('log.warning')
    })
  })

  describe('info level', () => {
    it.each([
      '2026-01-01T00:00:00Z [info] info message',
      '2026-01-01T00:00:00Z [INFO] caps',
      '2026-01-01T00:00:00Z [information] long form',
      '2026-01-01T00:00:00Z [notice] notice level',
      '2026-01-01T00:00:00Z [ii] short form',
    ])('detects info level: %s', (line) => {
      expect(findRule(line)).toBe('log.info')
    })
  })

  describe('debug level', () => {
    it.each([
      '2026-01-01T00:00:00Z [debug] debug message',
      '2026-01-01T00:00:00Z [DEBUG] caps',
      '2026-01-01T00:00:00Z [dbug] short',
      '2026-01-01T00:00:00Z [dbg] shorter',
      '2026-01-01T00:00:00Z [de] very short',
      '2026-01-01T00:00:00Z [d] single char',
    ])('detects debug level: %s', (line) => {
      expect(findRule(line)).toBe('log.debug')
    })
  })

  describe('trace level', () => {
    it.each([
      '2026-01-01T00:00:00Z [trace] trace message',
      '2026-01-01T00:00:00Z [TRACE] caps',
      '2026-01-01T00:00:00Z [verbose] verbose form',
      '2026-01-01T00:00:00Z [verb] short',
      '2026-01-01T00:00:00Z [vrb] shorter',
      '2026-01-01T00:00:00Z [vb] two chars',
      '2026-01-01T00:00:00Z [v] single char',
    ])('detects trace level: %s', (line) => {
      expect(findRule(line)).toBe('log.trace')
    })
  })

  describe('timestamp', () => {
    it('detects ISO-8601 timestamp', () => {
      expect(findRule('2026-05-21T14:30:00 some message')).toBe('log.date')
    })

    it('does not match plain text without timestamp or level', () => {
      expect(findRule('This is plain text without any brackets')).toBeNull()
    })
  })

  describe('priority ordering', () => {
    it('error takes priority over other tokens on the same line', () => {
      // error > warning — if somehow both appeared (contrived), error wins
      expect(findRule('[error] and [warn] both present')).toBe('log.error')
    })

    it('[Log truncated …] system line is not mis-classified', () => {
      expect(findRule('[Log truncated to last 1 MB]')).toBeNull()
    })
  })
})
