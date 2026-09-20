/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  文档镜像管道此刻的读数，无需遍历文档即可读取。
 *
 *  读数在干活的地方（入队/发送/ack）同步维护，取值从不读文档：openChars 是 getValueLength()，
 *  pendingChars 是上限判定已经算过的和。镜像摘除即删记录，拆掉的管道读数为零而不是停在最后一帧。
 *--------------------------------------------------------------------------------------------*/

/** 一份镜像的写入句柄。镜像被替换后（语言切换、重开），旧句柄的写入静默失效：晚到的 ack 属于
 *  已经不存在的那个镜像，不得抹掉新镜像的读数。 */
export interface DocumentSyncStatsWriter {
  setOpenChars(chars: number): void
  setPending(deltas: number, chars: number, owedFull: boolean): void
  setInflight(chars: number): void
  /** 镜像已摘除：删除记录（句柄已过期则不动当前记录）。 */
  release(): void
}

export interface DocumentSyncStatsSnapshot {
  readonly openDocs: number
  readonly openChars: number
  readonly pendingDocs: number
  readonly pendingDeltas: number
  readonly pendingChars: number
  readonly inflightDocs: number
  readonly inflightChars: number
  /** 已欠整篇推送的文档数 */
  readonly fullDocs: number
}

const EMPTY: DocumentSyncStatsSnapshot = {
  openDocs: 0,
  openChars: 0,
  pendingDocs: 0,
  pendingDeltas: 0,
  pendingChars: 0,
  inflightDocs: 0,
  inflightChars: 0,
  fullDocs: 0,
}

interface DocRecord {
  /** 写出这份记录的句柄的身份；不匹配的写入一律丢弃 */
  readonly token: object
  openChars: number
  pendingDeltas: number
  pendingChars: number
  inflightChars: number
  owedFull: boolean
}

/** 负数、NaN 都不是载荷，不钳进读数。 */
function size(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

class DocumentSyncStatsImpl {
  private readonly _docs = new Map<string, DocRecord>()

  /** 键 = 镜像键（模型 URI 字符串），值自带 token，防止过期句柄写串记录。 */
  track(key: string): DocumentSyncStatsWriter {
    const token = {}
    this._docs.set(key, {
      token,
      openChars: 0,
      pendingDeltas: 0,
      pendingChars: 0,
      inflightChars: 0,
      owedFull: false,
    })
    return {
      setOpenChars: (chars) => this._update(key, token, (doc) => (doc.openChars = size(chars))),
      setPending: (deltas, chars, owedFull) =>
        this._update(key, token, (doc) => {
          doc.pendingDeltas = size(deltas)
          doc.pendingChars = size(chars)
          doc.owedFull = owedFull
        }),
      setInflight: (chars) => this._update(key, token, (doc) => (doc.inflightChars = size(chars))),
      release: () => {
        if (this._docs.get(key)?.token === token) this._docs.delete(key)
      },
    }
  }

  private _update(key: string, token: object, write: (doc: DocRecord) => void): void {
    const doc = this._docs.get(key)
    if (doc !== undefined && doc.token === token) write(doc)
  }

  /** 管道整体收尾：任何读数都不该活过它。 */
  clearAll(): void {
    this._docs.clear()
  }

  read(): DocumentSyncStatsSnapshot {
    if (this._docs.size === 0) return EMPTY
    let openChars = 0
    let pendingDocs = 0
    let pendingDeltas = 0
    let pendingChars = 0
    let inflightDocs = 0
    let inflightChars = 0
    let fullDocs = 0
    for (const doc of this._docs.values()) {
      openChars += doc.openChars
      pendingDeltas += doc.pendingDeltas
      pendingChars += doc.pendingChars
      inflightChars += doc.inflightChars
      if (doc.pendingDeltas > 0 || doc.owedFull) pendingDocs++
      if (doc.inflightChars > 0) inflightDocs++
      if (doc.owedFull) fullDocs++
    }
    return {
      openDocs: this._docs.size,
      openChars,
      pendingDocs,
      pendingDeltas,
      pendingChars,
      inflightDocs,
      inflightChars,
      fullDocs,
    }
  }
}

export const DocumentSyncStats = new DocumentSyncStatsImpl()

/**
 * 堆报告的 holder 源：这条管道拼出来还没 ack 的载荷（积压 + 在线批次），按 UTF-16 字节计。
 * 镜像正文不在这里报——它是 Monaco 模型，已由 `monaco` holder 记账，重复计入会让两边都不可
 * 归因。要「这条管道上有多少文本」时读 openChars。
 */
export function measureDocumentSyncPayload(): { bytes: number; count: number } | undefined {
  const stats = DocumentSyncStats.read()
  const bytes = (stats.pendingChars + stats.inflightChars) * 2
  if (bytes === 0) return undefined
  return { bytes, count: stats.openDocs }
}
