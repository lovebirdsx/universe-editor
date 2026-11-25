import { describe, expect, it } from 'vitest'
import { normalizeIconReference, parseIconReference } from '../iconReference.js'

describe('parseIconReference', () => {
  it('parses bare and $-wrapped ids', () => {
    expect(parseIconReference('files')).toEqual({ id: 'files' })
    expect(parseIconReference('$(files)')).toEqual({ id: 'files' })
  })

  it('keeps the optional modifier', () => {
    expect(parseIconReference('$(sync~spin)')).toEqual({ id: 'sync', modifier: 'spin' })
    expect(parseIconReference('sync~spin')).toEqual({ id: 'sync', modifier: 'spin' })
  })

  it('rejects paths, partial wrappers and illegal characters', () => {
    for (const value of [
      '',
      './icon.svg',
      '/abs/icon.svg',
      'C:/icons/a.svg',
      '$(files',
      'files)',
      'my_icon',
      'a.b',
      '$(a b)',
    ]) {
      expect(parseIconReference(value), value).toBeUndefined()
    }
  })
})

describe('normalizeIconReference', () => {
  it('strips the wrapper and preserves modifiers', () => {
    expect(normalizeIconReference('$(files)')).toBe('files')
    expect(normalizeIconReference('$(sync~spin)')).toBe('sync~spin')
    expect(normalizeIconReference('sync~spin')).toBe('sync~spin')
  })

  it('returns unrecognised values untouched', () => {
    expect(normalizeIconReference('./icon.svg')).toBe('./icon.svg')
  })
})
