import { describe, it, expect, afterEach } from 'vitest'
import { ViewContainerLocation, ViewContainerRegistry } from '@universe-editor/platform'
import { ViewsService } from '../sidebar/ViewsService.js'

describe('ViewsService', () => {
  it('openViewContainer sets the active container for the location', () => {
    const svc = new ViewsService()
    svc.openViewContainer('explorer')
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')
  })

  it('openViewContainer replaces previously active container at the same location', () => {
    const svc = new ViewsService()
    svc.openViewContainer('explorer')
    svc.openViewContainer('search')
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('search')
  })

  it('closeViewContainer clears active when matching, otherwise no-op', () => {
    const svc = new ViewsService()
    svc.openViewContainer('explorer')

    svc.closeViewContainer('search') // not active, no-op
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')

    svc.closeViewContainer('explorer')
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBeUndefined()
  })

  describe('secondary sidebar location resolution', () => {
    let cleanup: (() => void) | undefined

    afterEach(() => {
      cleanup?.()
      cleanup = undefined
    })

    it('routes registered secondary sidebar containers to the correct location', () => {
      const disposable = ViewContainerRegistry.registerViewContainer({
        id: 'test.outline',
        label: 'Outline',
        icon: 'search',
        order: 1,
        location: ViewContainerLocation.SecondarySideBar,
      })
      cleanup = () => disposable.dispose()

      const svc = new ViewsService()
      svc.openViewContainer('test.outline')

      expect(svc.getActiveViewContainerId(ViewContainerLocation.SecondarySideBar)).toBe(
        'test.outline',
      )
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBeUndefined()
    })

    it('primary and secondary sidebar containers are independent', () => {
      const d = ViewContainerRegistry.registerViewContainer({
        id: 'test.outline2',
        label: 'Outline',
        icon: 'search',
        order: 1,
        location: ViewContainerLocation.SecondarySideBar,
      })
      cleanup = () => d.dispose()

      const svc = new ViewsService()
      svc.openViewContainer('explorer')
      svc.openViewContainer('test.outline2')

      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SecondarySideBar)).toBe(
        'test.outline2',
      )
    })
  })
})
