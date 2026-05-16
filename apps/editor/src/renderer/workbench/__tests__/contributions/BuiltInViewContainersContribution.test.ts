import { afterEach, describe, expect, it } from 'vitest'
import { ViewContainerLocation, ViewContainerRegistry } from '@universe-editor/platform'
import { BuiltInViewContainersContribution } from '../../../contributions/BuiltInViewContainersContribution.js'

describe('BuiltInViewContainersContribution', () => {
  let contribution: BuiltInViewContainersContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('registers the Explorer and Outline view containers on construction', () => {
    contribution = new BuiltInViewContainersContribution()

    const explorer = ViewContainerRegistry.getViewContainer('workbench.view.explorer')
    expect(explorer).toBeDefined()
    expect(explorer?.label).toBe('Explorer')
    expect(explorer?.location).toBe(ViewContainerLocation.SideBar)

    const outline = ViewContainerRegistry.getViewContainer('workbench.view.outline')
    expect(outline).toBeDefined()
    expect(outline?.label).toBe('Outline')
    expect(outline?.location).toBe(ViewContainerLocation.SecondarySideBar)
  })

  it('places each container in the expected location', () => {
    contribution = new BuiltInViewContainersContribution()

    const sideBarIds = ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar).map(
      (c) => c.id,
    )
    expect(sideBarIds).toContain('workbench.view.explorer')

    const secondarySideBarIds = ViewContainerRegistry.getViewContainers(
      ViewContainerLocation.SecondarySideBar,
    ).map((c) => c.id)
    expect(secondarySideBarIds).toContain('workbench.view.outline')
  })

  it('dispose unregisters both containers', () => {
    const local = new BuiltInViewContainersContribution()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.explorer')).toBeDefined()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.outline')).toBeDefined()
    local.dispose()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.explorer')).toBeUndefined()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.outline')).toBeUndefined()
  })
})
