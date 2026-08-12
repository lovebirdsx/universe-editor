/*---------------------------------------------------------------------------------------------
 *  Renderer-side owner of extension-contributed tree views (VSCode
 *  `MainThreadTreeViews` counterpart). Handles the host → renderer
 *  `mainThreadTreeViews` channel (provider registrations + invalidations) and
 *  caches the pulled `ITreeItemDto` children per view; the ExtensionTreeView
 *  component renders the cache through a workbench-ui TreeModel and pulls
 *  lazily back over `extHostTreeViews` via the proxy set on connect.
 *
 *  Handles are host-allocated and only valid within one model generation: a
 *  `$refresh` clears every cached node and bumps the generation, so a pull
 *  that resolves after a refresh is discarded instead of resurrecting stale
 *  handles (mirrors the host side, which answers unknown handles with []).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, Disposable, Emitter, type Event } from '@universe-editor/platform'
import type {
  IExtHostTreeViews,
  IMainThreadTreeViews,
  ITreeItemDto,
} from '@universe-editor/extensions-common'

interface ITreeViewModel {
  roots: readonly ITreeItemDto[] | null
  readonly children: Map<number, readonly ITreeItemDto[]>
  generation: number
  readonly inflight: Map<number, Promise<void>>
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
    const key = parentHandle ?? -1
    const pending = model.inflight.get(key)
    if (pending) return pending
    const generation = model.generation
    // Omit the optional arg entirely for a roots pull: an explicit `undefined`
    // crosses the JSON wire as `null`, which the host must not mistake for a
    // (stale) parent handle.
    const pull = (
      parentHandle === undefined
        ? this._extHost.$getChildren(viewId)
        : this._extHost.$getChildren(viewId, parentHandle)
    )
      .then((items) => {
        const current = this._views.get(viewId)
        if (current !== model || model.generation !== generation) return
        if (parentHandle === undefined) model.roots = items
        else model.children.set(parentHandle, items)
        this._onDidChangeView.fire(viewId)
      })
      .catch((err: unknown) => {
        console.warn(
          `[treeViews] $getChildren(${viewId}, ${parentHandle ?? 'root'}) failed: ${(err as Error).message}`,
        )
      })
      .finally(() => {
        model.inflight.delete(key)
      })
    model.inflight.set(key, pull)
    return pull
  }

  setViewVisibility(viewId: string, visible: boolean): void {
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

  reset(): void {
    this._views.clear()
    this._extHost = undefined
  }

  // --- IMainThreadTreeViews (host → renderer) ---

  $registerTreeDataProvider(viewId: string): Promise<void> {
    console.debug(`[treeViews] provider registered: ${viewId}`)
    this._views.set(viewId, {
      roots: null,
      children: new Map(),
      generation: 0,
      inflight: new Map(),
      lastVisible: undefined,
    })
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

  $refresh(viewId: string, parentHandles?: number[]): Promise<void> {
    const model = this._views.get(viewId)
    if (!model) return Promise.resolve()
    console.debug(
      `[treeViews] refresh: ${viewId}${parentHandles ? ` (subtree ${parentHandles.join(',')})` : ''}`,
    )
    // Narrowed `parentHandles` belong to a dead generation (the host cleared
    // its handle table), so only whole-view invalidation is sound. The host's
    // first cut never sends handles — treat any refresh as a full one.
    model.generation++
    model.roots = null
    model.children.clear()
    this._onDidChangeView.fire(viewId)
    return Promise.resolve()
  }
}
