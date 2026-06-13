import type { EditorInput, IContextKeyService, IDisposable } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'
import { DiffEditorRegistry } from './DiffEditorRegistry.js'

export function syncEditorFocusContext(contextKeyService: IContextKeyService): void {
  const active = document.activeElement
  const hasEditorFocus = active instanceof HTMLElement && active.closest('.monaco-editor') !== null
  contextKeyService.set('editorFocus', hasEditorFocus)
}

/** Minimal shape of Monaco's SuggestController exposed for visibility tracking. */
interface SuggestModelLike {
  readonly onDidSuggest: monaco.IEvent<unknown>
  readonly onDidCancel: monaco.IEvent<unknown>
}
interface SuggestControllerLike {
  readonly model: SuggestModelLike
  dispose(): void
}

/**
 * Mirror Monaco's completion-widget visibility onto the global `suggestWidgetVisible`
 * context key. Monaco confines that key to its own scoped context-key service, so
 * the global keybinding handler can't see it — without this, an extension's smart
 * Enter/Tab (a higher-weight binding) would steal the keystroke that should accept
 * a completion. We track the SuggestModel's suggest/cancel events, which fire
 * before the widget shows/hides.
 */
export function bridgeSuggestWidgetVisible(
  editor: monaco.editor.IStandaloneCodeEditor,
  contextKeyService: IContextKeyService,
): IDisposable {
  if (typeof editor.getContribution !== 'function') return { dispose: () => undefined }
  const controller = editor.getContribution<SuggestControllerLike>(
    'editor.contrib.suggestController',
  )
  if (!controller?.model) return { dispose: () => undefined }
  const show = controller.model.onDidSuggest(() =>
    contextKeyService.set('suggestWidgetVisible', true),
  )
  const hide = controller.model.onDidCancel(() =>
    contextKeyService.set('suggestWidgetVisible', false),
  )
  return {
    dispose: () => {
      show.dispose()
      hide.dispose()
      contextKeyService.set('suggestWidgetVisible', false)
    },
  }
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
