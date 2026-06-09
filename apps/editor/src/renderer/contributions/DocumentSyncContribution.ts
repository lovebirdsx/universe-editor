/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mirrors open editor documents into the trusted extension host so language
 *  plugins see `workspace.textDocuments` and the `onDidChangeTextDocument` family.
 *  Pushes full text (debounced) on open/change/close for the active editor, and
 *  fires `onLanguage:<id>` activation so a plugin lazily starts on first touch.
 *  Generic counterpart to VSCode's ExtHostDocuments wiring; markdown keeps its own
 *  direct-to-LSP sync, so the two paths coexist.
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
import { languageActivationEvent } from '@universe-editor/extensions-common'
import { type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { basenameOfResource, extensionOfBasename } from '../workbench/files/resourceInfo.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'

const DIDCHANGE_DEBOUNCE_MS = 200

/** File extension → LSP languageId where it diverges from Monaco's model id.
 *  Notably .tsx/.jsx must carry the React variant so tsserver enables JSX (the
 *  Monaco model id collapses .tsx → 'typescript'). */
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

function resolveLanguageId(resource: URI, model: monaco.editor.ITextModel): string {
  const ext = extensionOfBasename(basenameOfResource(resource))
  return (ext ? LSP_LANGUAGE_BY_EXT[ext] : undefined) ?? model.getLanguageId()
}

interface OpenDoc {
  readonly store: DisposableStore
  readonly model: monaco.editor.ITextModel
  readonly languageId: string
  timer?: ReturnType<typeof setTimeout> | undefined
}

export class DocumentSyncContribution extends Disposable implements IWorkbenchContribution {
  /** Synced documents, keyed by model URI string. Kept open across editor switches. */
  private readonly _open = new Map<string, OpenDoc>()
  /** Languages already activated this host generation; reset on host relaunch. */
  private readonly _activated = new Set<string>()

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
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
    // The host pins the workspace at launch and relaunches on a folder swap; its
    // fresh ExtHostDocuments is empty, so re-push every open document afterwards.
    this._register(this._workspace.onDidChangeWorkspace(() => this._resyncAll()))
  }

  private _sync(): void {
    const input = this._editorService.activeEditor.get()
    if (!(input instanceof FileEditorInput)) return

    const editor = FileEditorRegistry.get(input)
    const model = editor?.getModel() ?? MonacoModelRegistry.peek(input.resource)
    if (!model) return // not mounted yet; FileEditorRegistry.onDidChange will retry

    const key = model.uri.toString()
    if (this._open.has(key)) return
    this._attach(key, model, resolveLanguageId(input.resource, model))
  }

  private _attach(key: string, model: monaco.editor.ITextModel, languageId: string): void {
    const store = this._register(new DisposableStore())
    const entry: OpenDoc = { store, model, languageId }
    this._open.set(key, entry)
    void this._openDoc(entry)

    store.add(
      model.onDidChangeContent(() => {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          this._ignore(this._pushChange(model))
        }, DIDCHANGE_DEBOUNCE_MS)
      }),
    )
    store.add(model.onWillDispose(() => this._detach(key)))
  }

  private async _openDoc(entry: OpenDoc): Promise<void> {
    await this._activate(entry.languageId)
    const documents = this._client.getTrustedDocuments()
    if (!documents || entry.model.isDisposed()) return
    this._ignore(
      documents.$acceptDocumentOpen(
        entry.model.uri,
        entry.languageId,
        entry.model.getVersionId(),
        entry.model.getValue(),
      ),
    )
  }

  /** Activate plugins for a language once per host generation (before pushing the
   *  document, so a plugin's `onDidOpenTextDocument` listener is already attached). */
  private async _activate(languageId: string): Promise<void> {
    if (this._activated.has(languageId)) return
    this._activated.add(languageId)
    await this._client.activateByEvent(languageActivationEvent(languageId))
  }

  private async _pushChange(model: monaco.editor.ITextModel): Promise<void> {
    if (model.isDisposed()) return
    const documents = this._client.getTrustedDocuments()
    if (!documents) return
    await documents.$acceptDocumentChange(model.uri, model.getVersionId(), model.getValue())
  }

  /** Re-push every open document after a host relaunch (its mirror was reset). */
  private _resyncAll(): void {
    this._activated.clear()
    for (const entry of this._open.values()) {
      if (!entry.model.isDisposed()) void this._openDoc(entry)
    }
  }

  /** Swallow IPC rejections on fire-and-forget notifications (e.g. the channel
   *  closing during shutdown) so they never surface as unhandled rejections. */
  private _ignore(p: Promise<unknown>): void {
    void p.catch(() => undefined)
  }

  private _detach(key: string): void {
    const entry = this._open.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this._open.delete(key)
    const documents = this._client.getTrustedDocuments()
    if (documents) this._ignore(documents.$acceptDocumentClose(entry.model.uri))
    entry.store.dispose()
  }

  override dispose(): void {
    for (const key of [...this._open.keys()]) this._detach(key)
    super.dispose()
  }
}
