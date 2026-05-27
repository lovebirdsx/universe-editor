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
  IContextKeyService,
  IHistoryService,
  IWorkbenchContribution,
  URI,
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

    this._register(
      FileEditorRegistry.onDidChange((input) => {
        if (!(input instanceof FileEditorInput)) return
        const editor = FileEditorRegistry.get(input)
        if (editor) this._attach(editor)
      }),
    )

    this._register(
      toDisposable(() => {
        for (const listener of this._listeners.values()) this._detach(listener)
        this._listeners.clear()
      }),
    )
  }

  private _attach(editor: MonacoLikeEditor): void {
    if (this._listeners.has(editor)) return
    const state: AttachedListener = {
      editor,
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
    const uri = model.uri.toString()
    const fileChanged = uri !== state.lastResource
    const lineDelta = Math.abs(pos.lineNumber - state.lastLine)
    if (!fileChanged && lineDelta <= SIGNIFICANT_LINE_DELTA) return

    state.lastResource = uri
    state.lastLine = pos.lineNumber

    this._historyService.record({
      resource: URI.parse(uri),
      selection: {
        startLine: pos.lineNumber,
        startColumn: pos.column,
        endLine: pos.lineNumber,
        endColumn: pos.column,
      },
    })
  }
}
