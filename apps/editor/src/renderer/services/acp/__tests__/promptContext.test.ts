/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { afterEach, describe, expect, it } from 'vitest'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'
import {
  collectActiveSelectionContexts,
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

function fakeSelection(startLineNumber: number, endLineNumber: number, isEmpty = false) {
  return { startLineNumber, endLineNumber, isEmpty: () => isEmpty }
}

function fakeEditor(
  selections: readonly ReturnType<typeof fakeSelection>[],
  valuesByLine: Record<number, string>,
  languageId?: string,
) {
  return {
    getSelections: () => selections,
    getModel: () => ({
      getValueInRange: (sel: { startLineNumber: number }) =>
        valuesByLine[sel.startLineNumber] ?? '',
      getLanguageId: () => languageId,
    }),
  }
}

describe('collectActiveSelectionContexts', () => {
  afterEach(() => {
    FileEditorRegistry._resetForTests()
  })

  it('returns [] when the active editor is not a FileEditorInput', () => {
    const editorService = { activeEditor: { get: () => undefined } }
    const workspaceService = { current: undefined }
    const out = collectActiveSelectionContexts(editorService as never, workspaceService as never)
    expect(out).toEqual([])
  })

  it('returns [] when the active input has no mounted editor', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    const editorService = { activeEditor: { get: () => input } }
    const workspaceService = { current: { folder: URI.file('/workspace') } }
    const out = collectActiveSelectionContexts(editorService as never, workspaceService as never)
    expect(out).toEqual([])
  })

  it('collects non-empty selections, dropping empty ones and whitespace-only text', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(
      input,
      fakeEditor(
        [fakeSelection(1, 1, true), fakeSelection(3, 5), fakeSelection(8, 8)],
        { 3: 'const x = 1', 8: '   ' },
        'typescript',
      ) as never,
    )
    const editorService = { activeEditor: { get: () => input } }
    const workspaceService = { current: { folder: URI.file('/workspace') } }
    const out = collectActiveSelectionContexts(editorService as never, workspaceService as never)
    expect(out).toEqual([
      {
        uri: URI.file('/workspace/src/a.ts').toString(),
        relPath: 'src/a.ts',
        text: 'const x = 1',
        startLine: 3,
        endLine: 5,
        languageId: 'typescript',
      },
    ])
  })

  it('omits languageId when the model reports none', () => {
    const input = new FileEditorInput(URI.file('/workspace/b.ts'), {} as never)
    FileEditorRegistry.register(
      input,
      fakeEditor([fakeSelection(1, 1)], { 1: 'x' }, undefined) as never,
    )
    const editorService = { activeEditor: { get: () => input } }
    const workspaceService = { current: undefined }
    const out = collectActiveSelectionContexts(editorService as never, workspaceService as never)
    expect(out).toHaveLength(1)
    expect('languageId' in out[0]!).toBe(false)
  })
})
