/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HistoryService — back/forward navigation history. Pure renderer state; no
 *  persistence (matches vscode). Records are inserted via `record()` from the
 *  active-editor autorun, the FileEditor Monaco cursor listener, and the
 *  code-editor open handler (jump origins/targets).
 *  `goBack`/`goForward` fire `onWillNavigate` before touching the stack, then
 *  return the entry and open a short *suppression window* keyed to the target
 *  resource: a single navigation fires several records for that resource (the
 *  synchronous active-editor change plus the debounced cursor flush ~250ms
 *  later), and all of them must be ignored — otherwise the trailing flush would
 *  clear the freshly-built forward stack. Windows are tracked per resource (a
 *  second navigation can land inside the first one's window); the navigation
 *  action calls `settleNavigation` once the reveal completes to extend the
 *  target's window past a slow editor mount. A record for a *different*
 *  resource inside a window is genuine user navigation and passes through
 *  (closing every open window). Stack depth is bounded; consecutive same-line
 *  entries on the same file collapse into one (latest selection wins).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  IHistoryService,
  IUriIdentityService,
  InstantiationType,
  registerSingleton,
  type IHistoryEntry,
  type IHistorySelection,
  URI,
} from '@universe-editor/platform'

const MAX_DEPTH = 50

// How long after a goBack/goForward we keep swallowing records for the target
// resource. Must outlast the cursor listener's debounce (250ms) plus the
// editor (re)open + setPosition round-trip, so the trailing flush lands inside
// the window and does not clear the forward stack.
const SUPPRESS_WINDOW_MS = 1000

// Extra life granted by settleNavigation once the reveal completes. Must exceed
// HistoryContribution's 250ms cursor debounce so the flush the reveal itself
// triggers still lands inside the window.
const SUPPRESS_SETTLE_MS = 350

function sameFile(
  uriIdentity: IUriIdentityService,
  a: IHistoryEntry,
  b: Omit<IHistoryEntry, 'timestamp'>,
): boolean {
  return uriIdentity.isEqual(a.resource, b.resource)
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
  // Resources we are currently navigating to (via goBack/goForward), each with
  // the wall-clock deadline until which records for it are swallowed. A single
  // navigation produces multiple records for its target; all are ignored until
  // the deadline. A second navigation inside the first one's window adds its
  // own target without disturbing the first. A record for a resource that is
  // NOT suppressed is real user navigation — it closes every open window and
  // records normally.
  private readonly _suppressed = new Map<string, number>()

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  private readonly _onWillNavigate = this._register(new Emitter<void>())
  readonly onWillNavigate = this._onWillNavigate.event

  constructor(@IUriIdentityService private readonly _uriIdentity: IUriIdentityService) {
    super()
  }

  record(entry: Omit<IHistoryEntry, 'timestamp'>): void {
    const reviveResource =
      entry.resource instanceof URI ? entry.resource : (URI.revive(entry.resource) as URI)
    if (!reviveResource) return
    const key = reviveResource.toString()
    const deadline = this._suppressed.get(key)
    if (deadline !== undefined) {
      if (Date.now() <= deadline) {
        // A record for the navigation target inside the window — swallow it so
        // the trailing cursor flush cannot clear the forward stack.
        return
      }
      this._suppressed.delete(key)
    }
    if (this._suppressed.size > 0) {
      // A record for any unsuppressed resource (or an expired window) is real
      // user navigation: stop suppressing everything.
      this._suppressed.clear()
    }
    const next: Omit<IHistoryEntry, 'timestamp'> = {
      resource: reviveResource,
      selection: entry.selection,
      ...(entry.typeId !== undefined && { typeId: entry.typeId }),
      ...(entry.serialized !== undefined && { serialized: entry.serialized }),
    }
    const top = this._back[this._back.length - 1]
    if (top && sameFile(this._uriIdentity, top, next) && sameLine(top, next)) {
      // Replace top in-place so the latest column / selection wins without
      // creating a duplicate stack entry — but merge per field: a record
      // lacking a field must not wipe what the top already carries. A
      // placeholder record (no selection) would otherwise drop the position a
      // jump record just wrote, and a cursor record (no typeId) would drop the
      // typeId/serialized the placeholder needs to rebuild the input.
      this._back[this._back.length - 1] = {
        ...next,
        ...(next.selection === undefined &&
          top.selection !== undefined && { selection: top.selection }),
        ...(next.typeId === undefined && top.typeId !== undefined && { typeId: top.typeId }),
        ...(next.serialized === undefined &&
          top.serialized !== undefined && { serialized: top.serialized }),
        timestamp: Date.now(),
      }
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
    for (let i = this._back.length - 1; i >= 0; i--) {
      const e = this._back[i]
      if (e && this._uriIdentity.isEqual(e.resource, resource)) {
        this._back[i] = { ...e, selection, timestamp: Date.now() }
        this._onDidChange.fire()
        return
      }
    }
  }

  goBack(): IHistoryEntry | undefined {
    // Fire before the depth check: listeners flush a pending debounced cursor
    // record here, so a significant move made moments ago becomes the "current"
    // entry and this pop returns to the real origin instead of losing it.
    this._onWillNavigate.fire()
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
    this._onWillNavigate.fire()
    const target = this._forward.pop()
    if (!target) return undefined
    this._back.push(target)
    if (this._back.length > MAX_DEPTH) this._back.shift()
    this._suppress(target.resource)
    this._onDidChange.fire()
    return target
  }

  private _suppress(resource: URI): void {
    this._suppressed.set(resource.toString(), Date.now() + SUPPRESS_WINDOW_MS)
  }

  settleNavigation(resource: URI): void {
    const key = resource.toString()
    if (this._suppressed.has(key)) {
      this._suppressed.set(key, Date.now() + SUPPRESS_SETTLE_MS)
    }
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
    this._suppressed.clear()
    this._onDidChange.fire()
  }
}

export type { IHistorySelection }

registerSingleton(IHistoryService, HistoryService, InstantiationType.Eager)
