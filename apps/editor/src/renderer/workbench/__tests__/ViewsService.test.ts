import { describe, it, expect } from 'vitest'
import { ViewContainerLocation } from '@universe-editor/platform'
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
})
