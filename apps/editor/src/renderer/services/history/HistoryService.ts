/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HistoryService — back/forward navigation history. Pure renderer state; no
 *  persistence (matches vscode). Records are inserted via `record()` from the
 *  active-editor autorun and the FileEditor Monaco cursor listener.
 *  `goBack`/`goForward` return the entry and open a short *suppression window*
 *  keyed to the target resource: a single navigation fires several records for
 *  that resource (the synchronous active-editor change plus the debounced
 *  cursor flush ~250ms later), and all of them must be ignored — otherwise the
 *  trailing flush would clear the freshly-built forward stack. Records for a
 *  *different* resource inside the window are genuine user navigation and pass
 *  through (closing the window). Stack depth is bounded; consecutive same-line
 *  entries on the same file collapse into one (latest selection wins).
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

// How long after a goBack/goForward we keep swallowing records for the target
// resource. Must outlast the cursor listener's debounce (250ms) plus the
// editor (re)open + setPosition round-trip, so the trailing flush lands inside
// the window and does not clear the forward stack.
const SUPPRESS_WINDOW_MS = 1000

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
  // Resource we are currently navigating to (via goBack/goForward) and the
  // wall-clock deadline until which records for it are swallowed. A single
  // navigation produces multiple records for this resource; all are ignored
  // until the deadline. A record for any other resource is real user
  // navigation — it closes the window and records normally.
  private _suppressResource: string | undefined
  private _suppressUntil = 0

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  record(entry: Omit<IHistoryEntry, 'timestamp'>): void {
    const reviveResource =
      entry.resource instanceof URI ? entry.resource : (URI.revive(entry.resource) as URI)
    if (!reviveResource) return
    if (this._suppressResource !== undefined) {
      if (
        Date.now() <= this._suppressUntil &&
        reviveResource.toString() === this._suppressResource
      ) {
        // A record for the navigation target inside the window — swallow it so
        // the trailing cursor flush cannot clear the forward stack.
        return
      }
      // Window expired, or the user navigated elsewhere: stop suppressing.
      this._suppressResource = undefined
      this._suppressUntil = 0
    }
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

  updateCurrent(resource: URI, selection: IHistorySelection): void {
    const target = resource.toString()
    for (let i = this._back.length - 1; i >= 0; i--) {
      const e = this._back[i]
      if (e && e.resource.toString() === target) {
        this._back[i] = { ...e, selection, timestamp: Date.now() }
        this._onDidChange.fire()
        return
      }
    }
  }

  goBack(): IHistoryEntry | undefined {
    if (this._back.length < 2) return undefined
    const current = this._back.pop()
    if (!current) return undefined
    this._forward.push(current)
    if (this._forward.length > MAX_DEPTH) this._forward.shift()
    const target = this._back[this._back.length - 1]
    if (target) this._suppress(target.resource)
    this._onDidChange.fire()
    return target
  }

  goForward(): IHistoryEntry | undefined {
    const target = this._forward.pop()
    if (!target) return undefined
    this._back.push(target)
    if (this._back.length > MAX_DEPTH) this._back.shift()
    this._suppress(target.resource)
    this._onDidChange.fire()
    return target
  }

  private _suppress(resource: URI): void {
    this._suppressResource = resource.toString()
    this._suppressUntil = Date.now() + SUPPRESS_WINDOW_MS
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
    this._suppressResource = undefined
    this._suppressUntil = 0
    this._onDidChange.fire()
  }
}

export type { IHistorySelection }
