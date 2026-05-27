import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  autorun,
  Event,
  PartId,
  type IFocusableRegistry,
  type IStorageService,
  type IViewsService,
} from '@universe-editor/platform'
import { LayoutService } from '../LayoutService.js'
import {
  IViewContainerMemoryService,
  ViewContainerMemoryService,
} from '../../focus/ViewContainerMemoryService.js'

interface FakeStorage extends IStorageService {
  readonly get: ReturnType<typeof vi.fn>
  readonly set: ReturnType<typeof vi.fn>
}

function makeStorage(initial: unknown = undefined): FakeStorage {
  const fake = {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(initial),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: Event.None,
  } as unknown as FakeStorage
  return fake
}

function makeViewsService(): IViewsService {
  return {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
    getActiveViewContainerId: vi.fn(),
  } as unknown as IViewsService
}

function makeFocusableRegistry(): IFocusableRegistry {
  return {
    _serviceBrand: undefined,
    register: vi.fn(() => ({ dispose() {} })),
    get: vi.fn(),
    onDidChange: Event.None,
  } as unknown as IFocusableRegistry
}

function makeViewContainerMemory(): IViewContainerMemoryService {
  return new ViewContainerMemoryService()
}

function newSvc(storage: IStorageService = makeStorage()): LayoutService {
  return new LayoutService(
    storage,
    makeViewsService(),
    makeFocusableRegistry(),
    makeViewContainerMemory(),
  )
}

describe('LayoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults all parts to visible', () => {
    const svc = newSvc()
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.SideBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
    expect(svc.getVisible(PartId.SecondarySideBar)).toBe(false)
  })

  it('defaults sizes to sensible values', () => {
    const svc = newSvc()
    expect(svc.sizes.get()).toEqual({ sidebar: 240, secondarySidebar: 300, panel: 200 })
  })

  it('setVisible only notifies on actual change', () => {
    const svc = newSvc()
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.visible.read(r)
      spy()
    })
    spy.mockClear()

    svc.setVisible(PartId.SideBar, true) // same value
    expect(spy).toHaveBeenCalledTimes(0)

    svc.setVisible(PartId.SideBar, false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(svc.getVisible(PartId.SideBar)).toBe(false)
    d.dispose()
  })

  it('toggleVisible flips the part', () => {
    const svc = newSvc()
    svc.toggleVisible(PartId.Panel)
    expect(svc.getVisible(PartId.Panel)).toBe(false)
    svc.toggleVisible(PartId.Panel)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('setVisible preserves other parts', () => {
    const svc = newSvc()
    svc.setVisible(PartId.SideBar, false)
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('setSize updates observable and ignores no-op writes', () => {
    const svc = newSvc()
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.sizes.read(r)
      spy()
    })
    spy.mockClear()

    svc.setSize('sidebar', 240) // same value
    expect(spy).toHaveBeenCalledTimes(0)

    svc.setSize('sidebar', 320)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(svc.sizes.get()).toEqual({ sidebar: 320, secondarySidebar: 300, panel: 200 })
    d.dispose()
  })

  it('load is a no-op when storage returns undefined', async () => {
    const svc = newSvc(makeStorage(undefined))
    await expect(svc.load()).resolves.toBeUndefined()
    expect(svc.sizes.get()).toEqual({ sidebar: 240, secondarySidebar: 300, panel: 200 })
  })

  it('load restores visible and sizes from storage', async () => {
    const storage = makeStorage({
      visible: { [PartId.SideBar]: false },
      sizes: { sidebar: 333, secondarySidebar: 400, panel: 444 },
    })
    const svc = newSvc(storage)
    await svc.load()

    expect(svc.getVisible(PartId.SideBar)).toBe(false)
    expect(svc.sizes.get()).toEqual({ sidebar: 333, secondarySidebar: 400, panel: 444 })
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('setSize triggers debounced save', async () => {
    const storage = makeStorage()
    const svc = newSvc(storage)
    svc.setSize('sidebar', 250)
    svc.setSize('sidebar', 260)
    svc.setSize('sidebar', 270)

    expect(storage.set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)

    expect(storage.set).toHaveBeenCalledTimes(1)
    expect(storage.set).toHaveBeenCalledWith(
      'workbench.layout',
      expect.objectContaining({
        sizes: expect.objectContaining({ sidebar: 270, panel: 200 }),
      }),
      expect.any(Number),
    )
  })

  it('setVisible also triggers persist', async () => {
    const storage = makeStorage()
    const svc = newSvc(storage)
    svc.setVisible(PartId.Panel, false)
    await vi.advanceTimersByTimeAsync(250)

    expect(storage.set).toHaveBeenCalledTimes(1)
  })

  it('save() flushes pending debounce immediately', async () => {
    const storage = makeStorage()
    const svc = newSvc(storage)
    svc.setSize('panel', 300)
    await svc.save()

    expect(storage.set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(storage.set).toHaveBeenCalledTimes(1)
  })

  it('round-trip: sidebar resize persists and is restored on next load', async () => {
    // Session 1: user drags sidebar to 350px, app saves on debounce
    let savedPayload: unknown
    const storage1 = makeStorage()
    storage1.set.mockImplementation((_key: string, value: unknown) => {
      savedPayload = value
      return Promise.resolve()
    })
    const svc1 = newSvc(storage1)
    svc1.setSize('sidebar', 350)
    await vi.advanceTimersByTimeAsync(250)
    expect(storage1.set).toHaveBeenCalledTimes(1)

    // Session 2: new LayoutService instance with same storage, loads persisted state
    const storage2 = makeStorage(savedPayload)
    const svc2 = newSvc(storage2)
    await svc2.load()

    expect(svc2.sizes.get().sidebar).toBe(350)
    expect(storage2.set).not.toHaveBeenCalled()
  })
})
