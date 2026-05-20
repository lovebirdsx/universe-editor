/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewsService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, observableValue } from '@universe-editor/platform'
import type { IViewsService } from '@universe-editor/platform'
import { ViewContainerLocation, ViewContainerRegistry } from '@universe-editor/platform'

const STORAGE_KEY = 'workbench.views'
const SAVE_DEBOUNCE_MS = 200

interface PersistedViews {
  activeContainerByLocation?: Partial<Record<number, string>>
}

export class ViewsService implements IViewsService {
  declare readonly _serviceBrand: undefined

  readonly activeContainerByLocation = observableValue<
    Readonly<Record<number, string | undefined>>
  >('ViewsService.activeContainerByLocation', {})

  private _suspendPersist = false
  private _saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(@IStorageService private readonly _storage: IStorageService) {}

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
    let data: PersistedViews | undefined
    try {
      data = await this._storage.get<PersistedViews>(STORAGE_KEY)
    } catch {
      return
    }
    if (!data?.activeContainerByLocation) return

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
      await this._storage.set(STORAGE_KEY, payload)
    } catch {
      // swallow: persistence is best-effort
    }
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
}
