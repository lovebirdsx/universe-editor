/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewsService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  IViewDescriptorService,
  IWorkspaceService,
  StorageScope,
  autorun,
  observableValue,
} from '@universe-editor/platform'
import type { IViewsService } from '@universe-editor/platform'
import { ViewContainerLocation, ViewContainerRegistry } from '@universe-editor/platform'

const STORAGE_KEY = 'workbench.views'
const SAVE_DEBOUNCE_MS = 200
const INITIAL_LOAD_TIMEOUT_MS = 500

const ALL_LOCATIONS: readonly ViewContainerLocation[] = [
  ViewContainerLocation.SideBar,
  ViewContainerLocation.SecondarySideBar,
  ViewContainerLocation.Panel,
]

interface PersistedViews {
  activeContainerByLocation?: Partial<Record<number, string>>
}

export class ViewsService extends Disposable implements IViewsService {
  declare readonly _serviceBrand: undefined

  readonly activeContainerByLocation = observableValue<
    Readonly<Record<number, string | undefined>>
  >('ViewsService.activeContainerByLocation', {})

  private _suspendPersist = false
  private _saveTimer: ReturnType<typeof setTimeout> | undefined
  private _initialLoadDone = false

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IViewDescriptorService private readonly _viewDescriptors: IViewDescriptorService,
  ) {
    super()
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        // The first scope event on cold start is consumed by load()'s settle;
        // only genuine runtime workspace switches (after initial load) reload.
        if (!this._initialLoadDone) return
        void this._reload()
      }),
    )

    // Auto-select first container for a location whenever a new container
    // registers and the location has nothing active yet.
    this._register(
      ViewContainerRegistry.onDidRegisterViewContainer(() => {
        this._seedDefaults()
      }),
    )
    // A container moving between locations (drag) can leave its old location's
    // active pointer dangling; re-seed so every location keeps a valid active.
    this._register(
      ViewContainerRegistry.onDidDeregisterViewContainer(() => {
        this._reconcileActive()
      }),
    )
    this._register(
      autorun((r) => {
        this._viewDescriptors.version.read(r)
        this._reconcileActive()
      }),
    )
  }

  openViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const cur = this.activeContainerByLocation.get()
    if (cur[location] === containerId) return
    this.activeContainerByLocation.set({ ...cur, [location]: containerId }, undefined)
    this._schedulePersist()
  }

  closeViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const cur = this.activeContainerByLocation.get()
    if (cur[location] !== containerId) return
    const next = { ...cur }
    delete next[location]
    this.activeContainerByLocation.set(next, undefined)
    this._schedulePersist()
  }

  getActiveViewContainerId(location: number): string | undefined {
    return this.activeContainerByLocation.get()[location]
  }

  async load(): Promise<void> {
    this.loadDefaults()
    await this.reconcileFromStorage()
  }

  /**
   * Synchronous, WORKSPACE-storage-free default state so the workbench can mount
   * immediately without waiting for main-side workspace hydration. Seeds each
   * location's first registered container as active (already done in the
   * constructor's autorun; re-run here to be explicit and idempotent).
   */
  loadDefaults(): void {
    this._seedDefaults()
  }

  /**
   * Read the persisted active-container selection from WORKSPACE scope and apply
   * it. Waits for the cold-start workspace-scope event so the read hits the
   * hydrated backend; runs off the first-paint critical path (see main.tsx).
   */
  async reconcileFromStorage(): Promise<void> {
    // RendererWorkspaceService.current is null at construction and hydrated
    // asynchronously; the storage layer fires onDidChangeWorkspaceScope once
    // hydration lands. Wait for that first event (or a short timeout for the
    // genuine empty-window case) so the cold-start event is consumed here
    // instead of firing _reload and clobbering a runtime container selection.
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
    let data: PersistedViews | undefined
    try {
      data = await this._storage.get<PersistedViews>(STORAGE_KEY, StorageScope.WORKSPACE)
    } catch {
      this._seedDefaults()
      return
    }
    if (!data?.activeContainerByLocation) {
      this._seedDefaults()
      return
    }

    this._suspendPersist = true
    try {
      const merged: Record<number, string | undefined> = {}
      for (const [k, v] of Object.entries(data.activeContainerByLocation)) {
        if (typeof v === 'string') merged[Number(k)] = v
      }
      this.activeContainerByLocation.set(merged, undefined)
    } finally {
      this._suspendPersist = false
    }
    this._seedDefaults()
  }

  async save(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    const payload: PersistedViews = {
      activeContainerByLocation: this.activeContainerByLocation.get() as Record<number, string>,
    }
    try {
      await this._storage.set(STORAGE_KEY, payload, StorageScope.WORKSPACE)
    } catch {
      // swallow: persistence is best-effort
    }
  }

  /** Reset to empty then re-load from the new WORKSPACE scope. */
  private async _reload(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    this._suspendPersist = true
    try {
      this.activeContainerByLocation.set({}, undefined)
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

  private _getLocation(id: string): number {
    const location = this._viewDescriptors.getViewContainerLocation(id)
    return location ?? ViewContainerLocation.SideBar
  }

  /**
   * Ensure every location that has at least one registered container also has
   * an active container. Persistence stays untouched (defaults are derived,
   * not user choices) so save/load remain idempotent for unselected locations.
   */
  private _seedDefaults(): void {
    const cur = this.activeContainerByLocation.get()
    const next: Record<number, string | undefined> = { ...cur }
    let changed = false
    for (const loc of ALL_LOCATIONS) {
      if (next[loc]) continue
      const first = this._viewDescriptors.getViewContainersByLocation(loc)[0]
      if (!first) continue
      next[loc] = first.id
      changed = true
    }
    if (!changed) return
    this._suspendPersist = true
    try {
      this.activeContainerByLocation.set(next, undefined)
    } finally {
      this._suspendPersist = false
    }
  }

  /**
   * After a container moves between locations, is removed, or is emptied (its
   * last view dragged out / merged away), the active pointer for a location may
   * reference a container that no longer shows there. Drop stale pointers and
   * re-seed so each location resolves to a visible container.
   */
  private _reconcileActive(): void {
    const cur = this.activeContainerByLocation.get()
    const next: Record<number, string | undefined> = { ...cur }
    let changed = false
    for (const loc of ALL_LOCATIONS) {
      const activeId = next[loc]
      if (!activeId) continue
      const visible = this._viewDescriptors
        .getViewContainersByLocation(loc)
        .some((c) => c.id === activeId)
      if (!visible) {
        delete next[loc]
        changed = true
      }
    }
    if (changed) {
      this._suspendPersist = true
      try {
        this.activeContainerByLocation.set(next, undefined)
      } finally {
        this._suspendPersist = false
      }
    }
    this._seedDefaults()
  }
}
