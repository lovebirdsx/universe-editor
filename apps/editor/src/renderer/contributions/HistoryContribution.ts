/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HistoryContribution — wires IHistoryService into the renderer:
 *    1. Per-file Monaco cursor listeners (250ms debounce, significance
 *       threshold: file changed OR line delta > 10) that call
 *       historyService.record on meaningful navigation.
 *    2. A Monaco code-editor open handler (registered as a pure observer) that
 *       records jump origins and targets for every programmatic navigation
 *       carrying a target selection (F12 family, peek jumps, marker
 *       navigation, ...) — those move only the cursor, so the cursor listener
 *       alone would swallow short jumps under the significance threshold.
 *    3. A synchronous flush of the active editor's pending debounce on
 *       onWillNavigate, so a significant move made moments before Alt+Left is
 *       popped as the "current" entry rather than lost entirely.
 *    4. Two ContextKeys (canGoBack / canGoForward) driven by onDidChange so
 *       GoBackAction / GoForwardAction precondition expressions resolve.
 *
 *  Cursor listeners attach once per Monaco editor instance via
 *  FileEditorRegistry.onDidChange and detach via the editor's own
 *  onDidDispose.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  EditorInput,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IEditorService,
  IHistoryService,
  IStorageService,
  IUriIdentityService,
  IWorkbenchContribution,
  URI,
  autorun,
  toDisposable,
  type IDisposable,
  type IHistorySelection,
} from '@universe-editor/platform'
import { GoBackAction, GoForwardAction } from '../actions/historyActions.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { findExistingFileEditor } from '../services/editor/revealEditorPosition.js'
import {
  MonacoLoader,
  type ICodeEditorOpenInput,
  type monaco,
} from '../workbench/editor/monaco/MonacoLoader.js'

const SIGNIFICANT_LINE_DELTA = 10
const DEBOUNCE_MS = 250

type MonacoLikeEditor = NonNullable<ReturnType<typeof FileEditorRegistry.get>>

interface AttachedListener {
  editor: MonacoLikeEditor
  // Canonical resource of the backing FileEditorInput. Monaco normalizes
  // Windows drive letters to lowercase on its model URI, so using the input's
  // resource keeps history keys byte-equal to EditorInput.resource — without
  // which GoBack's `===` lookup would miss the existing tab.
  resource: URI
  cursorSub: IDisposable
  disposeSub: IDisposable
  timer: ReturnType<typeof setTimeout> | undefined
  lastResource: string | undefined
  lastLine: number
}

export class HistoryContribution extends Disposable implements IWorkbenchContribution {
  private readonly _listeners = new Map<MonacoLikeEditor, AttachedListener>()

  constructor(
    @IHistoryService private readonly _historyService: IHistoryService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IEditorService private readonly _editorService: IEditorService,
    @IEditorGroupsService private readonly _groupsService: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IStorageService storageService: IStorageService,
    @ICommandService commandService: ICommandService,
  ) {
    super()

    this._registerMouseNavigation(commandService)

    // Observe (never intervene in) programmatic editor opens: the handler runs
    // before monaco applies the target selection, so the source's current
    // selection is exactly the jump origin. Same-model targets always reach
    // this handler (EditorOpenerContribution returns null for them); a
    // cross-file open may short-circuit the chain at EditorOpenerContribution
    // (registered later, so its handler is tried first) — the active-editor
    // autorun below covers that case.
    void MonacoLoader.registerCodeEditorOpenHandler((input, source) =>
      this._onCodeEditorOpen(input, source),
    ).then((disposable) => {
      if (this._store.isDisposed) disposable.dispose()
      else this._register(disposable)
    })

    const canGoBack = contextKeyService.createKey<boolean>(
      'canGoBack',
      this._historyService.canGoBack(),
    )
    const canGoForward = contextKeyService.createKey<boolean>(
      'canGoForward',
      this._historyService.canGoForward(),
    )
    this._register(
      this._historyService.onDidChange(() => {
        canGoBack.set(this._historyService.canGoBack())
        canGoForward.set(this._historyService.canGoForward())
      }),
    )

    // Record an entry whenever the active editor changes so that simply
    // opening file a then file b (or Settings then file a, etc.) is enough
    // for GoBack to work. Covers every EditorInput subclass — file, Settings,
    // Welcome, Agents, ... — by capturing typeId + serialized so the action
    // can rebuild the input via EditorRegistry.deserialize when it is no
    // longer open in any group. The cursor listener below upgrades file
    // entries in-place once Monaco mounts and the user moves the caret.
    let lastRecordedResource: string | undefined
    let lastActiveInput: EditorInput | undefined
    this._register(
      autorun((reader) => {
        const active = this._editorService.activeEditor.read(reader)
        if (!(active instanceof EditorInput)) return
        const resource = active.resource
        if (!resource) return
        const uri = resource.toString()
        if (uri === lastRecordedResource) return
        // Before leaving the previous editor, fold its current caret into its
        // existing stack entry. A small intra-file move (1→2) never crosses the
        // cursor listener's significance threshold, so without this GoBack would
        // return to the stale entry position rather than where the user left off
        // (matches vscode, which snapshots the outgoing editor's view state).
        this._captureLeaving(lastActiveInput)
        lastActiveInput = active
        lastRecordedResource = uri
        this._historyService.record({
          resource,
          typeId: active.typeId,
          serialized: active.serialize?.(),
        })
      }),
    )

    // History is workspace-bound (matches vscode): when the workspace storage
    // scope swaps (folder open/close/change) the prior workspace's entries are
    // meaningless and GoBack must not cross into them. Reset the dedup closure
    // too so re-opening a same-named file in the new workspace records afresh.
    this._register(
      storageService.onDidChangeWorkspaceScope(() => {
        lastRecordedResource = undefined
        lastActiveInput = undefined
        this._historyService.clear()
      }),
    )

    // A goBack/goForward pops the stack before the reveal: flush the active
    // editor's pending debounced move first, or a significant move made
    // moments ago would be popped off as the stale "current" entry and the
    // real current position would exist in neither stack.
    this._register(this._historyService.onWillNavigate(() => this._flushActiveEditor()))

    this._register(
      FileEditorRegistry.onDidChange((input) => {
        if (!(input instanceof FileEditorInput)) return
        const editor = FileEditorRegistry.get(input)
        if (editor) this._attach(editor, input.resource)
      }),
    )

    this._register(
      toDisposable(() => {
        for (const listener of this._listeners.values()) this._detach(listener)
        this._listeners.clear()
      }),
    )
  }

  private _registerMouseNavigation(commandService: ICommandService): void {
    // Mouse buttons 4/5 (MouseEvent.button 3/4) navigate back/forward, matching
    // VSCode and the browser/OS convention. Fire on mousedown for a snappier feel
    // and preventDefault on both down and up so Chromium's default history
    // navigation never also runs.
    const onMouseDownOrUp = (e: MouseEvent, isMouseDown: boolean): void => {
      switch (e.button) {
        case 3:
          e.preventDefault()
          if (isMouseDown) void commandService.executeCommand(GoBackAction.ID)
          break
        case 4:
          e.preventDefault()
          if (isMouseDown) void commandService.executeCommand(GoForwardAction.ID)
          break
      }
    }
    const onMouseDown = (e: MouseEvent): void => onMouseDownOrUp(e, true)
    const onMouseUp = (e: MouseEvent): void => onMouseDownOrUp(e, false)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    this._register(
      toDisposable(() => {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mouseup', onMouseUp)
      }),
    )
  }

  private _captureLeaving(input: EditorInput | undefined): void {
    if (!(input instanceof FileEditorInput)) return
    const editor = FileEditorRegistry.get(input)
    if (!editor) return
    // Cancel a pending debounced flush for this editor: it would otherwise fire
    // after the new editor was recorded and push a stale, out-of-order entry.
    const state = this._listeners.get(editor)
    if (state?.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    const pos = editor.getPosition()
    const selection = this._readSelection(editor)
    if (!pos || !selection) return
    if (state) {
      state.lastResource = input.resource.toString()
      state.lastLine = pos.lineNumber
    }
    this._historyService.updateCurrent(input.resource, selection)
  }

  private _attach(editor: MonacoLikeEditor, resource: URI): void {
    const existing = this._listeners.get(editor)
    if (existing) {
      // Preview-replace reuses the same Monaco instance and swaps its model
      // (a → b in the preview slot). The instance is re-registered under the new
      // input, so refresh the bound resource — otherwise b's cursor moves would
      // be recorded against the stale a, wedging a bogus entry into history.
      if (existing.resource.toString() !== resource.toString()) {
        existing.resource = resource
        existing.lastResource = undefined
        existing.lastLine = -1
      }
      return
    }
    const state: AttachedListener = {
      editor,
      resource,
      cursorSub: undefined as unknown as IDisposable,
      disposeSub: undefined as unknown as IDisposable,
      timer: undefined,
      lastResource: undefined,
      lastLine: -1,
    }
    state.cursorSub = editor.onDidChangeCursorPosition(() => {
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => this._flush(state), DEBOUNCE_MS)
    })
    state.disposeSub = editor.onDidDispose(() => {
      this._detach(state)
      this._listeners.delete(editor)
    })
    this._listeners.set(editor, state)
  }

  private _detach(state: AttachedListener): void {
    state.cursorSub.dispose()
    state.disposeSub.dispose()
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  private _flush(state: AttachedListener): void {
    state.timer = undefined
    const model = state.editor.getModel()
    if (!model) return
    // Significance is measured at the caret (the selection's active end), not
    // at the selection range: getSelection is directionless, so an upward drag
    // select (30 → 5) keeps endLine at 30 and would read as a zero-length move.
    const pos = state.editor.getPosition()
    const selection = this._readSelection(state.editor)
    if (!pos || !selection) return
    const uri = state.resource.toString()
    const fileChanged = uri !== state.lastResource
    const lineDelta = Math.abs(pos.lineNumber - state.lastLine)
    if (!fileChanged && lineDelta <= SIGNIFICANT_LINE_DELTA) {
      // Sub-threshold intra-file move: don't grow the stack, but slide the top
      // entry to the new selection so a subsequent far jump (go-to-definition)
      // puts this exact spot on the back stack. Without this, GoBack would skip
      // past the real jump origin to wherever the caret last crossed the
      // threshold (matches vscode, which replaces the current entry on small
      // moves).
      this._historyService.updateCurrent(state.resource, selection)
      state.lastLine = pos.lineNumber
      return
    }

    state.lastResource = uri
    state.lastLine = pos.lineNumber

    this._historyService.record({
      resource: state.resource,
      selection,
    })
  }

  /**
   * Read the editor's current selection as an IHistorySelection. Records the
   * full range (not just the caret) so GoBack can restore what the user had
   * selected; a collapsed selection is the caret. Falls back to the caret
   * position when there is no selection, and to null when there is neither.
   */
  private _readSelection(editor: MonacoLikeEditor): IHistorySelection | null {
    const selection = editor.getSelection()
    if (selection) {
      return {
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
      }
    }
    const pos = editor.getPosition()
    if (!pos) return null
    return {
      startLine: pos.lineNumber,
      startColumn: pos.column,
      endLine: pos.lineNumber,
      endColumn: pos.column,
    }
  }

  /** Flush the active editor's pending debounced move, if any, synchronously. */
  private _flushActiveEditor(): void {
    const active = this._editorService.activeEditor.get()
    if (!(active instanceof FileEditorInput)) return
    // Split views mount several Monaco instances for one input; prefer the
    // instance in the active group so the flush reads the editor the user is
    // looking at.
    const group = this._groupsService.activeGroup
    const editor = FileEditorRegistry.get(active, group.id) ?? FileEditorRegistry.get(active)
    if (!editor) return
    const state = this._listeners.get(editor)
    if (!state) return
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    this._flush(state)
  }

  /**
   * Pure observer of programmatic editor opens. Runs before monaco applies the
   * target selection, so the source's current selection is the jump origin —
   * record origin and target as consecutive entries so GoBack lands back on
   * the exact spot the jump began. Always returns null: the open itself must
   * proceed through the other registered handlers / monaco defaults untouched.
   */
  private async _onCodeEditorOpen(
    input: ICodeEditorOpenInput,
    source: monaco.editor.ICodeEditor | null,
  ): Promise<null> {
    if (!source || !input.options?.selection) return null
    // Editors outside the workbench (e.g. the peek's embedded preview) have no
    // attached cursor state and no history identity — skip them.
    const state = this._listeners.get(source as MonacoLikeEditor)
    if (!state) return null
    // Cancel a pending debounced flush: it would otherwise fire after the
    // target record and misorder the stack.
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    // The caret is the significance anchor (see _flush); the selection — full
    // range when the user had one — is the recorded payload.
    const originPos = source.getPosition()
    if (!originPos) return null
    const originRange = source.getSelection()
    const originSelection: IHistorySelection = originRange
      ? {
          startLine: originRange.startLineNumber,
          startColumn: originRange.startColumn,
          endLine: originRange.endLineNumber,
          endColumn: originRange.endColumn,
        }
      : {
          startLine: originPos.lineNumber,
          startColumn: originPos.column,
          endLine: originPos.lineNumber,
          endColumn: originPos.column,
        }
    // state.resource is the canonical EditorInput resource — monaco normalizes
    // Windows drive letters to lowercase on model URIs, which would split the
    // history identity of the same file.
    const originResource = state.resource
    state.lastResource = originResource.toString()
    state.lastLine = originPos.lineNumber
    // Same-file same-line origins fold into the existing top entry (record's
    // own collapse rule) — a no-op in the common F12-from-rest case.
    this._historyService.record({ resource: originResource, selection: originSelection })

    const targetUri = URI.parse(input.resource.toString())
    // Normalize to the already-open input's resource when the target is an
    // open tab, so the record key matches EditorInput.resource byte-for-byte.
    const targetResource =
      findExistingFileEditor(this._groupsService, this._uriIdentity, targetUri)?.editor.resource ??
      targetUri
    const targetSelection = input.options.selection
    this._historyService.record({
      resource: targetResource,
      selection:
        'startLineNumber' in targetSelection
          ? {
              startLine: targetSelection.startLineNumber,
              startColumn: targetSelection.startColumn,
              endLine: targetSelection.endLineNumber,
              endColumn: targetSelection.endColumn,
            }
          : {
              startLine: targetSelection.lineNumber,
              startColumn: targetSelection.column,
              endLine: targetSelection.lineNumber,
              endColumn: targetSelection.column,
            },
    })
    return null
  }
}
