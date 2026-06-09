/**
 * Host-side mirror of the renderer's open text models, backing
 * `workspace.textDocuments` and the `onDidChangeTextDocument` family. The
 * renderer pushes full text on open/change over `extHostDocuments`; this keeps a
 * `TextDocument` per URI and fires the matching events to activated extensions.
 */
import { Emitter, URI, type Event } from '@universe-editor/platform'
import type {
  TextDocument,
  TextDocumentChangeEvent,
  UriComponents,
} from '@universe-editor/extension-api'

export class HostTextDocument implements TextDocument {
  constructor(
    readonly uri: UriComponents,
    readonly languageId: string,
    readonly version: number,
    private readonly _text: string,
  ) {}

  getText(): string {
    return this._text
  }
}

export class ExtHostDocuments {
  private readonly _docs = new Map<string, TextDocument>()

  private readonly _onDidOpen = new Emitter<TextDocument>()
  private readonly _onDidChange = new Emitter<TextDocumentChangeEvent>()
  private readonly _onDidClose = new Emitter<TextDocument>()

  readonly onDidOpen: Event<TextDocument> = this._onDidOpen.event
  readonly onDidChange: Event<TextDocumentChangeEvent> = this._onDidChange.event
  readonly onDidClose: Event<TextDocument> = this._onDidClose.event

  private _key(uri: UriComponents): string {
    return URI.revive(uri)?.toString() ?? ''
  }

  all(): readonly TextDocument[] {
    return [...this._docs.values()]
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

  acceptChange(uri: UriComponents, version: number, text: string): void {
    const key = this._key(uri)
    const languageId = this._docs.get(key)?.languageId ?? ''
    const doc = new HostTextDocument(uri, languageId, version, text)
    this._docs.set(key, doc)
    this._onDidChange.fire({ document: doc })
  }

  acceptClose(uri: UriComponents): void {
    const key = this._key(uri)
    const doc = this._docs.get(key)
    this._docs.delete(key)
    if (doc) this._onDidClose.fire(doc)
  }
}
