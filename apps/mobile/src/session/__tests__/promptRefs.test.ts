import { describe, expect, it } from 'vitest'
import type { MobilePromptRefSuggestion } from '@universe-editor/mobile-protocol'
import {
  applyTextEdit,
  collectPlacedRefs,
  extractHashQuery,
  extractMentionQuery,
  insertPromptRef,
  type PlacedPromptRef,
} from '../promptRefs.js'

function fileSuggestion(label: string): MobilePromptRefSuggestion {
  return { kind: 'file', label, uri: `file:///workspace/${label}` }
}

function docsSuggestion(label: string): MobilePromptRefSuggestion {
  return {
    kind: 'docs',
    label,
    uri: 'file:///docs/user/zh-CN',
    dirPath: '/docs/user/zh-CN',
  }
}

describe('extractMentionQuery / extractHashQuery', () => {
  it('reports the active token and query', () => {
    expect(extractMentionQuery('look @src/a.', 12)).toEqual({
      trigger: '@',
      query: 'src/a.',
      start: 5,
      end: 12,
    })
    expect(extractHashQuery('#fn', 3)).toEqual({ trigger: '#', query: 'fn', start: 0, end: 3 })
  })

  it('accepts an empty query right after the trigger', () => {
    expect(extractMentionQuery('@', 1)).toMatchObject({ query: '', start: 0, end: 1 })
  })

  it('requires the trigger to start the text or follow whitespace', () => {
    expect(extractMentionQuery('mail@host', 9)).toBeNull()
    expect(extractHashQuery('issue#42', 8)).toBeNull()
  })

  it('does not cross a token of the other trigger', () => {
    expect(extractMentionQuery('#fn', 3)).toBeNull()
    expect(extractHashQuery('@fn', 3)).toBeNull()
  })

  it('closes once the caret leaves the token', () => {
    expect(extractMentionQuery('@src/a.ts done', 14)).toBeNull()
    expect(extractMentionQuery('@src/a.ts', 4)).toMatchObject({ query: 'src/a.ts' })
  })
})

describe('applyTextEdit', () => {
  const placed: PlacedPromptRef = { ref: fileSuggestion('src/a.ts'), start: 5, end: 14 }

  it('keeps a ref before the edit untouched', () => {
    expect(applyTextEdit('look @src/a.ts and', 'look @src/a.ts and more', [placed])).toEqual([
      placed,
    ])
  })

  it('shifts a ref after an insertion before it', () => {
    expect(applyTextEdit('@src/a.ts', 'hi @src/a.ts', [placed])).toEqual([
      { ...placed, start: 8, end: 17 },
    ])
  })

  it('shifts a ref after a deletion before it', () => {
    expect(applyTextEdit('look @src/a.ts', 'lk @src/a.ts', [placed])).toEqual([
      { ...placed, start: 3, end: 12 },
    ])
  })

  it('drops a ref touched by the edit', () => {
    expect(applyTextEdit('look @src/a.ts', 'look @src/a.xs', [placed])).toEqual([])
    expect(applyTextEdit('look @src/a.ts', 'look @sr', [placed])).toEqual([])
  })

  it('keeps a ref when text is inserted immediately after it', () => {
    expect(applyTextEdit('look @src/a.ts', 'look @src/a.ts!', [placed])).toEqual([placed])
  })
})

describe('insertPromptRef', () => {
  it('replaces the token and adds a separating space before a word', () => {
    const result = insertPromptRef('look @src/a next', 5, 11, fileSuggestion('src/a.ts'))
    expect(result).toEqual({
      text: 'look @src/a.ts next',
      caret: 14,
      placed: { ref: fileSuggestion('src/a.ts'), start: 5, end: 14 },
    })
  })

  it('does not add a space before existing whitespace or at the end', () => {
    expect(insertPromptRef('look @src ', 5, 9, fileSuggestion('src/a.ts'))).toMatchObject({
      text: 'look @src/a.ts ',
      caret: 14,
    })
    expect(insertPromptRef('look @src', 5, 9, fileSuggestion('src/a.ts'))).toMatchObject({
      text: 'look @src/a.ts',
      caret: 14,
    })
  })

  it('keeps labels with spaces intact', () => {
    const result = insertPromptRef('#Editor', 0, 7, docsSuggestion('Editor User Guide'))
    expect(result).toMatchObject({
      text: '#Editor User Guide',
      caret: 18,
      placed: { start: 0, end: 18 },
    })
  })

  it('uses the # prefix for commit and chatContext suggestions', () => {
    const commit = insertPromptRef('#Git', 0, 4, {
      kind: 'commit',
      label: 'a1b2c3d fix',
      uri: 'file:///repo',
      commitHash: 'a'.repeat(40),
      text: 'fix',
    })
    expect(commit.text).toBe('#a1b2c3d fix')

    const chatContext = insertPromptRef('#P4', 0, 3, {
      kind: 'chatContext',
      label: 'CL 1',
      uri: '',
      text: 'body',
    })
    expect(chatContext.text).toBe('#CL 1')
  })
})

describe('collectPlacedRefs', () => {
  it('sorts by offset and drops stale slices', () => {
    const first: PlacedPromptRef = { ref: fileSuggestion('a.ts'), start: 0, end: 5 }
    const stale: PlacedPromptRef = { ref: fileSuggestion('b.ts'), start: 6, end: 11 }

    expect(collectPlacedRefs('@a.ts !b.ts', [stale, first])).toEqual([
      { kind: 'file', label: 'a.ts', uri: 'file:///workspace/a.ts', start: 0, end: 5 },
    ])
  })

  it('drops overlapping refs and keeps the earlier one', () => {
    const first: PlacedPromptRef = { ref: fileSuggestion('a.ts'), start: 0, end: 5 }
    const overlap: PlacedPromptRef = { ref: fileSuggestion('a.ts'), start: 0, end: 5 }

    expect(collectPlacedRefs('@a.ts', [first, overlap])).toEqual([
      { kind: 'file', label: 'a.ts', uri: 'file:///workspace/a.ts', start: 0, end: 5 },
    ])
  })

  it('keeps two identical tokens at different offsets', () => {
    const first: PlacedPromptRef = { ref: fileSuggestion('a.ts'), start: 0, end: 5 }
    const second: PlacedPromptRef = { ref: fileSuggestion('a.ts'), start: 6, end: 11 }

    expect(collectPlacedRefs('@a.ts @a.ts', [second, first]).map((ref) => ref.start)).toEqual([
      0, 6,
    ])
  })

  it('caps the result at the protocol limit', () => {
    const tokens = Array.from({ length: 33 }, () => '@a.ts')
    const text = tokens.join(' ')
    const placed = tokens.map((_, index) => ({
      ref: fileSuggestion('a.ts'),
      start: index * 6,
      end: index * 6 + 5,
    }))

    const refs = collectPlacedRefs(text, placed)

    expect(refs).toHaveLength(32)
    expect(refs.at(-1)?.start).toBe(31 * 6)
  })

  it('caps the aggregate prompt-ref byte budget', () => {
    const tokens = Array.from({ length: 9 }, (_, index) => `#c${index}`)
    const text = tokens.join(' ')
    let cursor = 0
    const placed = tokens.map((token, index) => {
      const start = text.indexOf(token, cursor)
      cursor = start + token.length
      return {
        ref: {
          kind: 'chatContext' as const,
          label: `c${index}`,
          uri: '',
          text: 'x'.repeat(4000),
        },
        start,
        end: cursor,
      }
    })

    const refs = collectPlacedRefs(text, placed)

    expect(refs).toHaveLength(8)
    expect(refs.at(-1)?.label).toBe('c7')
  })
})
