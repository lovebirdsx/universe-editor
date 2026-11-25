/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HistoryService — back/forward navigation history. Pure renderer state; no
 *  persistence (matches vscode). Records are inserted via `record()` from the
 *  active-editor autorun, the FileEditor Monaco cursor listener, and the
 *  code-editor open handler (jump origins/targets). With Vim mode on, the
 *  contribution also inserts *view* entries via `recordView()`, so Ctrl+O /
 *  Ctrl+I walk editor positions and view focus as one jump list.
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
  type IHistoryNavigateOptions,
  type IHistorySelection,
  type IHistoryStackEntry,
  type IHistoryViewEntry,
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

type EditorEntryInput = Omit<IHistoryEntry, 'timestamp'>

function isViewEntry(entry: IHistoryStackEntry): entry is IHistoryViewEntry {
  return entry.kind === 'view'
}

function normalizeCount(count: number | undefined): number {
  return typeof count === 'number' && Number.isFinite(count) && count > 1 ? Math.floor(count) : 1
}

function sameFile(
  uriIdentity: IUriIdentityService,
  a: IHistoryEntry,
  b: EditorEntryInput,
): boolean {
  return uriIdentity.isEqual(a.resource, b.resource)
}

/**
 * Collapse `newer` onto `older` (same file + line) — merge per field: a record
 * lacking a field must not wipe what the older entry carries. A placeholder
 * record (no selection) would otherwise drop the position a jump record just
 * wrote, and a cursor record (no typeId) would drop the typeId/serialized the
 * placeholder needs to rebuild the input.
 */
function mergeEditorPair(older: IHistoryEntry, newer: EditorEntryInput): IHistoryEntry {
  return {
    ...newer,
    ...(newer.selection === undefined &&
      older.selection !== undefined && { selection: older.selection }),
    ...(newer.typeId === undefined && older.typeId !== undefined && { typeId: older.typeId }),
    ...(newer.serialized === undefined &&
      older.serialized !== undefined && { serialized: older.serialized }),
    timestamp: Date.now(),
  }
}

function sameLine(a: IHistoryEntry, b: EditorEntryInput): boolean {
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

  private readonly _back: IHistoryStackEntry[] = []
  private readonly _forward: IHistoryStackEntry[] = []
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

  record(entry: EditorEntryInput): void {
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
    const next: EditorEntryInput = {
      resource: reviveResource,
      selection: entry.selection,
      ...(entry.typeId !== undefined && { typeId: entry.typeId }),
      ...(entry.serialized !== undefined && { serialized: entry.serialized }),
    }
    const top = this._back[this._back.length - 1]
    if (top && !isViewEntry(top) && sameFile(this._uriIdentity, top, next) && sameLine(top, next)) {
      // Replace top in-place so the latest column / selection wins without
      // creating a duplicate stack entry.
      this._back[this._back.length - 1] = mergeEditorPair(top, next)
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
      if (e && !isViewEntry(e) && this._uriIdentity.isEqual(e.resource, resource)) {
        this._back[i] = { ...e, selection, timestamp: Date.now() }
        this._onDidChange.fire()
        return
      }
    }
  }

  recordView(viewId: string): void {
    const top = this._back[this._back.length - 1]
    // Landing on the view goForward just restored re-records it; clearing the
    // forward stack there would break the next Ctrl+I.
    if (top && isViewEntry(top) && top.viewId === viewId) return
    // One entry per view: drop the older occurrence so bouncing between the
    // editor and a view does not grow the stack. Suppression windows stay —
    // a navigation target's late cursor flush must still be swallowed.
    const back = this._compact(this._back, (e) => isViewEntry(e) && e.viewId === viewId)
    back.push({ kind: 'view', viewId, timestamp: Date.now() })
    if (back.length > MAX_DEPTH) back.splice(0, back.length - MAX_DEPTH)
    this._back.splice(0, this._back.length, ...back)
    if (this._forward.length > 0) this._forward.length = 0
    this._onDidChange.fire()
  }

  removeViewEntries(): void {
    const back = this._compact(this._back, isViewEntry)
    const forward = this._forward.filter((e) => !isViewEntry(e))
    if (back.length === this._back.length && forward.length === this._forward.length) return
    this._back.splice(0, this._back.length, ...back)
    this._forward.splice(0, this._forward.length, ...forward)
    this._onDidChange.fire()
  }

  goBack(options?: IHistoryNavigateOptions): IHistoryStackEntry | undefined {
    // Fire before the depth check: listeners flush a pending debounced cursor
    // record here, so a significant move made moments ago becomes the "current"
    // entry and this pop returns to the real origin instead of losing it.
    this._onWillNavigate.fire()
    const isStale = options?.isStale
    const targetIndex = this._findLanding(
      this._back,
      this._back.length - 2,
      normalizeCount(options?.count),
      isStale,
    )
    if (targetIndex === undefined) return undefined
    for (let i = this._back.length - 1; i > targetIndex; i--) {
      const e = this._back[i]
      if (e && !isStale?.(e)) this._forward.push(e)
    }
    this._back.length = targetIndex + 1
    if (this._forward.length > MAX_DEPTH) {
      this._forward.splice(0, this._forward.length - MAX_DEPTH)
    }
    return this._land(this._back[targetIndex])
  }

  goForward(options?: IHistoryNavigateOptions): IHistoryStackEntry | undefined {
    this._onWillNavigate.fire()
    const isStale = options?.isStale
    const targetIndex = this._findLanding(
      this._forward,
      this._forward.length - 1,
      normalizeCount(options?.count),
      isStale,
    )
    if (targetIndex === undefined) return undefined
    for (let i = this._forward.length - 1; i >= targetIndex; i--) {
      const e = this._forward[i]
      if (e && !isStale?.(e)) this._back.push(e)
    }
    this._forward.length = targetIndex
    if (this._back.length > MAX_DEPTH) this._back.splice(0, this._back.length - MAX_DEPTH)
    return this._land(this._back[this._back.length - 1])
  }

  /**
   * Index of the `count`-th live entry walking down from `from`, or of the
   * furthest one when fewer exist. Stale entries do not consume the count;
   * undefined means there is nowhere to go and nothing may be mutated.
   */
  private _findLanding(
    stack: readonly IHistoryStackEntry[],
    from: number,
    count: number,
    isStale: IHistoryNavigateOptions['isStale'],
  ): number | undefined {
    let found: number | undefined
    let remaining = count
    for (let i = from; i >= 0 && remaining > 0; i--) {
      const e = stack[i]
      if (!e || isStale?.(e)) continue
      found = i
      remaining--
    }
    return found
  }

  private _land(target: IHistoryStackEntry | undefined): IHistoryStackEntry | undefined {
    if (target && !isViewEntry(target)) this._suppress(target.resource)
    this._onDidChange.fire()
    return target
  }

  /**
   * Drop the matching entries and fold editor entries that become adjacent on
   * the same file + line, as `record()` would have done had they arrived in a
   * row.
   */
  private _compact(
    list: readonly IHistoryStackEntry[],
    drop: (entry: IHistoryStackEntry) => boolean,
  ): IHistoryStackEntry[] {
    const out: IHistoryStackEntry[] = []
    for (const entry of list) {
      if (drop(entry)) continue
      const last = out[out.length - 1]
      if (
        last &&
        !isViewEntry(last) &&
        !isViewEntry(entry) &&
        sameFile(this._uriIdentity, last, entry) &&
        sameLine(last, entry)
      ) {
        out[out.length - 1] = mergeEditorPair(last, entry)
        continue
      }
      out.push(entry)
    }
    return out
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

  getBackStack(): readonly IHistoryStackEntry[] {
    return this._back
  }

  getForwardStack(): readonly IHistoryStackEntry[] {
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
