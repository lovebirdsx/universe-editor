/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The renderer ↔ server document bridge for TS/JS. Pushes open editor content
 *  (didOpen/didChange/didClose, full-text debounced) so tsserver's overlay
 *  reflects unsaved edits; files the user hasn't opened are read from disk by the
 *  server itself. Diagnostics are PUSH — the server emits publishDiagnostics on
 *  its own schedule, which we reflect as Monaco markers (red squiggles). Lazily
 *  starts the server on first TS/JS document touch.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  DisposableStore,
  IEditorService,
  IWorkspaceService,
  URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { basenameOfResource, extensionOfBasename } from '../workbench/files/resourceInfo.js'
import { diagnosticToMarker } from '../services/languageFeatures/typescript/lspMonacoConvert.js'
import { ITypescriptLanguageService } from '../../shared/ipc/typescriptLanguageService.js'

const DIDCHANGE_DEBOUNCE_MS = 200
/** Marker owner namespace for setModelMarkers — scopes our diagnostics. */
const MARKER_OWNER = 'typescript'

/** File extension → LSP languageId. Distinguishes JSX so tsserver enables it
 *  (the editor's Monaco model id collapses .tsx → 'typescript'). */
const LSP_LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascriptreact',
}

function tsLanguageId(resource: URI): string | undefined {
  const ext = extensionOfBasename(basenameOfResource(resource))
  return ext ? LSP_LANGUAGE_BY_EXT[ext] : undefined
}

interface OpenDoc {
  readonly store: DisposableStore
  readonly model: monaco.editor.ITextModel
  readonly languageId: string
  timer?: ReturnType<typeof setTimeout> | undefined
}

export class TypescriptDocumentSyncContribution
  extends Disposable
  implements IWorkbenchContribution
{
  /** Synced documents, keyed by model URI string. Kept open across editor switches. */
  private readonly _open = new Map<string, OpenDoc>()

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @ITypescriptLanguageService private readonly _ts: ITypescriptLanguageService,
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
    // Server-pushed diagnostics → Monaco markers.
    this._register(
      this._ts.onDidPublishDiagnostics((e) => {
        const resource = URI.revive(e.uri) as URI
        const model = MonacoModelRegistry.peek(resource)
        if (!model || model.isDisposed()) return
        const monacoNs = MonacoLoader.get()
        const markers = e.diagnostics.map((d) => diagnosticToMarker(d, monacoNs))
        monacoNs.editor.setModelMarkers(model, MARKER_OWNER, markers)
      }),
    )
    // The server keeps no document text, so after any respawn (crash recovery or
    // workspace change) we must re-push every open document; it then re-publishes.
    this._register(this._ts.onDidRestart(() => this._resyncAll()))
    // Switching workspaces in place restarts the server for the new root.
    this._register(
      this._workspace.onDidChangeWorkspace((ws) => {
        void this._ts.ensureStarted(ws ? ws.folder.fsPath : undefined)
      }),
    )
  }

  private _sync(): void {
    const input = this._editorService.activeEditor.get()
    if (!(input instanceof FileEditorInput)) return
    const languageId = tsLanguageId(input.resource)
    if (!languageId) return

    const editor = FileEditorRegistry.get(input)
    const model = editor?.getModel() ?? MonacoModelRegistry.peek(input.resource)
    if (!model) return // not mounted yet; FileEditorRegistry.onDidChange will retry

    const key = model.uri.toString()
    if (this._open.has(key)) return
    this._attach(key, model, languageId)
  }

  private _attach(key: string, model: monaco.editor.ITextModel, languageId: string): void {
    const store = this._register(new DisposableStore())
    const entry: OpenDoc = { store, model, languageId }
    this._open.set(key, entry)

    const root = this._workspace.current?.folder
    void this._ts.ensureStarted(root ? root.fsPath : undefined).then(() => {
      if (model.isDisposed()) return
      void this._ts.didOpen(model.uri, languageId, model.getVersionId(), model.getValue())
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
    await this._ts.didChange(model.uri, model.getVersionId(), model.getValue())
  }

  /** Re-push every open document after a server respawn (it lost its overlay). */
  private _resyncAll(): void {
    for (const entry of this._open.values()) {
      const model = entry.model
      if (model.isDisposed()) continue
      void this._ts.didOpen(model.uri, entry.languageId, model.getVersionId(), model.getValue())
    }
  }

  private _detach(key: string): void {
    const entry = this._open.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this._open.delete(key)
    if (!entry.model.isDisposed()) {
      MonacoLoader.get().editor.setModelMarkers(entry.model, MARKER_OWNER, [])
    }
    void this._ts.didClose(entry.model.uri)
    entry.store.dispose()
  }

  override dispose(): void {
    for (const key of [...this._open.keys()]) this._detach(key)
    super.dispose()
  }
}
