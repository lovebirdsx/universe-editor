/**
 * Host-side mirror of the renderer's open text models, backing
 * `workspace.textDocuments` and the `onDidChangeTextDocument` family. The
 * renderer pushes the full text once on open, then incremental deltas on change
 * (VSCode parity — a multi-MB document must never re-cross the wire per edit);
 * this keeps a mutable `TextDocument` per URI and fires the matching events to
 * activated extensions.
 */
import { Emitter, URI, type Event } from '@universe-editor/platform'
import type {
  TextDocument,
  TextDocumentChangeEvent,
  TextDocumentContentChangeEvent,
  TextDocumentSaveReason,
  UriComponents,
  WillSaveTextDocumentEvent,
} from '@universe-editor/extension-api'
import type {
  TextDocumentContentChangeDto,
  WillSaveReason,
} from '@universe-editor/extensions-common'
import type { TextEdit } from 'vscode-languageserver-types'
import { TextDocument as FullTextDocument } from 'vscode-languageserver-textdocument'

/** Per-listener budget for `onWillSaveTextDocument` participants. A slow or
 *  hung listener must not block the save indefinitely — its edits are dropped
 *  once this elapses (mirrors VSCode's save-participant timeout). */
const WILL_SAVE_LISTENER_TIMEOUT_MS = 1_500

export class HostTextDocument implements TextDocument {
  /** Backing store: vscode-languageserver-textdocument applies incremental LSP
   *  changes with cached line offsets, so an edit costs O(edit), not O(doc). */
  private readonly _doc: FullTextDocument

  constructor(
    readonly uri: UriComponents,
    readonly languageId: string,
    version: number,
    text: string,
  ) {
    this._doc = FullTextDocument.create(
      URI.revive(uri)?.toString() ?? '',
      languageId,
      version,
      text,
    )
  }

  get version(): number {
    return this._doc.version
  }

  getText(): string {
    return this._doc.getText()
  }

  /** Apply incremental changes in array order (LSP semantics), in place. */
  update(changes: readonly TextDocumentContentChangeDto[], version: number): void {
    FullTextDocument.update(this._doc, [...changes], version)
  }
}

export class ExtHostDocuments {
  private readonly _docs = new Map<string, HostTextDocument>()

  private readonly _onDidOpen = new Emitter<TextDocument>()
  private readonly _onDidChange = new Emitter<TextDocumentChangeEvent>()
  private readonly _onDidClose = new Emitter<TextDocument>()
  private readonly _onWillSave = new Emitter<WillSaveTextDocumentEvent>()

  readonly onDidOpen: Event<TextDocument> = this._onDidOpen.event
  readonly onDidChange: Event<TextDocumentChangeEvent> = this._onDidChange.event
  readonly onDidClose: Event<TextDocument> = this._onDidClose.event
  readonly onWillSave: Event<WillSaveTextDocumentEvent> = this._onWillSave.event

  private _key(uri: UriComponents): string {
    return URI.revive(uri)?.toString() ?? ''
  }

  all(): readonly TextDocument[] {
    return [...this._docs.values()]
  }

  /** The mirrored document for `uri`, or undefined when not (yet) open. */
  get(uri: UriComponents): TextDocument | undefined {
    return this._docs.get(this._key(uri))
  }

  /**
   * Resolve the mirrored document for `uri`, waiting for its `didOpen` when it
   * has not arrived yet. The active-editor channel intentionally carries no
   * text, and the renderer's document push (activation + full-text open) can
   * land after the editor-change notification — this bridges that gap.
   * Resolves undefined when nothing opens within `timeoutMs`.
   */
  whenOpen(uri: UriComponents, timeoutMs: number): Promise<TextDocument | undefined> {
    const key = this._key(uri)
    const existing = this._docs.get(key)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose()
        resolve(undefined)
      }, timeoutMs)
      const sub = this.onDidOpen((doc) => {
        if (this._key(doc.uri) !== key) return
        clearTimeout(timer)
        sub.dispose()
        resolve(doc)
      })
    })
  }

  /** The mirrored document for `uri`, or a synthetic empty one (providers only
   *  need its URI to forward to the LSP server, which holds the real text). */
  getOrSynthesize(uri: UriComponents): TextDocument {
    return this._docs.get(this._key(uri)) ?? new HostTextDocument(uri, '', 0, '')
  }

  acceptOpen(uri: UriComponents, languageId: string, version: number, text: string): void {
    const doc = new HostTextDocument(uri, languageId, version, text)
    this._docs.set(this._key(uri), doc)
    this._onDidOpen.fire(doc)
  }

  acceptChange(
    uri: UriComponents,
    version: number,
    changes: readonly TextDocumentContentChangeDto[],
  ): void {
    const doc = this._docs.get(this._key(uri))
    // A delta without a prior open can't be applied — drop it (the renderer
    // always opens before it pushes changes; this only guards a host relaunch race).
    if (!doc) return
    doc.update(changes, version)
    this._onDidChange.fire({
      document: doc,
      contentChanges: changes as readonly TextDocumentContentChangeEvent[],
    })
  }

  acceptClose(uri: UriComponents): void {
    const key = this._key(uri)
    const doc = this._docs.get(key)
    this._docs.delete(key)
    if (doc) this._onDidClose.fire(doc)
  }

  /**
   * Run every `onWillSaveTextDocument` listener for a pending save and collect
   * the text edits they contribute. Each listener calls `waitUntil(thenable)`
   * synchronously inside the event dispatch; we await those thenables here (each
   * bounded by {@link WILL_SAVE_LISTENER_TIMEOUT_MS}) and concatenate their edits
   * in registration order. A listener that throws, rejects, or times out simply
   * contributes nothing — a broken participant never blocks the save.
   */
  async provideWillSaveEdits(uri: UriComponents, reason: WillSaveReason): Promise<TextEdit[]> {
    const doc = this.getOrSynthesize(uri)
    const thenables: Promise<TextEdit[]>[] = []
    const event: WillSaveTextDocumentEvent = {
      document: doc,
      reason: reason as unknown as TextDocumentSaveReason,
      waitUntil: (thenable) => {
        thenables.push(thenable)
      },
    }
    // Fire synchronously so every listener registers its waitUntil before we await.
    this._onWillSave.fire(event)
    if (thenables.length === 0) return []

    const results = await Promise.all(thenables.map((t) => withTimeout(t)))
    return results.flat()
  }
}

/** Await a save-participant thenable, resolving to `[]` if it rejects or exceeds
 *  {@link WILL_SAVE_LISTENER_TIMEOUT_MS}. Never rejects — a bad participant is
 *  isolated, not propagated into the save. */
async function withTimeout(thenable: Promise<TextEdit[]>): Promise<TextEdit[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TextEdit[]>((resolve) => {
    timer = setTimeout(() => resolve([]), WILL_SAVE_LISTENER_TIMEOUT_MS)
  })
  try {
    return await Promise.race([thenable.then((edits) => edits ?? []), timeout])
  } catch {
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}
