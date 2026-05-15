/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILayoutService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '@universe-editor/platform'
import type { ILayoutService, LayoutSizes } from '@universe-editor/platform'
import { PartId } from '@universe-editor/platform'

const STORAGE_KEY = 'workbench.layout'
const SAVE_DEBOUNCE_MS = 200

const INITIAL_VISIBLE: Readonly<Record<PartId, boolean>> = {
  [PartId.ActivityBar]: true,
  [PartId.SideBar]: true,
  [PartId.EditorArea]: true,
  [PartId.Panel]: true,
  [PartId.StatusBar]: true,
}

const INITIAL_SIZES: Readonly<LayoutSizes> = {
  sidebar: 240,
  panel: 200,
}

interface PersistedLayout {
  visible?: Partial<Record<PartId, boolean>>
  sizes?: Partial<LayoutSizes>
}

type StorageApi = {
  get: <T = unknown>(key: string) => Promise<T | undefined>
  set: (key: string, value: unknown) => Promise<void>
}

function getStorage(): StorageApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.api?.storage
}

export class LayoutService implements ILayoutService {
  declare readonly _serviceBrand: undefined

  readonly visible = observableValue<Readonly<Record<PartId, boolean>>>(
    'LayoutService.visible',
    INITIAL_VISIBLE,
  )
  readonly sizes = observableValue<Readonly<LayoutSizes>>('LayoutService.sizes', INITIAL_SIZES)

  private _suspendPersist = false
  private _saveTimer: ReturnType<typeof setTimeout> | undefined

  getVisible(part: PartId): boolean {
    return this.visible.get()[part]
  }

  setVisible(part: PartId, visible: boolean): void {
    if (this.visible.get()[part] === visible) return
    this.visible.set({ ...this.visible.get(), [part]: visible }, undefined)
    this._schedulePersist()
  }

  toggleVisible(part: PartId): void {
    this.setVisible(part, !this.getVisible(part))
  }

  setSize(key: keyof LayoutSizes, value: number): void {
    const current = this.sizes.get()
    if (current[key] === value) return
    this.sizes.set({ ...current, [key]: value }, undefined)
    this._schedulePersist()
  }

  async load(): Promise<void> {
    const storage = getStorage()
    if (!storage) return
    let data: PersistedLayout | undefined
    try {
      data = await storage.get<PersistedLayout>(STORAGE_KEY)
    } catch {
      return
    }
    if (!data) return

    this._suspendPersist = true
    try {
      if (data.visible) {
        const merged = { ...this.visible.get() }
        for (const part of Object.keys(data.visible) as PartId[]) {
          const v = data.visible[part]
          if (typeof v === 'boolean') merged[part] = v
        }
        this.visible.set(merged, undefined)
      }
      if (data.sizes) {
        const merged = { ...this.sizes.get() }
        if (typeof data.sizes.sidebar === 'number') merged.sidebar = data.sizes.sidebar
        if (typeof data.sizes.panel === 'number') merged.panel = data.sizes.panel
        this.sizes.set(merged, undefined)
      }
    } finally {
      this._suspendPersist = false
    }
  }

  async save(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    const storage = getStorage()
    if (!storage) return
    const payload: PersistedLayout = {
      visible: this.visible.get(),
      sizes: this.sizes.get(),
    }
    try {
      await storage.set(STORAGE_KEY, payload)
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
}
