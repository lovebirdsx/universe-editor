/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PendingDocumentSync — lets a language-provider call force the extension host's
 *  mirror of a document up to date before it runs.
 *
 *  DocumentSyncContribution debounces `onDidChangeContent` by 200ms before
 *  pushing text to the host. A completion request, however, fires *immediately*
 *  on a trigger character (e.g. `#` in a markdown link): without a flush the host
 *  still holds the pre-keystroke text, so the language service parses a stale line
 *  and returns nothing. The contribution registers a per-URI `flush` here; the
 *  completion proxy awaits it so the host sees the just-typed character first.
 *--------------------------------------------------------------------------------------------*/

/** Flush any debounced pending change for `uri` to the host; resolves once sent. */
type Flush = () => Promise<void>

class PendingDocumentSyncImpl {
  private readonly _flushers = new Map<string, Flush>()

  register(uri: string, flush: Flush): void {
    this._flushers.set(uri, flush)
  }

  unregister(uri: string): void {
    this._flushers.delete(uri)
  }

  /** Await the pending flush for `uri` (no-op when the document isn't tracked). */
  async flush(uri: string): Promise<void> {
    await this._flushers.get(uri)?.()
  }
}

export const PendingDocumentSync = new PendingDocumentSyncImpl()
