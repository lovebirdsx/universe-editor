/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mirrors open editor documents into the trusted extension host so language
 *  plugins see `workspace.textDocuments` and the `onDidChangeTextDocument` family.
 *  Pushes the full text once on open, then debounced INCREMENTAL deltas on change
 *  (VSCode parity: a multi-MB document must never re-cross the wire per edit),
 *  and fires `onLanguage:<id>` activation so a plugin lazily starts on first touch.
 *  Generic counterpart to VSCode's ExtHostDocuments wiring; every built-in
 *  language plugin (typescript, markdown, …) consumes this single path.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  DisposableStore,
  IEditorService,
  ILoggerService,
  IWorkspaceService,
  URI,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  languageActivationEvent,
  type TextDocumentContentChangeDto,
} from '@universe-editor/extensions-common'
import { type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { basenameOfResource, extensionOfBasename } from '../workbench/files/resourceInfo.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { PendingDocumentSync } from '../services/extensions/PendingDocumentSync.js'
import { monacoChangesToContentChanges } from '../services/extensions/documentSyncChanges.js'

const DIDCHANGE_DEBOUNCE_MS = 200

/** Above this many characters, open/flush pushes get an info log with timings so
 *  a large-document stall is attributable in the Output panel. */
const LARGE_DOC_LOG_THRESHOLD = 1024 * 1024

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
  /** True once $acceptDocumentOpen was sent; deltas are held back until then. */
  opened: boolean
  /** Deltas accumulated since the last flush, in event order. */
  pending: TextDocumentContentChangeDto[]
  /** A model flush (setValue / file reload) voids the deltas: send full text. */
  pendingFlush: boolean
}

export class DocumentSyncContribution extends Disposable implements IWorkbenchContribution {
  /** Synced documents, keyed by model URI string. Kept open across editor switches. */
  private readonly _open = new Map<string, OpenDoc>()
  /** Languages already activated this host generation; reset on host relaunch. */
  private readonly _activated = new Set<string>()
  private readonly _logger: ILogger

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'docSync', name: 'Document Sync' })
    this._register(
      autorun((r) => {
        this._editorService.activeEditor.read(r)
        this._sync()
      }),
    )
    // Monaco mounts asynchronously after the input becomes active.
    this._register(FileEditorRegistry.onDidChange(() => this._sync()))
    // A markdown preview reached via a link acquires its source model on demand
    // (async), after the active-editor autorun already ran and found none. Sync
    // when that model appears so the language service sees the document.
    this._register(MonacoModelRegistry.onDidAddModel(() => this._sync()))
    // The host pins the workspace at launch and relaunches on a folder swap; its
    // fresh ExtHostDocuments is empty, so re-push every open document afterwards.
    this._register(this._workspace.onDidChangeWorkspace(() => this._resyncAll()))
  }

  private _sync(): void {
    const input = this._editorService.activeEditor.get()

    // A markdown preview has no model of its own; mirror its source file's shared
    // model so language plugins see the document and the Outline view fills in.
    if (input instanceof MarkdownPreviewInput) {
      const model = MonacoModelRegistry.peek(input.sourceUri)
      if (!model) return
      const key = model.uri.toString()
      if (this._open.has(key)) return
      this._attach(key, model, resolveLanguageId(input.sourceUri, model))
      return
    }

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
    const entry: OpenDoc = {
      store,
      model,
      languageId,
      opened: false,
      pending: [],
      pendingFlush: false,
    }
    this._open.set(key, entry)
    // _openDoc captures its text snapshot synchronously before the first await,
    // so a change firing after this line lands in `pending` and applies cleanly
    // on top of the snapshot — never double-counted, never lost.
    void this._openDoc(entry)

    store.add(
      model.onDidChangeContent((e) => {
        if (e.isFlush) {
          // The model was reset wholesale (file reload, programmatic setValue):
          // there is no meaningful delta, fall back to one full-text push.
          entry.pending = []
          entry.pendingFlush = true
        } else if (!entry.pendingFlush) {
          entry.pending.push(...monacoChangesToContentChanges(e.changes))
        }
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          this._ignore(this._pushChange(entry))
        }, DIDCHANGE_DEBOUNCE_MS)
      }),
    )
    store.add(model.onWillDispose(() => this._detach(key)))

    // Let a completion (which fires immediately on a trigger char) force the
    // host's mirror current before it runs, beating the 200ms debounce above.
    PendingDocumentSync.register(key, () => this._flush(entry))
  }

  /** If a debounced change is pending for `entry`, cancel the timer and push now. */
  private async _flush(entry: OpenDoc): Promise<void> {
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
    await this._pushChange(entry)
  }

  private async _openDoc(entry: OpenDoc): Promise<void> {
    // Snapshot before the first await: deltas accumulating during activation are
    // relative to exactly this state.
    entry.opened = false
    entry.pending = []
    entry.pendingFlush = false
    if (entry.model.isDisposed()) return
    const started = performance.now()
    const text = entry.model.getValue()
    const version = entry.model.getVersionId()
    const snapshotMs = performance.now() - started

    await this._activate(entry.languageId)
    const documents = this._client.getDocuments()
    if (!documents || entry.model.isDisposed()) return
    const sendStarted = performance.now()
    try {
      await documents.$acceptDocumentOpen(entry.model.uri, entry.languageId, version, text)
    } catch {
      return // channel closing during shutdown — nothing to sync
    }
    if (text.length > LARGE_DOC_LOG_THRESHOLD) {
      this._logger.info(
        `didOpen ${entry.model.uri.toString()} chars=${text.length} snapshot=${snapshotMs.toFixed(1)}ms send=${(performance.now() - sendStarted).toFixed(1)}ms`,
      )
    }
    entry.opened = true
    // Deltas that arrived while activation/open were in flight apply on top now.
    if (entry.pending.length > 0 || entry.pendingFlush) {
      this._ignore(this._pushChange(entry))
    }
  }

  /** Activate plugins for a language once per host generation (before pushing the
   *  document, so a plugin's `onDidOpenTextDocument` listener is already attached). */
  private async _activate(languageId: string): Promise<void> {
    if (this._activated.has(languageId)) return
    this._activated.add(languageId)
    await this._client.activateByEvent(languageActivationEvent(languageId))
  }

  private async _pushChange(entry: OpenDoc): Promise<void> {
    const { model } = entry
    if (model.isDisposed()) return
    // Until the open snapshot is on the wire the deltas have no base to apply to;
    // _openDoc flushes them right after the open lands.
    if (!entry.opened) return
    const documents = this._client.getDocuments()
    if (!documents) {
      // Host gone: drop the backlog, _resyncAll re-opens with fresh full text.
      entry.pending = []
      entry.pendingFlush = false
      return
    }
    const changes: TextDocumentContentChangeDto[] = entry.pendingFlush
      ? [{ text: model.getValue() }]
      : entry.pending
    entry.pending = []
    entry.pendingFlush = false
    if (changes.length === 0) return
    const version = model.getVersionId()
    const payloadChars = changes.reduce((sum, c) => sum + c.text.length, 0)
    const started = performance.now()
    await documents.$acceptDocumentChange(model.uri, version, changes)
    if (payloadChars > LARGE_DOC_LOG_THRESHOLD) {
      this._logger.info(
        `didChange ${model.uri.toString()} changes=${changes.length} chars=${payloadChars} send=${(performance.now() - started).toFixed(1)}ms`,
      )
    }
  }

  /** Re-push every open document after a host relaunch (its mirror was reset). */
  private _resyncAll(): void {
    this._activated.clear()
    for (const entry of this._open.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
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
    PendingDocumentSync.unregister(key)
    const documents = this._client.getDocuments()
    if (documents) this._ignore(documents.$acceptDocumentClose(entry.model.uri))
    entry.store.dispose()
  }

  override dispose(): void {
    for (const key of [...this._open.keys()]) this._detach(key)
    super.dispose()
  }
}
