/*---------------------------------------------------------------------------------------------
 *  Renderer-side owner of extension-contributed tree views (VSCode
 *  `MainThreadTreeViews` counterpart). Handles the host → renderer
 *  `mainThreadTreeViews` channel (provider registrations + invalidations) and
 *  caches the pulled `ITreeItemDto` children per view; the ExtensionTreeView
 *  component renders the cache through a workbench-ui TreeModel and pulls
 *  lazily back over `extHostTreeViews` via the proxy set on connect.
 *
 *  Handles are host-allocated and **stable across refreshes**, so the tree
 *  model's expansion / selection (keyed by handle) survives an invalidation.
 *  The cache is a set of pages — the roots plus one per expanded parent —
 *  each carrying an epoch: invalidating a page bumps its epoch so a pull that
 *  was already in flight is discarded on settle instead of resurrecting rows
 *  the host has since dropped. `$refresh` with items invalidates only the
 *  named subtrees; without items it invalidates every page.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, Disposable, Emitter, type Event } from '@universe-editor/platform'
import type {
  IExtHostTreeViews,
  IMainThreadTreeViews,
  ITreeItemDto,
} from '@universe-editor/extensions-common'

/** Page key for the roots. Host handles start at 1, so -1 never collides. */
const ROOT_PAGE = -1

interface ITreeViewModel {
  roots: readonly ITreeItemDto[] | null
  readonly children: Map<number, readonly ITreeItemDto[]>
  /** Which page each cached row currently sits in (row handle → page key). */
  readonly pageByHandle: Map<number, number>
  /** Invalidation counter per page; only kept while a pull is in flight. */
  readonly pageEpoch: Map<number, number>
  readonly inflight: Map<number, { epoch: number; promise: Promise<void> }>
  lastVisible: boolean | undefined
}

export interface ITreeViewsService {
  readonly _serviceBrand: undefined
  /**
   * Fires with the viewId when a provider registers/unregisters, its data is
   * invalidated, or a children pull landed. Views refresh their model on this.
   */
  readonly onDidChangeView: Event<string>
  /** Wire the host proxy once the extension host connection is up. */
  setExtHost(extHost: IExtHostTreeViews): void
  hasProvider(viewId: string): boolean
  /** Cached roots, or null when not pulled yet (trigger `loadChildren`). */
  getRoots(viewId: string): readonly ITreeItemDto[] | null
  /** Cached children of `parentHandle`, or null when not pulled yet. */
  getChildren(viewId: string, parentHandle: number): readonly ITreeItemDto[] | null
  /** Pull children (roots when `parentHandle` is omitted) from the host and cache them. */
  loadChildren(viewId: string, parentHandle?: number): Promise<void>
  /** Push view visibility to the host (deduped per view). */
  setViewVisibility(viewId: string, visible: boolean): void
  /** Push the current selection (element handles) to the host. */
  setSelection(viewId: string, handles: number[]): void
  /** Push one element's expansion state to the host. */
  setExpansionState(viewId: string, handle: number, expanded: boolean): void
  /**
   * Execute a tree command host-side against the element behind `handle`:
   * a click omits `commandId` (runs the element's `TreeItem.command` with its
   * original arguments), a `view/item/context` menu pick passes it (runs with
   * the element as argument). Extension handlers must receive live objects,
   * never wire-flattened DTOs.
   */
  executeTreeItemCommand(viewId: string, handle: number, commandId?: string): void
  /** Drop every view model (extension host torn down). */
  reset(): void
}

export const ITreeViewsService = createDecorator<ITreeViewsService>('treeViewsService')

export class TreeViewsService
  extends Disposable
  implements ITreeViewsService, IMainThreadTreeViews
{
  declare readonly _serviceBrand: undefined

  private readonly _views = new Map<string, ITreeViewModel>()
  private _extHost: IExtHostTreeViews | undefined
  // Latest visibility each view reported, kept apart from the model: models
  // are rebuilt on $registerTreeDataProvider and dropped on reset(), but the
  // mounted view component never re-pushes on its own — replay from here.
  private readonly _reportedVisibility = new Map<string, boolean>()

  private readonly _onDidChangeView = this._register(new Emitter<string>())
  readonly onDidChangeView: Event<string> = this._onDidChangeView.event

  setExtHost(extHost: IExtHostTreeViews): void {
    this._extHost = extHost
  }

  hasProvider(viewId: string): boolean {
    return this._views.has(viewId)
  }

  getRoots(viewId: string): readonly ITreeItemDto[] | null {
    return this._views.get(viewId)?.roots ?? null
  }

  getChildren(viewId: string, parentHandle: number): readonly ITreeItemDto[] | null {
    return this._views.get(viewId)?.children.get(parentHandle) ?? null
  }

  async loadChildren(viewId: string, parentHandle?: number): Promise<void> {
    const model = this._views.get(viewId)
    if (!model || !this._extHost) return
    const page = parentHandle ?? ROOT_PAGE
    // A pull started before its page was invalidated still sits in inflight
    // but belongs to a dead epoch: it is discarded on settle, so it must not
    // dedupe a retry — otherwise nothing ever pulls again and the page stays
    // blank.
    const epoch = model.pageEpoch.get(page) ?? 0
    const pending = model.inflight.get(page)
    if (pending && pending.epoch === epoch) return pending.promise
    const pull = this._extHost
      .$getChildren(viewId, parentHandle)
      .then((items) => {
        const current = this._views.get(viewId)
        if (current !== model || (model.pageEpoch.get(page) ?? 0) !== epoch) return
        this._setPage(model, page, items)
        this._onDidChangeView.fire(viewId)
      })
      .catch((err: unknown) => {
        console.warn(
          `[treeViews] $getChildren(${viewId}, ${parentHandle ?? 'root'}) failed: ${(err as Error).message}`,
        )
      })
      .finally(() => {
        if (model.inflight.get(page)?.promise === pull) model.inflight.delete(page)
      })
    model.inflight.set(page, { epoch, promise: pull })
    return pull
  }

  setViewVisibility(viewId: string, visible: boolean): void {
    this._reportedVisibility.set(viewId, visible)
    const model = this._views.get(viewId)
    if (!model || !this._extHost) return
    if (model.lastVisible === visible) return
    model.lastVisible = visible
    void this._extHost.$acceptTreeViewVisibility(viewId, visible)
  }

  setSelection(viewId: string, handles: number[]): void {
    if (!this._views.has(viewId) || !this._extHost) return
    void this._extHost.$acceptSelection(viewId, handles)
  }

  setExpansionState(viewId: string, handle: number, expanded: boolean): void {
    if (!this._views.has(viewId) || !this._extHost) return
    void this._extHost.$acceptExpansionState(viewId, handle, expanded)
  }

  executeTreeItemCommand(viewId: string, handle: number, commandId?: string): void {
    if (!this._views.has(viewId) || !this._extHost) return
    const execution = this._extHost.$executeTreeItemCommand(viewId, handle, commandId)
    void execution.catch((err: unknown) => {
      console.warn(
        `[treeViews] $executeTreeItemCommand(${viewId}, ${handle}${
          commandId !== undefined ? `, ${commandId}` : ''
        }) failed: ${(err as Error).message}`,
      )
    })
  }

  reset(): void {
    this._views.clear()
    this._extHost = undefined
  }

  // --- IMainThreadTreeViews (host → renderer) ---

  $registerTreeDataProvider(viewId: string): Promise<void> {
    console.debug(`[treeViews] provider registered: ${viewId}`)
    const model: ITreeViewModel = {
      roots: null,
      children: new Map(),
      pageByHandle: new Map(),
      pageEpoch: new Map(),
      inflight: new Map(),
      lastVisible: undefined,
    }
    this._views.set(viewId, model)
    // Host restart / provider re-registration swaps the model behind a mounted
    // view's back; replay what that view last reported and seed the dedupe.
    const reported = this._reportedVisibility.get(viewId)
    if (reported !== undefined && this._extHost) {
      model.lastVisible = reported
      void this._extHost.$acceptTreeViewVisibility(viewId, reported)
    }
    this._onDidChangeView.fire(viewId)
    return Promise.resolve()
  }

  $unregisterTreeDataProvider(viewId: string): Promise<void> {
    console.debug(`[treeViews] provider unregistered: ${viewId}`)
    if (this._views.delete(viewId)) {
      this._onDidChangeView.fire(viewId)
    }
    return Promise.resolve()
  }

  $refresh(viewId: string, items?: ITreeItemDto[]): Promise<void> {
    const model = this._views.get(viewId)
    if (!model) return Promise.resolve()

    if (!items || items.length === 0) {
      console.debug(`[treeViews] refresh (whole view): ${viewId}`)
      this._invalidateAll(model)
      this._onDidChangeView.fire(viewId)
      return Promise.resolve()
    }

    // Per-subtree: replace each named row in place (its label / icon / command
    // may have changed) and drop only its children page, so sibling and
    // unrelated pages — and the expansion state keyed by handle — survive.
    let changed = false
    for (const item of items) {
      const page = model.pageByHandle.get(item.handle)
      if (page === undefined) continue
      const replaced = this._replaceRow(model, page, item)
      if (!replaced) continue
      this._invalidatePage(model, item.handle)
      changed = true
    }
    if (!changed) {
      console.debug(`[treeViews] refresh: no cached rows for ${viewId}, nothing to invalidate`)
      return Promise.resolve()
    }
    console.debug(
      `[treeViews] refresh (subtrees): ${viewId} handles=${items.map((i) => i.handle).join(',')}`,
    )
    this._onDidChangeView.fire(viewId)
    return Promise.resolve()
  }

  // --- cache bookkeeping ---

  private _setPage(model: ITreeViewModel, page: number, items: readonly ITreeItemDto[]): void {
    const kept = new Set(items.map((item) => item.handle))
    const previous = page === ROOT_PAGE ? model.roots : model.children.get(page)
    for (const item of previous ?? []) {
      if (kept.has(item.handle)) continue
      model.pageByHandle.delete(item.handle)
      this._invalidatePage(model, item.handle)
    }
    if (page === ROOT_PAGE) model.roots = items
    else model.children.set(page, items)
    for (const item of items) model.pageByHandle.set(item.handle, page)
  }

  /** Drop a page's cached children (recursively), leaving the row itself. */
  private _invalidatePage(model: ITreeViewModel, page: number): void {
    const items = page === ROOT_PAGE ? model.roots : model.children.get(page)
    if (page === ROOT_PAGE) model.roots = null
    else model.children.delete(page)
    this._bumpEpoch(model, page)
    for (const item of items ?? []) {
      model.pageByHandle.delete(item.handle)
      this._invalidatePage(model, item.handle)
    }
  }

  private _invalidateAll(model: ITreeViewModel): void {
    model.roots = null
    model.children.clear()
    model.pageByHandle.clear()
    for (const page of model.inflight.keys()) this._bumpEpoch(model, page)
  }

  /**
   * Only a page with a pull in flight needs an epoch — a later pull reads the
   * current value, so an untracked page starts at 0. Entries are monotonic and
   * never removed: resetting one would make a pull from an older epoch compare
   * equal again and resurrect the rows this invalidation just dropped.
   */
  private _bumpEpoch(model: ITreeViewModel, page: number): void {
    if (!model.inflight.has(page)) return
    model.pageEpoch.set(page, (model.pageEpoch.get(page) ?? 0) + 1)
  }

  private _replaceRow(model: ITreeViewModel, page: number, item: ITreeItemDto): boolean {
    const items = page === ROOT_PAGE ? model.roots : model.children.get(page)
    if (!items) return false
    const index = items.findIndex((cached) => cached.handle === item.handle)
    if (index < 0) return false
    const next = [...items]
    next[index] = item
    if (page === ROOT_PAGE) model.roots = next
    else model.children.set(page, next)
    return true
  }
}
