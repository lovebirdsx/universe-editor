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

  // Visible-rows cache: invalidated only when the structure changes
  // (expand / collapse / refresh). Selection mutations never touch it.
  private _structureVersion = 0
  private _visibleCache: readonly IVisibleNode<T>[] | null = null
  private _visibleCacheVersion = -1

  private readonly _onDidChangeStructure = this._register(new Emitter<void>())
  readonly onDidChangeStructure: Event<void> = this._onDidChangeStructure.event

  private readonly _onDidChangeSelection = this._register(new Emitter<void>())
  readonly onDidChangeSelection: Event<void> = this._onDidChangeSelection.event

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
    if (this._dataSource.getChildren(element) === null && this._dataSource.loadChildren) {
      if (!state.loading) {
        state.loading = true
        state.error = null
        try {
          await this._dataSource.loadChildren(element)
        } catch (err) {
          state.error = err instanceof Error ? err.message : String(err)
        } finally {
          state.loading = false
        }
      }
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

  /** Whether the model has any recorded state for an id (vs. never seen). */
  hasState(id: string): boolean {
    return this._state.has(id)
  }

  /** Invalidate the visible-rows cache after the underlying data changed. */
  refresh(): void {
    this._emitStructure()
  }

  /** Drop all expansion + selection state (e.g. when the root changes). */
  reset(): void {
    this._state.clear()
    this._selection = []
    this._selectionKeys = new Set()
    this._focused = null
    this._emitStructure()
    this._emitSelection()
  }

  // --- selection / focus ---------------------------------------------------

  isSelected(id: string): boolean {
    return this._selectionKeys.has(id)
  }

  setSelection(ids: readonly string[], focus?: string | null): void {
    const list = dedupeStrings(ids)
    const newFocus =
      focus === undefined ? (list.length > 0 ? (list[list.length - 1] ?? null) : null) : focus
    if (this._sameSelection(list) && this._focused === newFocus) return
    this._replaceSelection(list)
    this._focused = newFocus
    this._emitSelection()
    if (newFocus) this._onReveal.fire({ id: newFocus })
  }

  setFocus(id: string | null): void {
    if (this._focused === id) return
    this._focused = id
    this._emitSelection()
    if (id) this._onReveal.fire({ id })
  }

  /** Ctrl/Cmd+Click: add when absent, remove when present. */
  toggleInSelection(id: string): void {
    const idx = this._selection.indexOf(id)
    const next = idx >= 0 ? this._selection.filter((_, i) => i !== idx) : [...this._selection, id]
    this._replaceSelection(next)
    this._focused = id
    this._emitSelection()
    this._onReveal.fire({ id })
  }

  /** Shift+Click: inclusive range between anchor and target in visible order. */
  selectRange(anchorId: string, targetId: string): void {
    const visible = this.getVisibleNodes()
    const aIdx = visible.findIndex((n) => n.id === anchorId)
    const tIdx = visible.findIndex((n) => n.id === targetId)
    if (aIdx < 0 || tIdx < 0) {
      this.setSelection([targetId], targetId)
      return
    }
    const [lo, hi] = aIdx <= tIdx ? [aIdx, tIdx] : [tIdx, aIdx]
    this._replaceSelection(visible.slice(lo, hi + 1).map((n) => n.id))
    this._focused = targetId
    this._emitSelection()
    this._onReveal.fire({ id: targetId })
  }

  /**
   * Keyboard navigation semantics shared by the Tree view and view-level
   * commands (e.g. Outline's emacs bindings): up/down move the selection,
   * right expands then steps into the first child, left collapses then steps
   * out to the parent — matching the Explorer tree. `extend` (Shift) grows the
   * selection range instead of replacing it and applies only to up/down.
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
      if (extend && this._focused) this.selectRange(this._focused, target.id)
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
    this.setSelection([this._dataSource.getId(element)])
  }

  // --- internals -----------------------------------------------------------

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
    this._structureVersion++
    this._visibleCache = null
    this._onDidChangeStructure.fire()
  }

  private _emitSelection(): void {
    this._onDidChangeSelection.fire()
  }
}
