import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ILayoutService,
  IViewsService,
  InstantiationService,
  IStorageService,
  KeybindingsRegistry,
  PartId,
  ServiceCollection,
} from '@universe-editor/platform'
import { LayoutService } from '../../layout/LayoutService.js'
import { LayoutCommandsContribution } from '../../../contributions/LayoutCommandsContribution.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStorageService
}

function makeViewsService(): IViewsService {
  return {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
    closeViewContainer: vi.fn(),
    getActiveViewContainerId: vi.fn().mockReturnValue(undefined),
    // observable not used in these tests
    activeContainerByLocation: undefined,
  } as unknown as IViewsService
}

function makeContainer() {
  const services = new ServiceCollection()
  services.set(IStorageService, makeStorage())
  const instantiation = new InstantiationService(services, true)
  const layoutService = instantiation.createInstance(LayoutService)
  services.set(ILayoutService, layoutService)
  const viewsService = makeViewsService()
  services.set(IViewsService, viewsService)
  return { instantiation, layoutService, viewsService }
}

describe('LayoutCommandsContribution', () => {
  let contribution: LayoutCommandsContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('registers three toggle commands on construction', () => {
    const { instantiation } = makeContainer()
    contribution = instantiation.createInstance(LayoutCommandsContribution)

    expect(CommandsRegistry.getCommand('workbench.action.toggleSidebarVisibility')).toBeDefined()
    expect(
      CommandsRegistry.getCommand('workbench.action.toggleSecondarySidebarVisibility'),
    ).toBeDefined()
    expect(CommandsRegistry.getCommand('workbench.action.togglePanel')).toBeDefined()
  })

  it('registers Ctrl+B / Ctrl+Alt+B / Ctrl+J keybindings', () => {
    const { instantiation } = makeContainer()
    contribution = instantiation.createInstance(LayoutCommandsContribution)

    expect(
      KeybindingsRegistry.getBindingsForKey('ctrl+b').some(
        (b) => b.command === 'workbench.action.toggleSidebarVisibility',
      ),
    ).toBe(true)
    expect(
      KeybindingsRegistry.getBindingsForKey('ctrl+alt+b').some(
        (b) => b.command === 'workbench.action.toggleSecondarySidebarVisibility',
      ),
    ).toBe(true)
    expect(
      KeybindingsRegistry.getBindingsForKey('ctrl+j').some(
        (b) => b.command === 'workbench.action.togglePanel',
      ),
    ).toBe(true)
  })

  it('toggleSidebarVisibility flips ILayoutService.getVisible(SideBar)', () => {
    const { instantiation, layoutService } = makeContainer()
    contribution = instantiation.createInstance(LayoutCommandsContribution)

    const before = layoutService.getVisible(PartId.SideBar)
    instantiation.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand('workbench.action.toggleSidebarVisibility')!
      cmd.handler(accessor)
    })
    expect(layoutService.getVisible(PartId.SideBar)).toBe(!before)
  })

  it('toggleSecondarySidebar opens the Outline view when becoming visible with no active container', () => {
    const { instantiation, layoutService, viewsService } = makeContainer()
    contribution = instantiation.createInstance(LayoutCommandsContribution)

    // Force off first to ensure toggle turns it on
    layoutService.setVisible(PartId.SecondarySideBar, false)
    instantiation.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand('workbench.action.toggleSecondarySidebarVisibility')!
      cmd.handler(accessor)
    })
    expect(layoutService.getVisible(PartId.SecondarySideBar)).toBe(true)
    expect(viewsService.openViewContainer).toHaveBeenCalledWith('workbench.view.outline')
  })

  it('does not call openViewContainer when toggling off', () => {
    const { instantiation, layoutService, viewsService } = makeContainer()
    contribution = instantiation.createInstance(LayoutCommandsContribution)

    layoutService.setVisible(PartId.SecondarySideBar, true)
    instantiation.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand('workbench.action.toggleSecondarySidebarVisibility')!
      cmd.handler(accessor)
    })
    expect(layoutService.getVisible(PartId.SecondarySideBar)).toBe(false)
    expect(viewsService.openViewContainer).not.toHaveBeenCalled()
  })

  it('dispose removes the commands from the registry', () => {
    const { instantiation } = makeContainer()
    const local = instantiation.createInstance(LayoutCommandsContribution)
    expect(CommandsRegistry.getCommand('workbench.action.toggleSidebarVisibility')).toBeDefined()
    local.dispose()
    expect(CommandsRegistry.getCommand('workbench.action.toggleSidebarVisibility')).toBeUndefined()
  })
})
