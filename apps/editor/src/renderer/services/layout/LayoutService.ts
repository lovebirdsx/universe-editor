/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILayoutService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  IFocusableRegistry,
  IStorageService,
  IViewsService,
  StorageScope,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  observableValue,
  toDisposable,
} from '@universe-editor/platform'
import type {
  IDisposable,
  IFocusPartOptions,
  ILayoutService,
  IPart,
  IViewDescriptor,
  LayoutSizes,
} from '@universe-editor/platform'
import { PartId } from '@universe-editor/platform'
import { IViewContainerMemoryService } from '../focus/ViewContainerMemoryService.js'

const STORAGE_KEY = 'workbench.layout'
const SAVE_DEBOUNCE_MS = 200

const INITIAL_VISIBLE: Readonly<Record<PartId, boolean>> = {
  [PartId.ActivityBar]: true,
  [PartId.SideBar]: true,
  [PartId.SecondarySideBar]: false,
  [PartId.EditorArea]: true,
  [PartId.Panel]: false,
  [PartId.StatusBar]: true,
}

const INITIAL_SIZES: Readonly<LayoutSizes> = {
  sidebar: 240,
  secondarySidebar: 300,
  panel: 200,
}

interface PersistedLayout {
  visible?: Partial<Record<PartId, boolean>>
  sizes?: Partial<LayoutSizes>
}

export class LayoutService extends Disposable implements ILayoutService {
  declare readonly _serviceBrand: undefined

  readonly visible = observableValue<Readonly<Record<PartId, boolean>>>(
    'LayoutService.visible',
    INITIAL_VISIBLE,
  )
  readonly sizes = observableValue<Readonly<LayoutSizes>>('LayoutService.sizes', INITIAL_SIZES)

  private _suspendPersist = false
  private _saveTimer: ReturnType<typeof setTimeout> | undefined

  private readonly _parts = new Map<PartId, IPart>()
  private readonly _onDidRegisterPart = this._register(new Emitter<IPart>())
  readonly onDidRegisterPart = this._onDidRegisterPart.event

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IViewsService private readonly _viewsService: IViewsService,
    @IFocusableRegistry private readonly _focusableRegistry: IFocusableRegistry,
    @IViewContainerMemoryService
    private readonly _viewContainerMemory: IViewContainerMemoryService,
  ) {
    super()
    // Reload from the new workspace's storage whenever the WORKSPACE scope swaps.
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        void this._reload()
      }),
    )
  }

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
    let data: PersistedLayout | undefined
    try {
      data = await this._storage.get<PersistedLayout>(STORAGE_KEY, StorageScope.WORKSPACE)
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
        if (typeof data.sizes.secondarySidebar === 'number')
          merged.secondarySidebar = data.sizes.secondarySidebar
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
    const payload: PersistedLayout = {
      visible: this.visible.get(),
      sizes: this.sizes.get(),
    }
    try {
      await this._storage.set(STORAGE_KEY, payload, StorageScope.WORKSPACE)
    } catch {
      // swallow: persistence is best-effort
    }
  }

  /**
   * Reset to defaults, then re-load from the (now switched) WORKSPACE scope.
   * Suspends persistence across the reset so we don't write defaults back to
   * the new workspace before its own data is read.
   */
  private async _reload(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    this._suspendPersist = true
    try {
      this.visible.set(INITIAL_VISIBLE, undefined)
      this.sizes.set(INITIAL_SIZES, undefined)
    } finally {
      this._suspendPersist = false
    }
    await this.load()
  }

  private _schedulePersist(): void {
    if (this._suspendPersist) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined
      void this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  // -- Part registry --------------------------------------------------------

  registerPart(part: IPart): IDisposable {
    const existing = this._parts.get(part.id)
    if (existing && existing !== part) {
      throw new Error(
        `[LayoutService] Part '${part.id}' is already registered; unregister the previous instance first.`,
      )
    }
    this._parts.set(part.id, part)
    this._onDidRegisterPart.fire(part)
    return toDisposable(() => {
      if (this._parts.get(part.id) === part) {
        this._parts.delete(part.id)
      }
    })
  }

  getPart<T extends IPart = IPart>(id: PartId): T | undefined {
    return this._parts.get(id) as T | undefined
  }

  getParts(): readonly IPart[] {
    return [...this._parts.values()]
  }

  // -- Focus routing --------------------------------------------------------

  async focusPart(id: PartId, opts: IFocusPartOptions = {}): Promise<boolean> {
    const part = this._parts.get(id)
    if (!part) return false
    if (!this.getVisible(id)) this.setVisible(id, true)

    const lastViewId = this._lastFocusedViewForPart(id)
    if (lastViewId) {
      const ok = await this.focusView(lastViewId, opts)
      if (ok) return true
    }

    try {
      await part.whenMounted(opts.timeoutMs)
    } catch {
      return false
    }
    part.focus()
    return true
  }

  private _lastFocusedViewForPart(id: PartId): string | undefined {
    const location = LayoutService._locationForPartId(id)
    if (location === undefined) return undefined
    const containerId = this._viewsService.getActiveViewContainerId(location)
    if (!containerId) return undefined
    return this._viewContainerMemory.getLastFocusedView(containerId)
  }

  private static _locationForPartId(id: PartId): ViewContainerLocation | undefined {
    switch (id) {
      case PartId.SideBar:
        return ViewContainerLocation.SideBar
      case PartId.SecondarySideBar:
        return ViewContainerLocation.SecondarySideBar
      case PartId.Panel:
        return ViewContainerLocation.Panel
      default:
        return undefined
    }
  }

  async focusView(viewId: string, opts: IFocusPartOptions = {}): Promise<boolean> {
    const descriptor = this._findViewDescriptor(viewId)
    if (!descriptor) return false
    const container = ViewContainerRegistry.getViewContainer(descriptor.containerId)
    if (!container) return false

    // Make the container visible at its location, then bring its hosting part up.
    this._viewsService.openViewContainer(descriptor.containerId)
    const partId = LayoutService._partIdForLocation(container.location)
    const ok = await this.focusPart(partId, opts)
    if (!ok) return false

    // Wait one rAF / microtask so the React subtree gets a chance to mount the
    // view component and call useViewFocusable.
    const getter = this._focusableRegistry.get(viewId)
    if (getter) {
      await new Promise<void>((r) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r())
        else queueMicrotask(r)
      })
      const el = this._focusableRegistry.get(viewId)?.() ?? getter()
      ;(el as { focus?(): void } | null)?.focus?.()
    }
    return true
  }

  private _findViewDescriptor(viewId: string): IViewDescriptor | undefined {
    for (const c of [
      ...ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar),
      ...ViewContainerRegistry.getViewContainers(ViewContainerLocation.SecondarySideBar),
      ...ViewContainerRegistry.getViewContainers(ViewContainerLocation.Panel),
    ]) {
      const v = ViewRegistry.getViewsForContainer(c.id).find((d) => d.id === viewId)
      if (v) return v
    }
    return undefined
  }

  private static _partIdForLocation(loc: ViewContainerLocation): PartId {
    switch (loc) {
      case ViewContainerLocation.SideBar:
        return PartId.SideBar
      case ViewContainerLocation.SecondarySideBar:
        return PartId.SecondarySideBar
      case ViewContainerLocation.Panel:
        return PartId.Panel
    }
  }
}
