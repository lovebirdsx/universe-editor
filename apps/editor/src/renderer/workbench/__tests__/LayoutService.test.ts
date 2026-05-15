import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { autorun, PartId, type IStorageService } from '@universe-editor/platform'
import { LayoutService } from '../layout/LayoutService.js'

interface FakeStorage extends IStorageService {
  readonly get: ReturnType<typeof vi.fn>
  readonly set: ReturnType<typeof vi.fn>
}

function makeStorage(initial: unknown = undefined): FakeStorage {
  const fake = {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(initial),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeStorage
  return fake
}

describe('LayoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults all parts to visible', () => {
    const svc = new LayoutService(makeStorage())
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.SideBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('defaults sizes to sensible values', () => {
    const svc = new LayoutService(makeStorage())
    expect(svc.sizes.get()).toEqual({ sidebar: 240, panel: 200 })
  })

  it('setVisible only notifies on actual change', () => {
    const svc = new LayoutService(makeStorage())
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
    const svc = new LayoutService(makeStorage())
    svc.toggleVisible(PartId.Panel)
    expect(svc.getVisible(PartId.Panel)).toBe(false)
    svc.toggleVisible(PartId.Panel)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('setVisible preserves other parts', () => {
    const svc = new LayoutService(makeStorage())
    svc.setVisible(PartId.SideBar, false)
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('setSize updates observable and ignores no-op writes', () => {
    const svc = new LayoutService(makeStorage())
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
    expect(svc.sizes.get()).toEqual({ sidebar: 320, panel: 200 })
    d.dispose()
  })

  it('load is a no-op when storage returns undefined', async () => {
    const svc = new LayoutService(makeStorage(undefined))
    await expect(svc.load()).resolves.toBeUndefined()
    expect(svc.sizes.get()).toEqual({ sidebar: 240, panel: 200 })
  })

  it('load restores visible and sizes from storage', async () => {
    const storage = makeStorage({
      visible: { [PartId.SideBar]: false },
      sizes: { sidebar: 333, panel: 444 },
    })
    const svc = new LayoutService(storage)
    await svc.load()

    expect(svc.getVisible(PartId.SideBar)).toBe(false)
    expect(svc.sizes.get()).toEqual({ sidebar: 333, panel: 444 })
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('setSize triggers debounced save', async () => {
    const storage = makeStorage()
    const svc = new LayoutService(storage)
    svc.setSize('sidebar', 250)
    svc.setSize('sidebar', 260)
    svc.setSize('sidebar', 270)

    expect(storage.set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)

    expect(storage.set).toHaveBeenCalledTimes(1)
    expect(storage.set).toHaveBeenCalledWith(
      'workbench.layout',
      expect.objectContaining({
        sizes: { sidebar: 270, panel: 200 },
      }),
    )
  })

  it('setVisible also triggers persist', async () => {
    const storage = makeStorage()
    const svc = new LayoutService(storage)
    svc.setVisible(PartId.Panel, false)
    await vi.advanceTimersByTimeAsync(250)

    expect(storage.set).toHaveBeenCalledTimes(1)
  })

  it('save() flushes pending debounce immediately', async () => {
    const storage = makeStorage()
    const svc = new LayoutService(storage)
    svc.setSize('panel', 300)
    await svc.save()

    expect(storage.set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(storage.set).toHaveBeenCalledTimes(1)
  })
})
