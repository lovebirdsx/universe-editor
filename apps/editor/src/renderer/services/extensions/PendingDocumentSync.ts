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
 *
 *  调用方得到的是镜像**版本**的保证，而不是「定时器被取消」：宿主 ack 到调用时的版本才
 *  resolve，已经在线的批即使后面没有排队也要等；open/change 共用 5 秒期限，超时 reject，
 *  让调用方跳过依赖旧镜像的操作。调用之后到达的输入属于下一次请求。
 *--------------------------------------------------------------------------------------------*/

/** 刷新 `uri` 的镜像，宿主 ack 到调用时的版本才 resolve；没有镜像的文档直接 resolve。 */
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
