/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HistoryService — back/forward navigation history. Pure renderer state; no
 *  persistence (matches vscode). Records are inserted via `record()` from the
 *  FileEditor Monaco cursor listener; `goBack`/`goForward` return the entry
 *  and flip a `_suppressNext` guard so the resulting cursor change is not
 *  re-recorded. Stack depth is bounded; consecutive same-line entries on the
 *  same file collapse into one (latest selection wins).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  type IHistoryEntry,
  type IHistoryService,
  type IHistorySelection,
  URI,
  isEqualResource,
} from '@universe-editor/platform'

const MAX_DEPTH = 50

function sameFile(a: IHistoryEntry, b: Omit<IHistoryEntry, 'timestamp'>): boolean {
  return isEqualResource(a.resource, b.resource)
}

function sameLine(a: IHistoryEntry, b: Omit<IHistoryEntry, 'timestamp'>): boolean {
  const as = a.selection
  const bs = b.selection
  if (as === bs) return true
  // Treat "no selection" as matching any line on the same file — lets a cursor
  // record upgrade an initial placeholder without growing the stack.
  if (!as || !bs) return true
  return as.startLine === bs.startLine
}

export class HistoryService extends Disposable implements IHistoryService {
  declare readonly _serviceBrand: undefined

  private readonly _back: IHistoryEntry[] = []
  private readonly _forward: IHistoryEntry[] = []
  private _suppressNext = false

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  record(entry: Omit<IHistoryEntry, 'timestamp'>): void {
    if (this._suppressNext) {
      this._suppressNext = false
      return
    }
    const reviveResource =
      entry.resource instanceof URI ? entry.resource : (URI.revive(entry.resource) as URI)
    if (!reviveResource) return
    const next: Omit<IHistoryEntry, 'timestamp'> = {
      resource: reviveResource,
      selection: entry.selection,
      ...(entry.typeId !== undefined && { typeId: entry.typeId }),
      ...(entry.serialized !== undefined && { serialized: entry.serialized }),
    }
    const top = this._back[this._back.length - 1]
    if (top && sameFile(top, next) && sameLine(top, next)) {
      // Replace top in-place so the latest column / selection wins without
      // creating a duplicate stack entry.
      this._back[this._back.length - 1] = { ...next, timestamp: Date.now() }
      if (this._forward.length > 0) this._forward.length = 0
      this._onDidChange.fire()
      return
    }

    this._back.push({ ...next, timestamp: Date.now() })
    if (this._back.length > MAX_DEPTH) this._back.shift()
    if (this._forward.length > 0) this._forward.length = 0
    this._onDidChange.fire()
  }

  goBack(): IHistoryEntry | undefined {
    if (this._back.length < 2) return undefined
    const current = this._back.pop()
    if (!current) return undefined
    this._forward.push(current)
    if (this._forward.length > MAX_DEPTH) this._forward.shift()
    const target = this._back[this._back.length - 1]
    this._suppressNext = true
    this._onDidChange.fire()
    return target
  }

  goForward(): IHistoryEntry | undefined {
    const target = this._forward.pop()
    if (!target) return undefined
    this._back.push(target)
    if (this._back.length > MAX_DEPTH) this._back.shift()
    this._suppressNext = true
    this._onDidChange.fire()
    return target
  }

  canGoBack(): boolean {
    return this._back.length >= 2
  }

  canGoForward(): boolean {
    return this._forward.length > 0
  }

  getBackStack(): readonly IHistoryEntry[] {
    return this._back
  }

  getForwardStack(): readonly IHistoryEntry[] {
    return this._forward
  }

  clear(): void {
    if (this._back.length === 0 && this._forward.length === 0) return
    this._back.length = 0
    this._forward.length = 0
    this._suppressNext = false
    this._onDidChange.fire()
  }
}

export type { IHistorySelection }
