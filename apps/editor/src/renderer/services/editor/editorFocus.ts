import type { EditorInput, IContextKeyService } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'

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
  if (!editor) return false
  focusStandaloneEditor(editor, contextKeyService)
  return true
}

export function focusStandaloneEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  contextKeyService: IContextKeyService,
): void {
  editor.focus()
  syncEditorFocusContext(contextKeyService)
  queueMicrotask(() => syncEditorFocusContext(contextKeyService))
}
