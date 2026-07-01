/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  composeContextBlocks,
  formatSelectionFallback,
  formatSelectionLabel,
  type SelectionContext,
} from '../promptContext.js'

const CTX: SelectionContext = {
  uri: 'file:///w/src/a.ts',
  relPath: 'src/a.ts',
  text: 'const x = 1',
  startLine: 12,
  endLine: 40,
  languageId: 'typescript',
}

describe('formatSelectionLabel', () => {
  it('renders a range for a multi-line selection', () => {
    expect(formatSelectionLabel(CTX)).toBe('src/a.ts:12-40')
  })

  it('renders a single line without a range', () => {
    expect(formatSelectionLabel({ ...CTX, startLine: 7, endLine: 7 })).toBe('src/a.ts:7')
  })
})

describe('composeContextBlocks', () => {
  it('returns [] for no contexts', () => {
    expect(composeContextBlocks([], true)).toEqual([])
    expect(composeContextBlocks([], false)).toEqual([])
  })

  it('emits an EmbeddedResource carrying uri + text + line range when supported', () => {
    const blocks = composeContextBlocks([CTX], true)
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.type).toBe('resource')
    if (block.type !== 'resource') throw new Error('expected resource block')
    expect(block.resource).toMatchObject({
      uri: 'file:///w/src/a.ts',
      text: 'const x = 1',
      mimeType: 'text/x-typescript',
    })
    expect(block._meta).toEqual({ selection: { startLine: 12, endLine: 40 } })
  })

  it('falls back to a fenced-code text block when embeddedContext is unsupported', () => {
    const blocks = composeContextBlocks([CTX], false)
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.type).toBe('text')
    if (block.type !== 'text') throw new Error('expected text block')
    expect(block.text).toBe('```typescript src/a.ts:12-40\nconst x = 1\n```')
  })

  it('omits mimeType when the selection has no languageId', () => {
    const { languageId: _drop, ...noLang } = CTX
    const blocks = composeContextBlocks([noLang], true)
    const block = blocks[0]!
    if (block.type !== 'resource') throw new Error('expected resource block')
    expect('mimeType' in block.resource).toBe(false)
  })

  it('produces one block per selection, preserving order', () => {
    const second: SelectionContext = { ...CTX, relPath: 'src/b.ts', startLine: 1, endLine: 1 }
    const blocks = composeContextBlocks([CTX, second], false)
    expect(blocks).toHaveLength(2)
    expect(blocks[1]!.type === 'text' && blocks[1]!.text.includes('src/b.ts:1')).toBe(true)
  })
})

describe('formatSelectionFallback', () => {
  it('drops the language prefix when absent', () => {
    const { languageId: _drop, ...noLang } = CTX
    expect(formatSelectionFallback(noLang)).toBe('```src/a.ts:12-40\nconst x = 1\n```')
  })
})
