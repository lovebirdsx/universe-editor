/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TreeModel — generic, view-agnostic tree state machine.
 *
 *  Owns expansion / selection / focus state keyed by element id, computes the
 *  flat list of visible rows (cached, invalidated only on structure changes),
 *  and handles keyboard-driven selection semantics (single / Ctrl / Shift-range).
 *  Children are always read back from the ITreeDataSource — the model caches
 *  state, never the children, so there is a single source of truth.
 *
 *  This is the core lifted out of the old ExplorerTreeService so Explorer, Scm
 *  and (later) Search can share it: data access and row rendering are injected.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, type Event } from '@universe-editor/platform'
import { type ITreeDataSource } from './ITreeDataSource.js'

export interface IVisibleNode<T> {
  readonly element: T
  readonly id: string
  /** 0 for the data source's roots; +1 per level below. */
  readonly depth: number
  readonly hasChildren: boolean
  readonly expanded: boolean
  readonly loading: boolean
  readonly error: string | null
}

export interface ITreeModelOptions<T> {
  readonly dataSource: ITreeDataSource<T>
  /** Initial expanded state for an element with no recorded state yet. */
  readonly defaultExpanded?: (element: T, depth: number) => boolean
}

export interface ISetSelectionOptions {
  /**
   * Fire onReveal for the new focus so the view scrolls it into view
   * (default true). Pass false when the selection is seeded programmatically
   * rather than requested by the user — e.g. giving a freshly focused tree a
   * keyboard cursor, which must not yank the viewport to that row.
   */
  readonly reveal?: boolean
  /**
   * Keep a range anchor other than the new focus. Used when selection ids were
   * remapped (e.g. compact-folder chain reshape) and the original Shift anchor
   * must survive; defaults to the new focus.
   */
  readonly anchor?: string | null
}

interface NodeState {
  expanded: boolean
  loading: boolean
  error: string | null
}

function dedupeStrings(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export class TreeModel<T> extends Disposable {
  private readonly _dataSource: ITreeDataSource<T>
  private readonly _defaultExpanded: ((element: T, depth: number) => boolean) | undefined
  private readonly _state = new Map<string, NodeState>()

  private _selection: string[] = []
  private _selectionKeys = new Set<string>()
  private _focused: string | null = null
  // Fixed end of a Shift range; `_focused` is the moving end. Stored by id
  // because row indices shift on expand/collapse/refresh.
  private _anchor: string | null = null
  private _selectionEpoch = 0

  // Visible-rows cache: invalidated only when the structure changes
  // (expand / collapse / refresh). Selection mutations never touch it.
  private _structureVersion = 0
  private _visibleCache: readonly IVisibleNode<T>[] | null = null
  private _visibleCacheVersion = -1

  private readonly _onDidChangeStructure = this._register(new Emitter<void>())
  readonly onDidChangeStructure: Event<void> = this._onDidChangeStructure.event

  private readonly _onDidChangeSelection = this._register(new Emitter<void>())
  readonly onDidChangeSelection: Event<void> = this._onDidChangeSelection.event

  /**
   * Fires only from expand()/collapse() — the toggle entry points — never
   * from refresh(), setExpansion(), collapseAll() or default-expansion
   * materialisation, so listeners see real state flips, not render diffs.
   */
  private readonly _onDidChangeExpansion = this._register(
    new Emitter<{ element: T; expanded: boolean }>(),
  )
  readonly onDidChangeExpansion: Event<{ element: T; expanded: boolean }> =
    this._onDidChangeExpansion.event

  private readonly _onReveal = this._register(new Emitter<{ id: string }>())
  readonly onReveal: Event<{ id: string }> = this._onReveal.event

  constructor(options: ITreeModelOptions<T>) {
    super()
    this._dataSource = options.dataSource
    this._defaultExpanded = options.defaultExpanded
  }

  get selection(): readonly string[] {
    return this._selection
  }

  get focused(): string | null {
    return this._focused
  }

  /** Fixed end of the next Shift range extension; null before any selection. */
  get anchor(): string | null {
    return this._anchor
  }

  /**
   * Monotonic counter bumped by every public selection mutation. Internal
   * refresh/recovery writes leave it alone, so hosts can tell whether the user
   * acted while an async reload was in flight.
   */
  get selectionEpoch(): number {
    return this._selectionEpoch
  }

  /** True once dispose() has run — its emitters no longer fire or accept listeners. */
  get isDisposed(): boolean {
    return this._store.isDisposed
  }

  // --- visible rows --------------------------------------------------------

  getVisibleNodes(): readonly IVisibleNode<T>[] {
    if (this._visibleCache && this._visibleCacheVersion === this._structureVersion) {
      return this._visibleCache
    }
    const out: IVisibleNode<T>[] = []
    for (const root of this._dataSource.getRoots()) {
      this._collect(root, 0, out)
    }
    this._visibleCache = out
    this._visibleCacheVersion = this._structureVersion
    return out
  }

  private _collect(element: T, depth: number, acc: IVisibleNode<T>[]): void {
    const id = this._dataSource.getId(element)
    const hasChildren = this._dataSource.hasChildren(element)
    let state = this._state.get(id)
    // Materialise a default-expanded node's state the first time it becomes
    // visible, so isExpanded / collapse / toggle agree with what's rendered —
    // otherwise the first click / ArrowLeft on such a row is a no-op.
    if (!state && hasChildren && this._defaultExpanded?.(element, depth)) {
      state = this._ensureState(id)
      state.expanded = true
      // A default-expanded node renders open, so a lazy source must have its
      // children pulled now — explicit expand() is the only other trigger.
      // One-shot per materialisation (collapse → re-expand retries through
      // expand()); on settle the structure event lets the view re-collect,
      // which cascades into nested default-expanded levels.
      if (this._dataSource.getChildren(element) === null) {
        void this._pullChildren(element, state).then(() => this._emitStructure())
      }
    }
    const expanded = hasChildren ? (state?.expanded ?? false) : false
    acc.push({
      element,
      id,
      depth,
      hasChildren,
      expanded,
      loading: state?.loading ?? false,
      error: state?.error ?? null,
    })
    if (!hasChildren || !expanded) return
    const children = this._dataSource.getChildren(element)
    if (!children) return
    for (const child of children) {
      this._collect(child, depth + 1, acc)
    }
  }

  private _findVisible(id: string): IVisibleNode<T> | null {
    return this.getVisibleNodes().find((n) => n.id === id) ?? null
  }

  getParentNode(id: string): IVisibleNode<T> | null {
    const getParent = this._dataSource.getParent
    if (!getParent) return null
    const node = this._findVisible(id)
    if (!node) return null
    const parent = getParent(node.element)
    if (!parent) return null
    return this._findVisible(this._dataSource.getId(parent))
  }

  // --- expansion -----------------------------------------------------------

  isExpanded(id: string): boolean {
    return this._state.get(id)?.expanded ?? false
  }

  async expand(element: T): Promise<void> {
    const id = this._dataSource.getId(element)
    const state = this._ensureState(id)
    const wasExpanded = state.expanded
    state.expanded = true
    if (!wasExpanded) this._onDidChangeExpansion.fire({ element, expanded: true })
    if (this._dataSource.getChildren(element) === null) {
      await this._pullChildren(element, state)
    }
    if (!wasExpanded || this._dataSource.getChildren(element) !== null) {
      this._emitStructure()
    }
  }

  collapse(element: T): void {
    const id = this._dataSource.getId(element)
    const state = this._state.get(id)
    if (!state || !state.expanded) return
    state.expanded = false
    this._onDidChangeExpansion.fire({ element, expanded: false })
    this._emitStructure()
  }

  async toggle(element: T): Promise<void> {
    if (this.isExpanded(this._dataSource.getId(element))) {
      this.collapse(element)
    } else {
      await this.expand(element)
    }
  }

  collapseAll(): void {
    let changed = false
    for (const state of this._state.values()) {
      if (state.expanded) {
        state.expanded = false
        changed = true
      }
    }
    if (changed) this._emitStructure()
  }

  /** Apply explicit expanded states for the given ids in one batch. */
  setExpansion(updates: Iterable<readonly [string, boolean]>): void {
    let changed = false
    for (const [id, expanded] of updates) {
      const state = this._ensureState(id)
      if (state.expanded !== expanded) {
        state.expanded = expanded
        changed = true
      }
    }
    if (changed) this._emitStructure()
  }

  /**
   * `setExpansion(updates)` followed by `refresh()`, but with a single structure
   * event. Views that seed expansion state right after their data changed (e.g.
   * Search, on every streamed batch) would otherwise fire twice and recompute
   * the whole visible-row list for each.
   */
  setExpansionAndRefresh(updates: Iterable<readonly [string, boolean]>): void {
    for (const [id, expanded] of updates) {
      const state = this._ensureState(id)
      if (state.expanded !== expanded) state.expanded = expanded
    }
    // Unconditional, matching refresh(): the caller's data changed even when no
    // expansion flag moved.
    this._emitStructure()
  }

  /** Whether the model has any recorded state for an id (vs. never seen). */
  hasState(id: string): boolean {
    return this._state.has(id)
  }

  /**
   * Ids explicitly collapsed — the diff from a view whose default is expanded
   * (e.g. Scm's `defaultExpanded: kind !== 'file'`). Persist this list and feed
   * it back through `setExpansion` on the next mount to restore the user's
   * folding across unmounts.
   */
  getCollapsedIds(): string[] {
    const out: string[] = []
    for (const [id, state] of this._state) {
      if (!state.expanded) out.push(id)
    }
    return out
  }

  /**
   * Ids currently expanded — the diff from a view whose default is collapsed
   * (e.g. Explorer). Persist this list and feed it back through `expand` /
   * `setExpansion` on the next mount to restore the user's folding.
   */
  getExpandedIds(): string[] {
    const out: string[] = []
    for (const [id, state] of this._state) {
      if (state.expanded) out.push(id)
    }
    return out
  }

  /** Invalidate the visible-rows cache after the underlying data changed. */
  refresh(): void {
    this._emitStructure()
  }

  /**
   * `refresh()` that also hands the cursor to the row which slid into the
   * focused row's place when the focused row disappeared from the data source.
   *
   * Views rebuild their data source and then call `refresh()`, leaving
   * `_focused` on an id that is no longer there; the next ArrowDown reads that
   * missing id as "nothing focused" and jumps to the first row. Unlike
   * `invalidateNodes()`, the caller does not know the gone ids, so this reads
   * the pre-refresh visible rows itself and treats a row that was on screen
   * before and is gone after as removed. A focus hidden under a collapsed
   * ancestor was not on screen and therefore gets no guessed successor.
   *
   * Expansion state is deliberately left alone: a row restored later (undo,
   * re-create) should come back in the fold it had before.
   *
   * The old visible rows must already have been collected (a render happened):
   * with an empty cache this recomputes both sides from the changed data source
   * and silently degrades to `refresh()`.
   */
  refreshWithFocusRecovery(): void {
    const previousFocus = this._focused
    if (previousFocus === null && this._selection.length === 0 && this._anchor === null) {
      this.refresh()
      return
    }
    // Read before invalidating: the old cache is what says which row used to
    // occupy the seat the successor must take.
    const previous = this.getVisibleNodes()
    const focusIdx = previousFocus === null ? -1 : previous.findIndex((n) => n.id === previousFocus)
    // -1 when the cursor was outside the selection (or not on screen).
    const focusSeat = previousFocus === null ? -1 : this._selection.indexOf(previousFocus)
    const previousIds = new Set(previous.map((n) => n.id))

    this._invalidateStructure()
    const next = this.getVisibleNodes()
    const nextIds = new Set(next.map((n) => n.id))

    // A row that was visible and is gone was removed from the data source (the
    // model's own refresh cannot hide rows; hosts that reshape ids, such as the
    // Explorer compact chain, remap the anchor themselves). Drop the anchor so
    // the next Shift gesture starts from the surviving focus; a hidden anchor
    // is kept and extendSelectionTo falls back at gesture time.
    if (this._anchor !== null && previousIds.has(this._anchor) && !nextIds.has(this._anchor)) {
      this._anchor = null
    }

    let nextFocus = previousFocus
    if (previousFocus !== null && focusIdx >= 0 && !nextIds.has(previousFocus)) {
      // Rows deleted above the focus shift the successor left, so the old index
      // must lose every removed row before it (a multi-row delete removes more
      // than the focused row itself).
      const removedBefore = previous
        .slice(0, focusIdx)
        .filter((node) => !nextIds.has(node.id)).length
      nextFocus = next[Math.min(focusIdx - removedBefore, next.length - 1)]?.id ?? null
    }

    // Rows that were visible and are no longer there were removed from the
    // data source (a structure refresh cannot collapse an ancestor), so they
    // must not linger in the selection.
    const nextSelection = this._selection.filter((id) => nextIds.has(id) || !previousIds.has(id))
    let selectionChanged = nextSelection.length !== this._selection.length
    // The successor takes the removed row's seat when the cursor was selected,
    // so the new cursor carries the row highlight; a successor already in the
    // selection must not be listed twice.
    if (
      nextFocus !== null &&
      nextFocus !== previousFocus &&
      focusSeat >= 0 &&
      !nextSelection.includes(nextFocus)
    ) {
      nextSelection.splice(Math.min(focusSeat, nextSelection.length), 0, nextFocus)
      selectionChanged = true
    }

    if (selectionChanged) this._replaceSelection(nextSelection)
    const focusChanged = nextFocus !== previousFocus
    if (focusChanged) this._focused = nextFocus
    if (selectionChanged || focusChanged) this._emitSelection()
    this._onDidChangeStructure.fire()
  }

  /**
   * Ids the data source no longer returns: drop their cached state (a row that
   * comes back later starts from `defaultExpanded` again rather than inheriting
   * a stale fold), prune them from the selection, and hand the keyboard cursor to
   * the row that slid into the focused row's place. Leaving `_focused` on a gone
   * id is not cosmetic: `navigate()` cannot find it in the visible list, reads
   * that as "nothing focused", and sends the next ArrowDown to the first row.
   *
   * `refresh()` plus a prune, in one structure event; with nothing to remove it
   * is just `refresh()`.
   */
  invalidateNodes(ids: Iterable<string>): void {
    const gone = new Set(ids)
    if (gone.size === 0) {
      this._emitStructure()
      return
    }
    if (this._anchor !== null && gone.has(this._anchor)) this._anchor = null
    // Read before pruning state: the cache still holds the pre-change rows, which
    // is what the neighbour calculation needs.
    const visible = this.getVisibleNodes()
    const previousFocus = this._focused
    const removedFocus = previousFocus !== null && gone.has(previousFocus) ? previousFocus : null
    const focusIdx = previousFocus === null ? -1 : visible.findIndex((n) => n.id === previousFocus)
    // -1 when the cursor was not part of the selection, >= 0 is its seat there.
    const focusSeat = removedFocus === null ? -1 : this._selection.indexOf(removedFocus)
    for (const id of gone) this._state.delete(id)

    let nextFocus = previousFocus
    if (removedFocus !== null) {
      const survivors = visible.filter((n) => !gone.has(n.id))
      // focusIdx < 0: the row is gone but was not on screen at all (a collapsed
      // ancestor hid it), so there is no "row that slid up" to hand the cursor to
      // — and picking the first row is the jump this method exists to avoid.
      const removedBefore = visible
        .slice(0, Math.max(focusIdx, 0))
        .filter((n) => gone.has(n.id)).length
      nextFocus =
        focusIdx < 0
          ? null
          : (survivors[Math.min(focusIdx - removedBefore, survivors.length - 1)]?.id ?? null)
    }

    const nextSelection = this._selection.filter((id) => !gone.has(id))
    let selectionChanged = nextSelection.length !== this._selection.length
    // The row highlight follows the selection, so a cursor handed to a neighbour
    // has to take the removed row's seat there — otherwise the focus moves with
    // nothing on screen to show it. A successor that is still selected already
    // carries the highlight, and must not be listed twice.
    if (focusSeat >= 0 && nextFocus !== null && !nextSelection.includes(nextFocus)) {
      nextSelection.splice(Math.min(focusSeat, nextSelection.length), 0, nextFocus)
      selectionChanged = true
    }

    if (selectionChanged) this._replaceSelection(nextSelection)
    const focusChanged = nextFocus !== previousFocus
    if (focusChanged) this._focused = nextFocus
    if (selectionChanged || focusChanged) this._emitSelection()
    this._emitStructure()
  }

  /** Drop all expansion + selection state (e.g. when the root changes). */
  reset(): void {
    this._state.clear()
    this._selectionEpoch++
    this._selection = []
    this._selectionKeys = new Set()
    this._focused = null
    this._anchor = null
    this._emitStructure()
    this._emitSelection()
  }

  // --- selection / focus ---------------------------------------------------

  isSelected(id: string): boolean {
    return this._selectionKeys.has(id)
  }

  setSelection(
    ids: readonly string[],
    focus?: string | null,
    options?: ISetSelectionOptions,
  ): void {
    const list = dedupeStrings(ids)
    const newFocus =
      focus === undefined ? (list.length > 0 ? (list[list.length - 1] ?? null) : null) : focus
    // Re-anchor before the no-op return: a programmatic selection resets the
    // range origin even when selection and focus are unchanged.
    this._anchor = options?.anchor !== undefined ? options.anchor : newFocus
    this._selectionEpoch++
    if (this._sameSelection(list) && this._focused === newFocus) return
    this._replaceSelection(list)
    this._focused = newFocus
    this._emitSelection()
    if (newFocus && (options?.reveal ?? true)) this._onReveal.fire({ id: newFocus })
  }

  setFocus(id: string | null): void {
    // Same as setSelection: re-anchor even when the focus itself is unchanged.
    this._anchor = id
    this._selectionEpoch++
    if (this._focused === id) return
    this._focused = id
    this._emitSelection()
    if (id) this._onReveal.fire({ id })
  }

  /** Ctrl/Cmd+Click: add when absent, remove when present. */
  toggleInSelection(id: string): void {
    this._selectionEpoch++
    const idx = this._selection.indexOf(id)
    const next = idx >= 0 ? this._selection.filter((_, i) => i !== idx) : [...this._selection, id]
    this._replaceSelection(next)
    this._focused = id
    this._anchor = id
    this._emitSelection()
    this._onReveal.fire({ id })
  }

  /**
   * Explicit-anchor range selection. Shift gestures should use
   * extendSelectionTo(), which supplies the persistent anchor. An anchor that
   * is not on screen (stale id / collapsed ancestor) degrades to a single-row
   * selection here; extendSelectionTo() resolves the fallback first.
   */
  selectRange(anchorId: string, targetId: string): void {
    this._selectionEpoch++
    const visible = this.getVisibleNodes()
    const anchorIdx = visible.findIndex((n) => n.id === anchorId)
    const targetIdx = visible.findIndex((n) => n.id === targetId)
    if (anchorIdx < 0 || targetIdx < 0) {
      // setSelection also re-anchors at the target.
      this.setSelection([targetId], targetId)
      return
    }
    const [lo, hi] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
    this._replaceSelection(visible.slice(lo, hi + 1).map((n) => n.id))
    this._anchor = anchorId
    this._focused = targetId
    this._emitSelection()
    this._onReveal.fire({ id: targetId })
  }

  /**
   * Shift+Click / Shift+Arrow gesture: extend from the persistent anchor.
   * The first extension anchors at the current focus; later calls keep that
   * anchor instead of re-anchoring at the moving focus. A hidden anchor (row
   * removed or collapsed away) falls back to the focused row, then to the
   * target itself.
   */
  extendSelectionTo(targetId: string): void {
    const visible = this.getVisibleNodes()
    const isVisible = (id: string): boolean => visible.some((n) => n.id === id)
    const anchorId = this._anchor
    const focusedId = this._focused
    const anchor =
      anchorId !== null && isVisible(anchorId)
        ? anchorId
        : focusedId !== null && isVisible(focusedId)
          ? focusedId
          : targetId
    this.selectRange(anchor, targetId)
  }

  /**
   * Escape gesture: collapse a multi-selection onto the focused row and
   * re-anchor there. No-op when at most one row is selected.
   */
  collapseSelectionToFocus(): void {
    const focus = this._focused ?? this._selection[0] ?? null
    if (focus === null || this._selection.length <= 1) return
    this.setSelection([focus], focus)
  }

  /**
   * Keyboard navigation semantics shared by the Tree view and view-level
   * commands (e.g. Outline's emacs bindings): up/down move the selection,
   * right expands then steps into the first child, left collapses then steps
   * out to the parent — matching the Explorer tree. `extend` (Shift) grows the
   * selection range from the persistent anchor instead of replacing it and
   * applies only to up/down.
   */
  navigate(direction: 'up' | 'down' | 'left' | 'right', extend = false): void {
    const vis = this.getVisibleNodes()
    if (vis.length === 0) return
    const currentIndex = this._focused ? vis.findIndex((n) => n.id === this._focused) : -1
    const current = currentIndex >= 0 ? vis[currentIndex] : undefined

    const moveTo = (index: number) => {
      const clamped = Math.max(0, Math.min(vis.length - 1, index))
      const target = vis[clamped]
      if (!target) return
      if (extend) this.extendSelectionTo(target.id)
      else this.setSelection([target.id], target.id)
    }

    switch (direction) {
      case 'down':
        moveTo(currentIndex < 0 ? 0 : currentIndex + 1)
        return
      case 'up':
        moveTo(currentIndex < 0 ? 0 : currentIndex - 1)
        return
      case 'right':
        if (!current || !current.hasChildren) return
        if (current.expanded) {
          const next = vis[currentIndex + 1]
          if (next) this.setSelection([next.id], next.id)
        } else {
          void this.expand(current.element)
        }
        return
      case 'left':
        if (!current) return
        if (current.hasChildren && current.expanded) {
          this.collapse(current.element)
        } else {
          const parent = this.getParentNode(current.id)
          if (parent) this.setSelection([parent.id], parent.id)
        }
        return
    }
  }

  // --- reveal --------------------------------------------------------------

  /**
   * Expand every ancestor of `element` (requires getParent), make it the sole
   * selection + focus, and fire onReveal so the view can scroll it into view.
   *
   * onReveal fires unconditionally at the end: setSelection early-returns
   * (and skips onReveal) when the target is already the sole selection + focus,
   * but "Reveal in Explorer" on an already-selected row that the user scrolled
   * off-screen must still scroll it back into view.
   */
  async reveal(element: T): Promise<void> {
    const getParent = this._dataSource.getParent
    if (getParent) {
      const chain: T[] = []
      let cursor = getParent(element)
      while (cursor) {
        chain.unshift(cursor)
        cursor = getParent(cursor)
      }
      for (const ancestor of chain) {
        await this.expand(ancestor)
      }
    }
    const id = this._dataSource.getId(element)
    this.setSelection([id])
    this._onReveal.fire({ id })
  }

  // --- internals -----------------------------------------------------------

  /** Shared children pull for expand() and default-expansion materialisation. */
  private async _pullChildren(element: T, state: NodeState): Promise<void> {
    const loadChildren = this._dataSource.loadChildren
    if (!loadChildren || state.loading) return
    state.loading = true
    state.error = null
    try {
      await loadChildren(element)
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
    } finally {
      state.loading = false
    }
  }

  private _ensureState(id: string): NodeState {
    let state = this._state.get(id)
    if (!state) {
      state = { expanded: false, loading: false, error: null }
      this._state.set(id, state)
    }
    return state
  }

  private _replaceSelection(ids: readonly string[]): void {
    this._selection = ids as string[]
    this._selectionKeys = new Set(ids)
  }

  private _sameSelection(ids: readonly string[]): boolean {
    if (ids.length !== this._selection.length) return false
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== this._selection[i]) return false
    }
    return true
  }

  private _emitStructure(): void {
    this._invalidateStructure()
    this._onDidChangeStructure.fire()
  }

  private _invalidateStructure(): void {
    this._structureVersion++
    this._visibleCache = null
  }

  private _emitSelection(): void {
    this._onDidChangeSelection.fire()
  }
}
