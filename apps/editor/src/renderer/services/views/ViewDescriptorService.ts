/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer implementation of IViewDescriptorService — the runtime view↔container
 *  mapping layer. Mirrors VSCode's ViewDescriptorService: the static registries
 *  declare defaults, this service layers user customizations (move / reorder /
 *  collapse / size / generated containers) and persists them per workspace.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  IWorkspaceService,
  StorageScope,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  localize,
  observableValue,
} from '@universe-editor/platform'
import type {
  IViewContainerDescriptor,
  IViewDescriptor,
  IViewDescriptorService,
  IViewState,
} from '@universe-editor/platform'

const STORAGE_KEY = 'workbench.viewCustomizations'
const SAVE_DEBOUNCE_MS = 200
const INITIAL_LOAD_TIMEOUT_MS = 500
const GENERATED_PREFIX = 'workbench.view.generated.'

interface PersistedCustomizations {
  viewLocations?: Record<string, string>
  containerLocations?: Record<string, number>
  containerOrders?: Record<string, number>
  viewStates?: Record<string, IViewState>
  generatedContainers?: Array<{ id: string; location: number; order: number }>
}

const LOCATION_TAG: Record<number, string> = {
  [ViewContainerLocation.SideBar]: 'sidebar',
  [ViewContainerLocation.SecondarySideBar]: 'secondary',
  [ViewContainerLocation.Panel]: 'panel',
}

export class ViewDescriptorService extends Disposable implements IViewDescriptorService {
  declare readonly _serviceBrand: undefined

  readonly version = observableValue<number>('ViewDescriptorService.version', 0)

  /** viewId → custom home container (absent ⇒ default container). */
  private readonly _viewLocations = new Map<string, string>()
  /** containerId → custom location (absent ⇒ default location). */
  private readonly _containerLocations = new Map<string, number>()
  /** containerId → custom order within its location. */
  private readonly _containerOrders = new Map<string, number>()
  /** viewId → collapse / size / order state. */
  private readonly _viewStates = new Map<string, IViewState>()
  /** Generated containers we own, so we can re-register them on load. */
  private readonly _generated = new Map<string, { location: number; order: number }>()

  private _suspendPersist = false
  private _saveTimer: ReturnType<typeof setTimeout> | undefined
  private _initialLoadDone = false
  private _genCounter = 0

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {
    super()

    // Re-query on any registry change (built-in/extension views appearing).
    this._register(ViewRegistry.onDidRegisterView(() => this._bump()))
    this._register(ViewRegistry.onDidDeregisterView(() => this._bump()))
    this._register(ViewContainerRegistry.onDidRegisterViewContainer(() => this._bump()))
    this._register(ViewContainerRegistry.onDidDeregisterViewContainer(() => this._bump()))

    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        if (!this._initialLoadDone) return
        void this._reload()
      }),
    )
  }

  // -- container queries ----------------------------------------------------

  getViewContainerById(id: string): IViewContainerDescriptor | undefined {
    return ViewContainerRegistry.getViewContainer(id)
  }

  getViewContainerLocation(containerId: string): ViewContainerLocation | undefined {
    const custom = this._containerLocations.get(containerId)
    if (custom !== undefined) return custom
    return ViewContainerRegistry.getViewContainer(containerId)?.location
  }

  getViewContainersByLocation(
    location: ViewContainerLocation,
  ): readonly IViewContainerDescriptor[] {
    return ViewContainerRegistry.getAllViewContainers()
      .filter((c) => this.getViewContainerLocation(c.id) === location)
      .filter((c) => this.getViewsByContainer(c.id).length > 0)
      .sort((a, b) => this._containerSortKey(a) - this._containerSortKey(b))
  }

  private _containerSortKey(c: IViewContainerDescriptor): number {
    const custom = this._containerOrders.get(c.id)
    return custom !== undefined ? custom : c.order
  }

  // -- view queries ---------------------------------------------------------

  getDefaultContainerById(viewId: string): IViewContainerDescriptor | undefined {
    const view = ViewRegistry.getView(viewId)
    if (!view) return undefined
    return ViewContainerRegistry.getViewContainer(view.containerId)
  }

  getViewContainerByViewId(viewId: string): IViewContainerDescriptor | undefined {
    const customId = this._viewLocations.get(viewId)
    if (customId) {
      const container = ViewContainerRegistry.getViewContainer(customId)
      if (container) return container
    }
    return this.getDefaultContainerById(viewId)
  }

  getViewLocationById(viewId: string): ViewContainerLocation | undefined {
    const container = this.getViewContainerByViewId(viewId)
    return container ? this.getViewContainerLocation(container.id) : undefined
  }

  getViewsByContainer(containerId: string): readonly IViewDescriptor[] {
    return ViewRegistry.getAllViews()
      .filter((v) => this.getViewContainerByViewId(v.id)?.id === containerId)
      .sort((a, b) => this._viewSortKey(a) - this._viewSortKey(b))
  }

  private _viewSortKey(v: IViewDescriptor): number {
    const order = this._viewStates.get(v.id)?.order
    return order !== undefined ? order : v.order
  }

  // -- mutations ------------------------------------------------------------

  moveViewsToContainer(viewIds: readonly string[], targetContainerId: string): void {
    const target = ViewContainerRegistry.getViewContainer(targetContainerId)
    if (!target || target.rejectAddedViews) return

    const movable = viewIds.filter((id) => {
      const view = ViewRegistry.getView(id)
      if (!view || view.canMoveView === false) return false
      return this.getViewContainerByViewId(id)?.id !== targetContainerId
    })
    if (movable.length === 0) return

    const sourceContainers = new Set(
      movable.map((id) => this.getViewContainerByViewId(id)?.id).filter((x): x is string => !!x),
    )

    // Append moved views after the target's current views.
    let nextOrder = this.getViewsByContainer(targetContainerId).reduce(
      (max, v) => Math.max(max, this._viewSortKey(v)),
      -1,
    )
    for (const id of movable) {
      const defaultId = this.getDefaultContainerById(id)?.id
      if (defaultId === targetContainerId) this._viewLocations.delete(id)
      else this._viewLocations.set(id, targetContainerId)
      nextOrder += 1
      this._setViewState(id, { order: nextOrder })
    }

    for (const sourceId of sourceContainers) this._cleanupGeneratedContainer(sourceId)
    this._bumpAndPersist()
  }

  moveViewToLocation(viewId: string, location: ViewContainerLocation): void {
    const view = ViewRegistry.getView(viewId)
    if (!view || view.canMoveView === false) return
    const container = this._registerGeneratedContainer(location)
    this.moveViewsToContainer([viewId], container.id)
  }

  moveViewContainerToLocation(containerId: string, location: ViewContainerLocation): void {
    const container = ViewContainerRegistry.getViewContainer(containerId)
    if (!container || container.canMoveView === false) return
    if (this.getViewContainerLocation(containerId) === location) return

    // Place at the end of the destination location.
    const maxOrder = this.getViewContainersByLocation(location).reduce(
      (max, c) => Math.max(max, this._containerSortKey(c)),
      -1,
    )
    if (container.location === location) this._containerLocations.delete(containerId)
    else this._containerLocations.set(containerId, location)
    this._containerOrders.set(containerId, maxOrder + 1)

    const gen = this._generated.get(containerId)
    if (gen) this._generated.set(containerId, { location, order: maxOrder + 1 })

    this._bumpAndPersist()
  }

  moveViewInContainer(containerId: string, viewId: string, targetViewId: string): void {
    if (viewId === targetViewId) return
    const ordered = this.getViewsByContainer(containerId).map((v) => v.id)
    const from = ordered.indexOf(viewId)
    const to = ordered.indexOf(targetViewId)
    if (from < 0 || to < 0) return
    ordered.splice(from, 1)
    ordered.splice(to, 0, viewId)
    ordered.forEach((id, index) => this._setViewState(id, { order: index }))
    this._bumpAndPersist()
  }

  moveContainerInLocation(containerId: string, targetContainerId: string): void {
    if (containerId === targetContainerId) return
    const location = this.getViewContainerLocation(containerId)
    if (location === undefined) return
    const ordered = this.getViewContainersByLocation(location).map((c) => c.id)
    const from = ordered.indexOf(containerId)
    const to = ordered.indexOf(targetContainerId)
    if (from < 0 || to < 0) return
    ordered.splice(from, 1)
    ordered.splice(to, 0, containerId)
    ordered.forEach((id, index) => this._containerOrders.set(id, index))
    this._bumpAndPersist()
  }

  // -- per-view state -------------------------------------------------------

  getViewState(viewId: string): IViewState {
    return this._viewStates.get(viewId) ?? {}
  }

  setViewCollapsed(viewId: string, collapsed: boolean): void {
    if (this.getViewState(viewId).collapsed === collapsed) return
    this._setViewState(viewId, { collapsed })
    this._bumpAndPersist()
  }

  setViewSizes(sizes: ReadonlyArray<{ id: string; size: number }>): void {
    let changed = false
    for (const { id, size } of sizes) {
      if (this.getViewState(id).size === size) continue
      this._setViewState(id, { size })
      changed = true
    }
    if (changed) this._schedulePersist()
  }

  reset(): void {
    for (const id of [...this._generated.keys()]) {
      ViewContainerRegistry.deregisterViewContainer(id)
    }
    this._viewLocations.clear()
    this._containerLocations.clear()
    this._containerOrders.clear()
    this._viewStates.clear()
    this._generated.clear()
    this._bumpAndPersist()
  }

  // -- generated containers -------------------------------------------------

  private _registerGeneratedContainer(
    location: ViewContainerLocation,
    existingId?: string,
    order?: number,
  ): IViewContainerDescriptor {
    const id = existingId ?? this._nextGeneratedId(location)
    const maxOrder =
      order ??
      this.getViewContainersByLocation(location).reduce(
        (max, c) => Math.max(max, this._containerSortKey(c)),
        -1,
      ) + 1
    const descriptor: IViewContainerDescriptor = {
      id,
      label: localize('viewContainer.generated', 'Custom Views'),
      icon: 'window',
      order: maxOrder,
      location,
      generated: true,
    }
    this._generated.set(id, { location, order: maxOrder })
    this._containerOrders.set(id, maxOrder)
    this._register(ViewContainerRegistry.registerViewContainer(descriptor))
    return descriptor
  }

  private _nextGeneratedId(location: ViewContainerLocation): string {
    const tag = LOCATION_TAG[location] ?? 'sidebar'
    let id: string
    do {
      this._genCounter += 1
      id = `${GENERATED_PREFIX}${tag}.${this._genCounter}`
    } while (ViewContainerRegistry.getViewContainer(id))
    return id
  }

  private _cleanupGeneratedContainer(containerId: string): void {
    if (!this._generated.has(containerId)) return
    const stillUsed =
      this.getViewsByContainer(containerId).length > 0 ||
      [...this._viewLocations.values()].includes(containerId)
    if (stillUsed) return
    this._generated.delete(containerId)
    this._containerLocations.delete(containerId)
    this._containerOrders.delete(containerId)
    ViewContainerRegistry.deregisterViewContainer(containerId)
  }

  private _setViewState(viewId: string, patch: Partial<IViewState>): void {
    this._viewStates.set(viewId, { ...this.getViewState(viewId), ...patch })
  }

  // -- persistence ----------------------------------------------------------

  private _bump(): void {
    this.version.set(this.version.get() + 1, undefined)
  }

  private _bumpAndPersist(): void {
    this._bump()
    this._schedulePersist()
  }

  async load(): Promise<void> {
    this.loadDefaults()
    await this.reconcileFromStorage()
  }

  /**
   * Synchronous default state (no WORKSPACE storage read) so the workbench can
   * mount without waiting for main-side hydration. The static registries already
   * declare the default view↔container mapping; there are no user customizations
   * to apply until reconcileFromStorage() runs.
   */
  loadDefaults(): void {
    // No-op: the default mapping is served directly from the registries; the
    // customization maps start empty. Present for symmetry with the other
    // restore services and to document the two-phase contract.
  }

  /**
   * Read persisted view/container customizations from WORKSPACE scope and apply
   * them. Waits for the cold-start workspace-scope event so the read hits the
   * hydrated backend; runs off the first-paint critical path (see main.tsx).
   */
  async reconcileFromStorage(): Promise<void> {
    if (!this._workspace.current) {
      await new Promise<void>((resolve) => {
        let resolved = false
        const settle = () => {
          if (resolved) return
          resolved = true
          subscription.dispose()
          clearTimeout(timer)
          resolve()
        }
        const subscription = this._register(this._storage.onDidChangeWorkspaceScope(settle))
        const timer = setTimeout(settle, INITIAL_LOAD_TIMEOUT_MS)
      })
    }
    await this._loadFromStorage()
    this._initialLoadDone = true
  }

  private async _loadFromStorage(): Promise<void> {
    let data: PersistedCustomizations | undefined
    try {
      data = await this._storage.get<PersistedCustomizations>(STORAGE_KEY, StorageScope.WORKSPACE)
    } catch {
      return
    }
    if (!data) return

    this._suspendPersist = true
    try {
      // Generated containers first so view-location lookups resolve to them.
      for (const g of data.generatedContainers ?? []) {
        if (ViewContainerRegistry.getViewContainer(g.id)) continue
        const n = this._parseGeneratedCounter(g.id)
        if (n !== undefined) this._genCounter = Math.max(this._genCounter, n)
        this._registerGeneratedContainer(g.location, g.id, g.order)
      }
      for (const [viewId, containerId] of Object.entries(data.viewLocations ?? {})) {
        this._viewLocations.set(viewId, containerId)
      }
      for (const [containerId, location] of Object.entries(data.containerLocations ?? {})) {
        this._containerLocations.set(containerId, location)
      }
      for (const [containerId, order] of Object.entries(data.containerOrders ?? {})) {
        this._containerOrders.set(containerId, order)
      }
      for (const [viewId, state] of Object.entries(data.viewStates ?? {})) {
        this._viewStates.set(viewId, state)
      }
    } finally {
      this._suspendPersist = false
    }
    this._bump()
  }

  private _parseGeneratedCounter(id: string): number | undefined {
    if (!id.startsWith(GENERATED_PREFIX)) return undefined
    const tail = id.slice(GENERATED_PREFIX.length).split('.').pop()
    const n = tail ? Number(tail) : NaN
    return Number.isFinite(n) ? n : undefined
  }

  async save(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    const payload: PersistedCustomizations = {
      viewLocations: Object.fromEntries(this._viewLocations),
      containerLocations: Object.fromEntries(this._containerLocations),
      containerOrders: Object.fromEntries(this._containerOrders),
      viewStates: Object.fromEntries(this._viewStates),
      generatedContainers: [...this._generated.entries()].map(([id, g]) => ({
        id,
        location: g.location,
        order: g.order,
      })),
    }
    try {
      await this._storage.set(STORAGE_KEY, payload, StorageScope.WORKSPACE)
    } catch {
      // best-effort
    }
  }

  private async _reload(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    this._suspendPersist = true
    try {
      for (const id of [...this._generated.keys()]) {
        ViewContainerRegistry.deregisterViewContainer(id)
      }
      this._viewLocations.clear()
      this._containerLocations.clear()
      this._containerOrders.clear()
      this._viewStates.clear()
      this._generated.clear()
    } finally {
      this._suspendPersist = false
    }
    await this._loadFromStorage()
  }

  private _schedulePersist(): void {
    if (this._suspendPersist) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined
      void this.save()
    }, SAVE_DEBOUNCE_MS)
  }
}
