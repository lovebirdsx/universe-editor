/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HistoryContribution — wires IHistoryService into the renderer:
 *    1. Per-file Monaco cursor listeners (250ms debounce, significance
 *       threshold: file changed OR line delta > 10) that call
 *       historyService.record on meaningful navigation.
 *    2. Two ContextKeys (canGoBack / canGoForward) driven by onDidChange so
 *       GoBackAction / GoForwardAction precondition expressions resolve.
 *
 *  Cursor listeners attach once per Monaco editor instance via
 *  FileEditorRegistry.onDidChange and detach via the editor's own
 *  onDidDispose.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  EditorInput,
  IContextKeyService,
  IEditorService,
  IHistoryService,
  IStorageService,
  IWorkbenchContribution,
  URI,
  autorun,
  toDisposable,
  type IDisposable,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'

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
    @IEditorService editorService: IEditorService,
    @IStorageService storageService: IStorageService,
  ) {
    super()

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
        const active = editorService.activeEditor.read(reader)
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
    if (!pos) return
    if (state) {
      state.lastResource = input.resource.toString()
      state.lastLine = pos.lineNumber
    }
    this._historyService.updateCurrent(input.resource, {
      startLine: pos.lineNumber,
      startColumn: pos.column,
      endLine: pos.lineNumber,
      endColumn: pos.column,
    })
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
    const pos = state.editor.getPosition()
    if (!pos) return
    const uri = state.resource.toString()
    const fileChanged = uri !== state.lastResource
    const lineDelta = Math.abs(pos.lineNumber - state.lastLine)
    if (!fileChanged && lineDelta <= SIGNIFICANT_LINE_DELTA) {
      // Sub-threshold intra-file move: don't grow the stack, but slide the top
      // entry to the new caret so a subsequent far jump (go-to-definition) puts
      // this exact spot on the back stack. Without this, GoBack would skip past
      // the real jump origin to wherever the caret last crossed the threshold
      // (matches vscode, which replaces the current entry on small moves).
      this._historyService.updateCurrent(state.resource, {
        startLine: pos.lineNumber,
        startColumn: pos.column,
        endLine: pos.lineNumber,
        endColumn: pos.column,
      })
      state.lastLine = pos.lineNumber
      return
    }

    state.lastResource = uri
    state.lastLine = pos.lineNumber

    this._historyService.record({
      resource: state.resource,
      selection: {
        startLine: pos.lineNumber,
        startColumn: pos.column,
        endLine: pos.lineNumber,
        endColumn: pos.column,
      },
    })
  }
}
