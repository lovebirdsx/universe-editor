import { describe, expect, it } from 'vitest'
import {
  filterAndRankSettings,
  parseQuery,
  rankEntry,
  type SettingSearchEntry,
} from '../settingsSearchModel.js'

function entry(
  key: string,
  opts: { description?: string; order?: number; isModified?: boolean } = {},
): SettingSearchEntry {
  return {
    key,
    description: opts.description ?? '',
    order: opts.order ?? 0,
    isModified: opts.isModified ?? false,
  }
}

describe('parseQuery', () => {
  it('parses free text only', () => {
    expect(parseQuery('  Font   Size ')).toEqual({
      modifiedOnly: false,
      idPrefix: undefined,
      text: 'font size',
    })
  })

  it('recognizes @modified case-insensitively', () => {
    const parsed = parseQuery('@Modified font')
    expect(parsed.modifiedOnly).toBe(true)
    expect(parsed.text).toBe('font')
  })

  it('recognizes @id: prefix and strips a trailing wildcard', () => {
    expect(parseQuery('@id:Editor.Font*').idPrefix).toBe('editor.font')
    expect(parseQuery('@id:editor.fontSize').idPrefix).toBe('editor.fontsize')
  })

  it('handles an empty query', () => {
    expect(parseQuery('')).toEqual({ modifiedOnly: false, idPrefix: undefined, text: '' })
  })
})

describe('rankEntry', () => {
  it('ranks exact > prefix > substring > word match', () => {
    const q = parseQuery('editor.fontsize')
    const exact = rankEntry(entry('editor.fontSize'), q)
    const prefix = rankEntry(entry('editor.fontSizeLarger'), q)
    expect(exact).toBeGreaterThan(prefix)

    const q2 = parseQuery('fontsize')
    const sub = rankEntry(entry('editor.fontSize'), q2)
    const word = rankEntry(entry('editor.fontSize'), parseQuery('font size'))
    expect(rankEntry(entry('editor.fontSize'), q2)).toBeGreaterThan(0)
    expect(sub).toBeGreaterThan(word)
  })

  it('falls back to description only when all words hit', () => {
    const e = entry('workbench.colorTheme', { description: 'Controls the colors of the window' })
    expect(rankEntry(e, parseQuery('colors window'))).toBeGreaterThan(0)
    expect(rankEntry(e, parseQuery('colors missing'))).toBe(-1)
  })

  it('returns -1 when nothing matches', () => {
    expect(rankEntry(entry('editor.fontSize'), parseQuery('terminal'))).toBe(-1)
  })

  it('@modified filters out unmodified entries without scoring', () => {
    const q = parseQuery('@modified')
    expect(rankEntry(entry('a.b', { isModified: false }), q)).toBe(-1)
    expect(rankEntry(entry('a.b', { isModified: true }), q)).toBe(0)
  })

  it('@id: requires a key prefix match', () => {
    const q = parseQuery('@id:editor.font')
    expect(rankEntry(entry('editor.fontSize'), q)).toBeGreaterThan(0)
    expect(rankEntry(entry('workbench.fontSize'), q)).toBe(-1)
  })

  it('@id: combines with free text', () => {
    const q = parseQuery('@id:editor ligature')
    expect(rankEntry(entry('editor.fontLigatures'), q)).toBeGreaterThan(0)
    expect(rankEntry(entry('editor.wordWrap'), q)).toBe(-1)
  })

  it('empty text keeps every entry at score 0', () => {
    expect(rankEntry(entry('x.y'), parseQuery(''))).toBe(0)
  })
})

describe('filterAndRankSettings', () => {
  it('sorts by score desc, then registration order', () => {
    const entries = [
      entry('editor.wordWrap', { order: 0 }),
      entry('editor.fontSize', { order: 1 }),
      entry('editor.fontSizeLarger', { order: 2 }),
    ]
    const ranked = filterAndRankSettings(entries, parseQuery('editor.fontsize'))
    expect(ranked.map((r) => r.key)).toEqual(['editor.fontSize', 'editor.fontSizeLarger'])
  })

  it('keeps registration order for an empty query', () => {
    const entries = [entry('b.x', { order: 0 }), entry('a.y', { order: 1 })]
    const ranked = filterAndRankSettings(entries, parseQuery(''))
    expect(ranked.map((r) => r.key)).toEqual(['b.x', 'a.y'])
  })
})
