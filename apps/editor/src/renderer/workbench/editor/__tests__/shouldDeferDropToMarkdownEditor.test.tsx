/*---------------------------------------------------------------------------------------------
 *  Tests for shouldDeferDropToMarkdownEditor — the guard that keeps a Shift-drop of
 *  a file/image onto the markdown text area from being BOTH turned into a link
 *  (Monaco) and opened as a file (editor-area body). Without Shift the drop always
 *  falls through to the body (original open-file behaviour).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { EditorInput, URI, type IFileService } from '@universe-editor/platform'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { shouldDeferDropToMarkdownEditor } from '../EditorGroupView.js'

const stubFileService = { _serviceBrand: undefined } as unknown as IFileService

function mdInput(): FileEditorInput {
  return new FileEditorInput(URI.file('C:/work/notes.md'), stubFileService)
}
function tsInput(): FileEditorInput {
  return new FileEditorInput(URI.file('C:/work/main.ts'), stubFileService)
}

class OtherInput extends EditorInput {
  get typeId() {
    return 'other'
  }
  get resource() {
    return undefined
  }
  getName() {
    return 'other'
  }
}

/** A DOM node nested inside a `.monaco-editor` container. */
function insideMonaco(): HTMLElement {
  const root = document.createElement('div')
  root.className = 'monaco-editor'
  const child = document.createElement('span')
  root.appendChild(child)
  return child
}

describe('shouldDeferDropToMarkdownEditor', () => {
  it('defers when Shift is held, active editor is markdown and drop is inside the monaco text area', () => {
    expect(shouldDeferDropToMarkdownEditor(insideMonaco(), mdInput(), true)).toBe(true)
  })

  it('does not defer without Shift even when markdown and inside monaco', () => {
    expect(shouldDeferDropToMarkdownEditor(insideMonaco(), mdInput(), false)).toBe(false)
  })

  it('does not defer for a non-markdown editor even inside monaco', () => {
    expect(shouldDeferDropToMarkdownEditor(insideMonaco(), tsInput(), true)).toBe(false)
  })

  it('does not defer when the drop is outside the monaco text area', () => {
    const outside = document.createElement('div') // no .monaco-editor ancestor
    expect(shouldDeferDropToMarkdownEditor(outside, mdInput(), true)).toBe(false)
  })

  it('does not defer when there is no active editor', () => {
    expect(shouldDeferDropToMarkdownEditor(insideMonaco(), undefined, true)).toBe(false)
  })

  it('does not defer for a non-file editor input', () => {
    expect(shouldDeferDropToMarkdownEditor(insideMonaco(), new OtherInput(), true)).toBe(false)
  })

  it('does not defer for a null event target', () => {
    expect(shouldDeferDropToMarkdownEditor(null, mdInput(), true)).toBe(false)
  })
})
