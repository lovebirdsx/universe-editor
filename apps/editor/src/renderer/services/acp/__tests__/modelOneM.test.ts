import { describe, expect, it } from 'vitest'
import { hasOneM, withOneM } from '../modelOneM.js'

describe('modelOneM', () => {
  describe('hasOneM', () => {
    it('detects the lowercase suffix', () => {
      expect(hasOneM('claude-opus-5[1m]')).toBe(true)
    })

    it('detects the uppercase suffix case-insensitively', () => {
      expect(hasOneM('claude-opus-5[1M]')).toBe(true)
    })

    it('trims surrounding whitespace before judging', () => {
      expect(hasOneM('  claude-opus-5[1m]  ')).toBe(true)
    })

    it('rejects a suffix that is not at the end', () => {
      expect(hasOneM('claude-opus-5[1m]-fast')).toBe(false)
    })

    it('rejects a bare id', () => {
      expect(hasOneM('claude-opus-5')).toBe(false)
    })
  })

  describe('withOneM', () => {
    it('appends the suffix when enabled', () => {
      expect(withOneM('claude-opus-5', true)).toBe('claude-opus-5[1m]')
    })

    it('returns the bare id unchanged when disabled', () => {
      expect(withOneM('claude-opus-5', false)).toBe('claude-opus-5')
    })

    it('does not strip an existing suffix when disabled', () => {
      expect(withOneM('claude-opus-5[1m]', false)).toBe('claude-opus-5[1m]')
    })

    it('does not double-append when the suffix is already present', () => {
      expect(withOneM('claude-opus-5[1m]', true)).toBe('claude-opus-5[1m]')
      expect(withOneM('claude-opus-5[1M]', true)).toBe('claude-opus-5[1M]')
    })

    it('returns empty / whitespace-only input unchanged', () => {
      expect(withOneM('', true)).toBe('')
      expect(withOneM('   ', true)).toBe('   ')
    })
  })
})
