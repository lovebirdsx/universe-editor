/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewsService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  IWorkspaceService,
  StorageScope,
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
    const descriptor = ViewContainerRegistry.getViewContainer(id)
    return descriptor?.location ?? ViewContainerLocation.SideBar
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
      const first = ViewContainerRegistry.getViewContainers(loc)[0]
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
}
