/*---------------------------------------------------------------------------------------------
 *  Tests for the unified prompt-reference pipeline (promptRef.ts). Sections:
 *    - extractActiveToken:          caret-aware @/# tokenization
 *    - composePromptBlocksFromRefs: range-sliced text → interleaved blocks
 *    - composeRefBlock:             per-kind wire mapping (incl. spaces in label)
 *    - suggestionItemToRef / mentionEntryToRef: popover item → PromptRef
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  composePromptBlocksFromRefs,
  composeRefBlock,
  extractActiveToken,
  mentionEntryToRef,
  refDisplay,
  suggestionItemToRef,
  type PlacedRef,
  type PromptRef,
} from '../promptRef.js'
import type { ContextSuggestionItem } from '../contextSuggestions.js'

const sym = (over: Partial<PromptRef> = {}): PromptRef => ({
  id: 'r1',
  kind: 'symbol',
  label: 'foo bar',
  uri: 'file:///a.ts',
  meta: { line: 42, column: 3, symbolKind: 5, description: 'class foo bar' },
  ...over,
})

describe('extractActiveToken', () => {
  it('returns null for an empty buffer', () => {
    expect(extractActiveToken('', 0)).toBeNull()
  })

  it('returns null when there is no @/# token', () => {
    expect(extractActiveToken('hello world', 5)).toBeNull()
  })

  it('detects @ at start with empty query', () => {
    expect(extractActiveToken('@', 1)).toEqual({
      prefix: '@',
      query: '',
      startIndex: 0,
      endIndex: 1,
    })
  })

  it('detects # after whitespace with a partial query', () => {
    expect(extractActiveToken('hi #foo', 7)).toEqual({
      prefix: '#',
      query: 'foo',
      startIndex: 3,
      endIndex: 7,
    })
  })

  it('rejects mid-word @ (email-like)', () => {
    expect(extractActiveToken('mail@host', 9)).toBeNull()
  })

  it('rejects mid-word # (issue-like)', () => {
    expect(extractActiveToken('mail#host', 9)).toBeNull()
  })

  it('returns null when whitespace separates the caret from the trigger', () => {
    expect(extractActiveToken('#foo bar', 5)).toBeNull()
  })

  it('extends forward past the caret to the token end', () => {
    expect(extractActiveToken('@foobar', 4)).toEqual({
      prefix: '@',
      query: 'foobar',
      startIndex: 0,
      endIndex: 7,
    })
  })

  it('returns null when the caret is past the token end', () => {
    expect(extractActiveToken('#foo', 5)).toBeNull()
  })

  it('returns null for invalid caret positions', () => {
    expect(extractActiveToken('hi', -1)).toBeNull()
    expect(extractActiveToken('hi', 99)).toBeNull()
  })
})

describe('refDisplay', () => {
  it('prefixes @ for file/folder and # for context kinds', () => {
    expect(refDisplay(mentionEntryToRef({ uri: 'file:///a.ts', relPath: 'src/a.ts' }))).toBe(
      '@src/a.ts',
    )
    expect(refDisplay(sym())).toBe('#foo bar')
  })
})

describe('composePromptBlocksFromRefs', () => {
  it('returns [] for empty text', () => {
    expect(composePromptBlocksFromRefs('', [])).toEqual([])
  })

  it('returns a single text block when there are no refs', () => {
    expect(composePromptBlocksFromRefs('hello', [])).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('slices text around a ref whose label contains spaces (the core fix)', () => {
    // text: "see #foo bar please" — the pill spans offsets [4,11): "#foo bar"
    const text = 'see #foo bar please'
    const placed: PlacedRef[] = [{ ref: sym(), start: 4, end: 12 }]
    expect(composePromptBlocksFromRefs(text, placed)).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'text',
        text: '`foo bar` (class foo bar:42:3)',
        _meta: { symbol: { uri: 'file:///a.ts', name: 'foo bar', line: 42, column: 3, kind: 5 } },
      },
      { type: 'text', text: ' please' },
    ])
  })

  it('interleaves multiple refs in start order regardless of input order', () => {
    const text = '@a.ts and #foo bar'
    const fileRef: PromptRef = { id: 'f', kind: 'file', label: 'a.ts', uri: 'file:///a.ts' }
    const symNoMeta: PromptRef = { id: 's', kind: 'symbol', label: 'foo bar', uri: 'file:///a.ts' }
    const placed: PlacedRef[] = [
      { ref: symNoMeta, start: 10, end: 18 },
      { ref: fileRef, start: 0, end: 5 },
    ]
    expect(composePromptBlocksFromRefs(text, placed)).toEqual([
      { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
      { type: 'text', text: ' and ' },
      {
        type: 'text',
        text: '`foo bar` (file:///a.ts)',
        _meta: { symbol: { uri: 'file:///a.ts', name: 'foo bar' } },
      },
    ])
  })

  it('drops a ref with an out-of-bounds range', () => {
    expect(composePromptBlocksFromRefs('hi', [{ ref: sym(), start: 5, end: 9 }])).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  it('skips a ref that overlaps a previous one', () => {
    const text = '#foo bar baz'
    const placed: PlacedRef[] = [
      { ref: sym({ id: 'a' }), start: 0, end: 8 },
      { ref: sym({ id: 'b' }), start: 4, end: 12 },
    ]
    const blocks = composePromptBlocksFromRefs(text, placed)
    // Only the first ref survives; the trailing " baz" stays as text.
    expect(blocks).toEqual([
      {
        type: 'text',
        text: '`foo bar` (class foo bar:42:3)',
        _meta: { symbol: { uri: 'file:///a.ts', name: 'foo bar', line: 42, column: 3, kind: 5 } },
      },
      { type: 'text', text: ' baz' },
    ])
  })
})

describe('composeRefBlock', () => {
  it('maps a symbol ref to a text block carrying its location (agents drop resource_link _meta)', () => {
    // Regression: built-in agents serialize resource_link as just its uri, so a
    // symbol's line/column would be lost and the agent reads the whole file.
    const ref: PromptRef = {
      id: 'x',
      kind: 'symbol',
      label: 'Student',
      uri: 'file:///hello.ts',
      meta: { line: 12, column: 5, symbolKind: 4, description: 'hello.ts' },
    }
    expect(composeRefBlock(ref)).toEqual({
      type: 'text',
      text: '`Student` (hello.ts:12:5)',
      _meta: {
        symbol: { uri: 'file:///hello.ts', name: 'Student', line: 12, column: 5, kind: 4 },
      },
    })
  })

  it('maps a symbol ref with no meta to a text block falling back to the uri', () => {
    const ref: PromptRef = { id: 'x', kind: 'symbol', label: 'Student', uri: 'file:///hello.ts' }
    expect(composeRefBlock(ref)).toEqual({
      type: 'text',
      text: '`Student` (file:///hello.ts)',
      _meta: { symbol: { uri: 'file:///hello.ts', name: 'Student' } },
    })
  })

  it('maps file/folder/openEditor to a bare resource_link', () => {
    for (const kind of ['file', 'folder', 'openEditor'] as const) {
      const ref: PromptRef = { id: 'x', kind, label: 'a.ts', uri: 'file:///a.ts' }
      expect(composeRefBlock(ref)).toEqual({
        type: 'resource_link',
        uri: 'file:///a.ts',
        name: 'a.ts',
      })
    }
  })

  it('maps a scmChange ref to a resource_link with status description', () => {
    const ref: PromptRef = {
      id: 'x',
      kind: 'scmChange',
      label: 'a.ts',
      uri: 'file:///a.ts',
      meta: { scmStatus: 'M' },
    }
    expect(composeRefBlock(ref)).toEqual({
      type: 'resource_link',
      uri: 'file:///a.ts',
      name: 'a.ts',
      description: 'M',
    })
  })

  it('maps a docs ref to a text block, falling back to a localized message', () => {
    const withDesc: PromptRef = {
      id: 'x',
      kind: 'docs',
      label: 'docs',
      uri: 'file:///docs',
      meta: { description: 'Docs at /docs' },
    }
    expect(composeRefBlock(withDesc)).toEqual({ type: 'text', text: 'Docs at /docs' })

    const noDesc: PromptRef = { id: 'x', kind: 'docs', label: 'docs', uri: 'file:///docs' }
    expect(composeRefBlock(noDesc)).toEqual({
      type: 'text',
      text: 'Documentation available at file:///docs',
    })
  })
})

describe('suggestionItemToRef / mentionEntryToRef', () => {
  it('strips the display :line suffix from a symbol description', () => {
    const item: ContextSuggestionItem = {
      kind: 'symbol',
      label: 'MyClass',
      uri: 'file:///a.ts',
      description: 'src/a.ts:42',
      iconId: 'symbol-class',
      meta: { line: 42, column: 3, symbolKind: 5 },
    }
    const ref = suggestionItemToRef(item)
    expect(ref.kind).toBe('symbol')
    expect(ref.label).toBe('MyClass')
    expect(ref.meta?.description).toBe('src/a.ts')
    expect(ref.meta?.line).toBe(42)
    expect(ref.id).toBeTruthy()
  })

  it('builds a file ref from a mention entry', () => {
    const ref = mentionEntryToRef({ uri: 'file:///a.ts', relPath: 'src/a.ts' })
    expect(ref).toMatchObject({ kind: 'file', label: 'src/a.ts', uri: 'file:///a.ts' })
    expect(ref.id).toBeTruthy()
  })

  it('builds a folder ref when asked', () => {
    const ref = mentionEntryToRef({ uri: 'file:///src', relPath: 'src' }, 'folder')
    expect(ref.kind).toBe('folder')
  })
})
