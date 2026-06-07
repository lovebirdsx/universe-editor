/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The renderer ↔ server document bridge for markdown. Two directions:
 *    - push: open editor content (didOpen/didChange/didClose) so the server's
 *      overlay reflects unsaved edits (files the user hasn't opened are read from
 *      disk by the server itself). Full-text, debounced — markdown is small.
 *    - pull: after each push settles, fetch the server's diagnostics and reflect
 *      them as Monaco markers (broken links etc.). Diagnostics are pulled *after*
 *      the matching didChange resolves so the server has the current text.
 *  Lazily starts the server on first markdown document touch.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  DisposableStore,
  IEditorService,
  IWorkspaceService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { languageForResource } from '../workbench/files/resourceLanguage.js'
import { mdDiagnosticToMarker } from '../services/languageFeatures/markdown/lspMonacoConvert.js'
import { IMarkdownLanguageService } from '../../shared/ipc/markdownLanguageService.js'

const DIDCHANGE_DEBOUNCE_MS = 200
/** Marker owner namespace for setModelMarkers — scopes our diagnostics. */
const MARKER_OWNER = 'markdown'

interface OpenDoc {
  readonly store: DisposableStore
  readonly model: monaco.editor.ITextModel
  timer?: ReturnType<typeof setTimeout> | undefined
}

export class MarkdownDocumentSyncContribution extends Disposable implements IWorkbenchContribution {
  /** Synced documents, keyed by model URI string. Kept open across editor switches. */
  private readonly _open = new Map<string, OpenDoc>()

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IMarkdownLanguageService private readonly _md: IMarkdownLanguageService,
  ) {
    super()
    this._register(
      autorun((r) => {
        this._editorService.activeEditor.read(r)
        this._sync()
      }),
    )
    // Monaco mounts asynchronously after the input becomes active.
    this._register(FileEditorRegistry.onDidChange(() => this._sync()))
    // The server keeps no document text, so after any respawn (crash recovery or
    // workspace change) we must re-push every open document.
    this._register(this._md.onDidRestart(() => this._resyncAll()))
    // Switching workspaces in place restarts the server for the new root.
    this._register(
      this._workspace.onDidChangeWorkspace((ws) => {
        void this._md.ensureStarted(ws ? ws.folder.fsPath : undefined)
      }),
    )
  }

  private _sync(): void {
    const input = this._editorService.activeEditor.get()
    if (!(input instanceof FileEditorInput)) return
    if (languageForResource(input.resource) !== 'markdown') return

    const key = input.resource.toString()
    if (this._open.has(key)) return

    const editor = FileEditorRegistry.get(input)
    const model = editor?.getModel() ?? MonacoModelRegistry.peek(input.resource)
    if (!model) return // not mounted yet; FileEditorRegistry.onDidChange will retry

    this._attach(key, model)
  }

  private _attach(key: string, model: monaco.editor.ITextModel): void {
    const store = this._register(new DisposableStore())
    const entry: OpenDoc = { store, model }
    this._open.set(key, entry)

    const root = this._workspace.current?.folder
    void this._md.ensureStarted(root ? root.fsPath : undefined).then(async () => {
      if (model.isDisposed()) return
      await this._md.didOpen(model.uri, model.getVersionId(), model.getValue())
      await this._refreshDiagnostics(model)
    })

    store.add(
      model.onDidChangeContent(() => {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          void this._pushChange(model)
        }, DIDCHANGE_DEBOUNCE_MS)
      }),
    )
    store.add(model.onWillDispose(() => this._detach(key)))
  }

  private async _pushChange(model: monaco.editor.ITextModel): Promise<void> {
    if (model.isDisposed()) return
    await this._md.didChange(model.uri, model.getVersionId(), model.getValue())
    await this._refreshDiagnostics(model)
  }

  /** Re-push every open document after a server respawn (it lost its overlay). */
  private _resyncAll(): void {
    for (const entry of this._open.values()) {
      const model = entry.model
      if (model.isDisposed()) continue
      void (async () => {
        await this._md.didOpen(model.uri, model.getVersionId(), model.getValue())
        await this._refreshDiagnostics(model)
      })()
    }
  }

  /** Pull diagnostics for `model` and reflect them as Monaco markers. */
  private async _refreshDiagnostics(model: monaco.editor.ITextModel): Promise<void> {
    const diagnostics = await this._md.provideDiagnostics(model.uri)
    if (model.isDisposed()) return
    const monacoNs = MonacoLoader.get()
    const markers = diagnostics.map((d) => mdDiagnosticToMarker(d, monacoNs))
    monacoNs.editor.setModelMarkers(model, MARKER_OWNER, markers)
  }

  private _detach(key: string): void {
    const entry = this._open.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this._open.delete(key)
    if (!entry.model.isDisposed()) {
      MonacoLoader.get().editor.setModelMarkers(entry.model, MARKER_OWNER, [])
    }
    void this._md.didClose(entry.model.uri)
    entry.store.dispose()
  }

  override dispose(): void {
    for (const key of [...this._open.keys()]) this._detach(key)
    super.dispose()
  }
}
