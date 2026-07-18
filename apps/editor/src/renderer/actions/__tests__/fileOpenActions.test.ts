/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests activeEditorSelectionText — the helper that seeds "Go to File…" with the
 *  active editor's selection (Ctrl+P using selected text as the search term).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { afterEach, describe, expect, it } from 'vitest'
import { activeEditorSelectionText } from '../fileOpenActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'

function fakeSelection(text: string, isEmpty = false) {
  return { isEmpty: () => isEmpty, __text: text }
}

function fakeEditor(selection: ReturnType<typeof fakeSelection> | null) {
  return {
    getSelection: () => selection,
    getModel: () => ({
      getValueInRange: (sel: { __text: string }) => sel.__text,
    }),
  }
}

describe('activeEditorSelectionText', () => {
  afterEach(() => {
    FileEditorRegistry._resetForTests()
  })

  it('returns undefined when the active editor is not a FileEditorInput', () => {
    const editorService = { activeEditor: { get: () => undefined } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns undefined when the active input has no mounted editor', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns undefined when the selection is empty', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('', true)) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns undefined when the selection is only whitespace', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('   ')) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns the trimmed selected text', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('  FileEditorInput  ')) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBe('FileEditorInput')
  })

  it('keeps only the first line of a multi-line selection', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('foo.ts\nbar.ts')) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBe('foo.ts')
  })
})
