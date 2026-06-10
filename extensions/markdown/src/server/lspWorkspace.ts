/**
 * IWorkspace implementation backing the markdown language service. Open documents
 * come from the {@link DocumentStore} overlay; everything else is read from disk
 * via the filesystem port (IMdClient), which the plugin backs with the gated
 * `workspace.fs`.
 */
import type { Event } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import type { FileStat, ITextDocument, IWorkspace } from 'vscode-markdown-languageservice'
import type { IMdClient } from './types.js'
import { DocumentStore, makeDoc } from './documentStore.js'

export class LspWorkspace implements IWorkspace {
  constructor(
    private readonly _store: DocumentStore,
    private readonly _root: URI | undefined,
    private readonly _client: IMdClient,
  ) {}

  get workspaceFolders(): readonly URI[] {
    return this._root ? [this._root] : []
  }

  get onDidChangeMarkdownDocument(): Event<ITextDocument> {
    return this._store.onDidChange
  }

  get onDidCreateMarkdownDocument(): Event<ITextDocument> {
    return this._store.onDidCreate
  }

  get onDidDeleteMarkdownDocument(): Event<URI> {
    return this._store.onDidDelete
  }

  async getAllMarkdownDocuments(): Promise<Iterable<ITextDocument>> {
    const result = new Map<string, ITextDocument>()
    for (const doc of this._store.all()) result.set(doc.uri, doc)

    const files = await this._client.$findMarkdownFiles()
    for (const file of files) {
      if (result.has(file)) continue
      const doc = await this.openMarkdownDocument(URI.parse(file))
      if (doc) result.set(file, doc)
    }
    return result.values()
  }

  hasMarkdownDocument(resource: URI): boolean {
    return this._store.has(resource.toString())
  }

  async openMarkdownDocument(resource: URI): Promise<ITextDocument | undefined> {
    const key = resource.toString()
    const open = this._store.get(key)
    if (open) return open
    const text = await this._client.$readFile(key)
    if (text === undefined) return undefined
    return makeDoc(key, 0, text)
  }

  async stat(resource: URI): Promise<FileStat | undefined> {
    const stat = await this._client.$stat(resource.toString())
    return stat ? { isDirectory: stat.type === 'dir' } : undefined
  }

  async readDirectory(resource: URI): Promise<Iterable<readonly [string, FileStat]>> {
    const entries = await this._client.$readDirectory(resource.toString())
    return entries.map(([name, type]) => [name, { isDirectory: type === 'dir' }] as const)
  }
}
