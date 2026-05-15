import { describe, it, expect, vi } from 'vitest'
import { autorun, PartId } from '@universe-editor/platform'
import { LayoutService } from '../layout/LayoutService.js'

describe('LayoutService', () => {
  it('defaults all parts to visible', () => {
    const svc = new LayoutService()
    expect(svc.getVisible(PartId.ActivityBar)).toBe(true)
    expect(svc.getVisible(PartId.SideBar)).toBe(true)
    expect(svc.getVisible(PartId.Panel)).toBe(true)
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
})
