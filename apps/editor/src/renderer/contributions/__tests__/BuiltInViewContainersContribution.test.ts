import { afterEach, describe, expect, it } from 'vitest'
import { ViewContainerLocation, ViewContainerRegistry } from '@universe-editor/platform'
import { BuiltInViewContainersContribution } from '../BuiltInViewContainersContribution.js'

describe('BuiltInViewContainersContribution', () => {
  let contribution: BuiltInViewContainersContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('registers the Explorer, Outline, and Output view containers on construction', () => {
    contribution = new BuiltInViewContainersContribution()

    const explorer = ViewContainerRegistry.getViewContainer('workbench.view.explorer')
    expect(explorer).toBeDefined()
    expect(explorer?.label).toBe('Explorer')
    expect(explorer?.location).toBe(ViewContainerLocation.SideBar)

    const outline = ViewContainerRegistry.getViewContainer('workbench.view.outline')
    expect(outline).toBeDefined()
    expect(outline?.label).toBe('Outline')
    expect(outline?.location).toBe(ViewContainerLocation.SecondarySideBar)

    const output = ViewContainerRegistry.getViewContainer('workbench.view.output')
    expect(output).toBeDefined()
    expect(output?.label).toBe('Output')
    expect(output?.location).toBe(ViewContainerLocation.Panel)
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

    const panelIds = ViewContainerRegistry.getViewContainers(ViewContainerLocation.Panel).map(
      (c) => c.id,
    )
    expect(panelIds).toContain('workbench.view.output')
  })

  it('dispose unregisters every container', () => {
    const local = new BuiltInViewContainersContribution()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.explorer')).toBeDefined()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.outline')).toBeDefined()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.output')).toBeDefined()
    local.dispose()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.explorer')).toBeUndefined()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.outline')).toBeUndefined()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.output')).toBeUndefined()
  })
})
