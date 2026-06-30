import type { EditorInput, IContextKeyService, IDisposable } from '@universe-editor/platform'
import { autorun } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'
import { DiffEditorRegistry } from './DiffEditorRegistry.js'

export function syncEditorFocusContext(contextKeyService: IContextKeyService): void {
  const active = document.activeElement
  const hasEditorFocus = active instanceof HTMLElement && active.closest('.monaco-editor') !== null
  contextKeyService.set('editorFocus', hasEditorFocus)
  // `editorTextFocus` is set true by Monaco's onDidFocusEditorText and cleared by
  // onDidBlurEditorText — but that blur subscription is disposed before the editor
  // itself when a FileEditor unmounts (e.g. a markdown source replaced by its
  // preview), so the blur never fires and the key stays stuck true. A stuck
  // `editorTextFocus` makes the global keybinding handler treat the (non-Monaco)
  // preview as a text surface and swallow printable single-key bindings like `f`.
  // When no Monaco editor holds DOM focus at all, text focus is definitionally
  // false, so clear it here. We only clear (never set): the text-vs-widget
  // distinction while a Monaco editor is focused stays Monaco's job.
  if (!hasEditorFocus) contextKeyService.set('editorTextFocus', false)
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

/** Minimal observable shape of Monaco's inline-completions model for visibility tracking. */
interface ObservableLike<T> {
  read(reader: unknown): T
  get(): T
}
interface GhostTextLike {
  isEmpty(): boolean
}
interface InlineStateLike {
  readonly primaryGhostText?: GhostTextLike
}
interface InlineEditStateLike {
  readonly cursorAtInlineEdit: ObservableLike<boolean>
}
interface InlineModelLike {
  readonly inlineCompletionState: ObservableLike<InlineStateLike | undefined>
  readonly inlineEditState: ObservableLike<InlineEditStateLike | undefined>
  readonly tabShouldJumpToInlineEdit: ObservableLike<boolean>
  readonly tabShouldAcceptInlineEdit: ObservableLike<boolean>
}
interface InlineControllerLike {
  readonly model: ObservableLike<InlineModelLike | undefined>
  dispose(): void
}

/**
 * Mirror Monaco's inline-suggestion (ghost text) visibility onto the global
 * `inlineSuggestionVisible` context key. Monaco keeps that key only on the
 * editor's own scoped context-key service, so the global keybinding handler
 * can't see it — and with `editContext: true` Monaco's internal Tab dispatch
 * can't be relied on to commit. Mirroring the key lets our Tab binding
 * (`ai.inlineCompletion.commit`) outrank the editor's indent and accept the
 * suggestion through the command we control. We follow the same observable the
 * controller itself binds the key to: a non-empty primary ghost text.
 */
export function bridgeInlineSuggestionVisible(
  editor: monaco.editor.IStandaloneCodeEditor,
  contextKeyService: IContextKeyService,
): IDisposable {
  if (typeof editor.getContribution !== 'function') return { dispose: () => undefined }
  const controller = editor.getContribution<InlineControllerLike>(
    'editor.contrib.inlineCompletionsController',
  )
  if (!controller?.model) return { dispose: () => undefined }
  const sub = autorun((reader) => {
    const model = controller.model.read(reader)
    const ghost = model?.inlineCompletionState.read(reader)?.primaryGhostText
    contextKeyService.set('inlineSuggestionVisible', !!ghost && !ghost.isEmpty())
  })
  return {
    dispose: () => {
      sub.dispose()
      contextKeyService.set('inlineSuggestionVisible', false)
    },
  }
}

/**
 * Mirror Monaco's inline-edit (Next Edit Suggestion) state onto global context
 * keys, the same way the controller binds them on its own scoped service. The
 * global keybinding handler can't see Monaco's scoped keys, and with
 * `editContext: true` Monaco's internal Tab dispatch is unreliable — so we
 * mirror `inlineEditIsVisible` / `cursorAtInlineEdit` / `tabShouldJump…` /
 * `tabShouldAccept…` and drive Tab through our own high-weight jump/commit
 * commands (see inlineCompletionActions). Resets all four on dispose.
 */
export function bridgeInlineEditState(
  editor: monaco.editor.IStandaloneCodeEditor,
  contextKeyService: IContextKeyService,
): IDisposable {
  if (typeof editor.getContribution !== 'function') return { dispose: () => undefined }
  const controller = editor.getContribution<InlineControllerLike>(
    'editor.contrib.inlineCompletionsController',
  )
  if (!controller?.model) return { dispose: () => undefined }
  const reset = () => {
    contextKeyService.set('inlineEditIsVisible', false)
    contextKeyService.set('cursorAtInlineEdit', false)
    contextKeyService.set('tabShouldJumpToInlineEdit', false)
    contextKeyService.set('tabShouldAcceptInlineEdit', false)
  }
  const sub = autorun((reader) => {
    const model = controller.model.read(reader)
    const editState = model?.inlineEditState.read(reader)
    contextKeyService.set('inlineEditIsVisible', editState !== undefined)
    contextKeyService.set('cursorAtInlineEdit', !!editState?.cursorAtInlineEdit.read(reader))
    contextKeyService.set(
      'tabShouldJumpToInlineEdit',
      !!model?.tabShouldJumpToInlineEdit.read(reader),
    )
    contextKeyService.set(
      'tabShouldAcceptInlineEdit',
      !!model?.tabShouldAcceptInlineEdit.read(reader),
    )
  })
  return {
    dispose: () => {
      sub.dispose()
      reset()
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
  // Non-Monaco editors (e.g. React-based) may implement focus() directly.
  if (input.focus?.()) return true
  // Otherwise pull DOM focus into the group's editor body so keyboard input
  // leaves wherever it was (often the terminal — which leaves terminalFocus
  // stuck true and blocks Ctrl+W). Covers every non-text editor that doesn't
  // manage its own focus (Git Graph, AI Models, Settings, Keybindings, …).
  return focusGroupBody(contextKeyService, groupId)
}

function focusGroupBody(contextKeyService: IContextKeyService, groupId?: number): boolean {
  const body = findGroupBody(groupId)
  if (!body) return false
  body.focus()
  syncEditorFocusContext(contextKeyService)
  return true
}

function findGroupBody(groupId?: number): HTMLElement | null {
  const selector =
    groupId !== undefined
      ? `[data-group-id="${groupId}"] [data-testid="editor-group-body"]`
      : '[data-testid="editor-group-body"]'
  return document.querySelector<HTMLElement>(selector)
}

export function focusStandaloneEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  contextKeyService: IContextKeyService,
): void {
  editor.focus()
  syncEditorFocusContext(contextKeyService)
  queueMicrotask(() => syncEditorFocusContext(contextKeyService))
}
