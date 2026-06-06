import type { EditorInput, IContextKeyService } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'
import { DiffEditorRegistry } from './DiffEditorRegistry.js'

export function syncEditorFocusContext(contextKeyService: IContextKeyService): void {
  const active = document.activeElement
  const hasEditorFocus = active instanceof HTMLElement && active.closest('.monaco-editor') !== null
  contextKeyService.set('editorFocus', hasEditorFocus)
}

export function focusEditorInput(
  input: EditorInput,
  contextKeyService: IContextKeyService,
  groupId?: number,
): boolean {
  const editor = FileEditorRegistry.get(input, groupId)
  if (editor) {
    focusStandaloneEditor(editor, contextKeyService)
    return true
  }
  // Diff editors live in their own registry; focus the modified side so keyboard
  // input lands in the editor after opening a diff (e.g. from the SCM view).
  const diff = DiffEditorRegistry.get(input, groupId)
  if (diff) {
    diff.focus()
    syncEditorFocusContext(contextKeyService)
    queueMicrotask(() => syncEditorFocusContext(contextKeyService))
    return true
  }
  return false
}

export function focusStandaloneEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  contextKeyService: IContextKeyService,
): void {
  editor.focus()
  syncEditorFocusContext(contextKeyService)
  queueMicrotask(() => syncEditorFocusContext(contextKeyService))
}
