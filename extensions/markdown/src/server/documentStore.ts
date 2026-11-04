/**
 * In-memory overlay of the documents the renderer has open. The language
 * service reads these in preference to disk (an open editor is the source of
 * truth for its file); closing drops the overlay so reads fall back to disk.
 */
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Emitter, type Event } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import type { ITextDocument } from 'vscode-markdown-languageservice'

const LANGUAGE_ID = 'markdown'

/** Build an ITextDocument the language service accepts (TextDocument + `$uri`). */
export function makeDoc(uri: string, version: number, text: string): ITextDocument {
  const doc = TextDocument.create(uri, LANGUAGE_ID, version, text)
  // The language service uses `$uri` as a fast path; attach the parsed URI.
  ;(doc as ITextDocument & { $uri?: URI }).$uri = URI.parse(uri)
  return doc as ITextDocument
}

export class DocumentStore {
  private readonly _docs = new Map<string, ITextDocument>()

  private readonly _onDidChange = new Emitter<ITextDocument>()
  private readonly _onDidCreate = new Emitter<ITextDocument>()
  private readonly _onDidDelete = new Emitter<URI>()

  readonly onDidChange: Event<ITextDocument> = this._onDidChange.event
  readonly onDidCreate: Event<ITextDocument> = this._onDidCreate.event
  readonly onDidDelete: Event<URI> = this._onDidDelete.event

  open(uri: string, version: number, text: string): void {
    const existed = this._docs.has(uri)
    const doc = makeDoc(uri, version, text)
    this._docs.set(uri, doc)
    // LS 的文档缓存不监听 create，首次打开也须通过 change 替换旧磁盘缓存。
    if (!existed) this._onDidCreate.fire(doc)
    this._onDidChange.fire(doc)
  }

  change(uri: string, version: number, text: string): void {
    const doc = makeDoc(uri, version, text)
    this._docs.set(uri, doc)
    this._onDidChange.fire(doc)
  }

  /** Drop the editor overlay. Does NOT fire delete — the file still exists on disk. */
  close(uri: string): void {
    this._docs.delete(uri)
  }

  /** 外部变更或闭态按需读盘后刷新 LS 缓存，不创建 overlay。 */
  notifyDiskChange(doc: ITextDocument): void {
    this._onDidChange.fire(doc)
  }

  notifyDiskDelete(uri: URI): void {
    this._onDidDelete.fire(uri)
  }

  get(uri: string): ITextDocument | undefined {
    return this._docs.get(uri)
  }

  has(uri: string): boolean {
    return this._docs.has(uri)
  }

  all(): readonly ITextDocument[] {
    return [...this._docs.values()]
  }
}
