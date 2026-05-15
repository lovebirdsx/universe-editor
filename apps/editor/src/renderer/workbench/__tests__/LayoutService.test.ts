import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { autorun, PartId } from '@universe-editor/platform'
import { LayoutService } from '../layout/LayoutService.js'

describe('LayoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as { api?: unknown }).api
  })

  it('defaults all parts to visible', () => {
    const svc = new LayoutService()
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.SideBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('defaults sizes to sensible values', () => {
    const svc = new LayoutService()
    expect(svc.sizes.get()).toEqual({ sidebar: 240, panel: 200 })
  })

  it('setVisible only notifies on actual change', () => {
    const svc = new LayoutService()
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
    const svc = new LayoutService()
    svc.toggleVisible(PartId.Panel)
    expect(svc.getVisible(PartId.Panel)).toBe(false)
    svc.toggleVisible(PartId.Panel)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('setVisible preserves other parts', () => {
    const svc = new LayoutService()
    svc.setVisible(PartId.SideBar, false)
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
  })

  it('setSize updates observable and ignores no-op writes', () => {
    const svc = new LayoutService()
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

  it('load is a no-op when window.api is missing', async () => {
    const svc = new LayoutService()
    await expect(svc.load()).resolves.toBeUndefined()
    // initial values remain
    expect(svc.sizes.get()).toEqual({ sidebar: 240, panel: 200 })
  })

  it('load restores visible and sizes from storage', async () => {
    const get = vi.fn().mockResolvedValue({
      visible: { [PartId.SideBar]: false },
      sizes: { sidebar: 333, panel: 444 },
    })
    const set = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { storage: { get, set } }

    const svc = new LayoutService()
    await svc.load()

    expect(svc.getVisible(PartId.SideBar)).toBe(false)
    expect(svc.sizes.get()).toEqual({ sidebar: 333, panel: 444 })
    // load itself must not trigger save
    expect(set).not.toHaveBeenCalled()
  })

  it('setSize triggers debounced save', async () => {
    const get = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { storage: { get, set } }

    const svc = new LayoutService()
    svc.setSize('sidebar', 250)
    svc.setSize('sidebar', 260)
    svc.setSize('sidebar', 270)

    expect(set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(
      'workbench.layout',
      expect.objectContaining({
        sizes: { sidebar: 270, panel: 200 },
      }),
    )
  })

  it('setVisible also triggers persist', async () => {
    const get = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { storage: { get, set } }

    const svc = new LayoutService()
    svc.setVisible(PartId.Panel, false)
    await vi.advanceTimersByTimeAsync(250)

    expect(set).toHaveBeenCalledTimes(1)
  })

  it('save() flushes pending debounce immediately', async () => {
    const get = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { storage: { get, set } }

    const svc = new LayoutService()
    svc.setSize('panel', 300)
    await svc.save()

    expect(set).toHaveBeenCalledTimes(1)
    // ensure scheduled timer was cleared (no second call after debounce window)
    await vi.advanceTimersByTimeAsync(500)
    expect(set).toHaveBeenCalledTimes(1)
  })
})
