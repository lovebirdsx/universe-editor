import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IContextKeyService,
  ILayoutService,
  IViewsService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  PartId,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  ShowExplorerAction,
  TogglePanelAction,
  ToggleSecondarySidebarVisibilityAction,
  ToggleSidebarVisibilityAction,
} from '../../actions/layoutActions.js'

describe('Built-in layout Action2s', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose()
    }
  })

  it('registerAction2(ToggleSidebarVisibilityAction) wires command + keybinding + menu', () => {
    disposables.push(registerAction2(ToggleSidebarVisibilityAction))
    expect(CommandsRegistry.getCommand(ToggleSidebarVisibilityAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+b')).toBe(ToggleSidebarVisibilityAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.MenubarViewMenu).some(
        (i) => 'command' in i && i.command === ToggleSidebarVisibilityAction.ID,
      ),
    ).toBe(true)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === ToggleSidebarVisibilityAction.ID,
      ),
    ).toBe(true)
  })

  it('Toggle Side Bar handler calls layoutService.toggleVisible(SideBar)', async () => {
    const toggleVisible = vi.fn()
    const services = new ServiceCollection()
    services.set(ILayoutService, { _serviceBrand: undefined, toggleVisible } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ToggleSidebarVisibilityAction))
    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(ToggleSidebarVisibilityAction.ID)!
      cmd.handler(accessor)
    })
    expect(toggleVisible).toHaveBeenCalledWith(PartId.SideBar)
  })

  it('Toggle Secondary Side Bar opens default view container if none active', async () => {
    const toggleVisible = vi.fn()
    const getVisible = vi.fn().mockReturnValue(true)
    const getActiveViewContainerId = vi.fn().mockReturnValue(undefined)
    const openViewContainer = vi.fn()
    const services = new ServiceCollection()
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      toggleVisible,
      getVisible,
    } as never)
    services.set(IViewsService, {
      _serviceBrand: undefined,
      getActiveViewContainerId,
      openViewContainer,
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ToggleSecondarySidebarVisibilityAction))
    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(ToggleSecondarySidebarVisibilityAction.ID)!
      cmd.handler(accessor)
    })
    expect(toggleVisible).toHaveBeenCalledWith(PartId.SecondarySideBar)
    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.outline')
  })

  it('TogglePanel handler toggles Panel and opens Output if no container is active', async () => {
    const toggleVisible = vi.fn()
    const getVisible = vi.fn().mockReturnValue(true)
    const getActiveViewContainerId = vi.fn().mockReturnValue(undefined)
    const openViewContainer = vi.fn()
    const services = new ServiceCollection()
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      toggleVisible,
      getVisible,
    } as never)
    services.set(IViewsService, {
      _serviceBrand: undefined,
      getActiveViewContainerId,
      openViewContainer,
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(TogglePanelAction))
    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(TogglePanelAction.ID)!
      cmd.handler(accessor)
    })
    expect(toggleVisible).toHaveBeenCalledWith(PartId.Panel)
    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.output')
  })

  it('dispose unregisters everything', () => {
    const d = registerAction2(ToggleSidebarVisibilityAction)
    d.dispose()
    expect(CommandsRegistry.getCommand(ToggleSidebarVisibilityAction.ID)).toBeUndefined()
    const ctx = new ContextKeyService()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+b', ctx)).toBeUndefined()
    expect(
      MenuRegistry.getMenuItems(MenuId.MenubarViewMenu).some(
        (i) => 'command' in i && i.command === ToggleSidebarVisibilityAction.ID,
      ),
    ).toBe(false)
    ctx.dispose()
  })

  // Reference to IContextKeyService kept to ensure tree-shaking doesn't drop the
  // type import — the value is used in actions/index.ts at runtime.
  it('IContextKeyService decorator is available', () => {
    expect(IContextKeyService).toBeDefined()
  })
})

describe('ShowExplorerAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function makePart(focused: boolean) {
    return { focus: vi.fn(), isFocused: vi.fn().mockReturnValue(focused) }
  }

  function makeLayoutService(visible: boolean, focused: boolean) {
    const part = makePart(focused)
    const setVisible = vi.fn()
    const focusView = vi.fn().mockResolvedValue(true)
    const focusPart = vi.fn().mockResolvedValue(true)
    const mock = {
      _serviceBrand: undefined,
      getVisible: vi.fn().mockReturnValue(visible),
      setVisible,
      getPart: vi.fn().mockReturnValue(part),
      focusView,
      focusPart,
    } as never
    return { mock, setVisible, part, focusView, focusPart }
  }

  function makeViewsService(activeId: string | undefined) {
    const openViewContainer = vi.fn()
    const mock = {
      _serviceBrand: undefined,
      openViewContainer,
      getActiveViewContainerId: vi.fn().mockReturnValue(activeId),
    } as never
    return { mock, openViewContainer }
  }

  it('registerAction2(ShowExplorerAction) wires command + keybinding ctrl+shift+e + F1 menu', () => {
    disposables.push(registerAction2(ShowExplorerAction))
    expect(CommandsRegistry.getCommand(ShowExplorerAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+e')).toBe(ShowExplorerAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === ShowExplorerAction.ID,
      ),
    ).toBe(true)
  })

  it('run() calls focusView when SideBar is hidden', async () => {
    const layout = makeLayoutService(false, false)
    const views = makeViewsService(undefined)
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ShowExplorerAction))

    await inst.invokeFunction((accessor) => {
      return CommandsRegistry.getCommand(ShowExplorerAction.ID)!.handler(accessor)
    })

    expect(layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(layout.setVisible).not.toHaveBeenCalled()
  })

  it('run() calls focusView when SideBar is visible with explorer active but not focused', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService('workbench.view.explorer')
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ShowExplorerAction))

    await inst.invokeFunction((accessor) => {
      return CommandsRegistry.getCommand(ShowExplorerAction.ID)!.handler(accessor)
    })

    expect(layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(layout.setVisible).not.toHaveBeenCalled()
  })

  it('run() hides SideBar when visible with explorer active and focused', async () => {
    const layout = makeLayoutService(true, true)
    const views = makeViewsService('workbench.view.explorer')
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ShowExplorerAction))

    await inst.invokeFunction((accessor) => {
      return CommandsRegistry.getCommand(ShowExplorerAction.ID)!.handler(accessor)
    })

    expect(layout.setVisible).toHaveBeenCalledWith(PartId.SideBar, false)
    expect(layout.focusView).not.toHaveBeenCalled()
  })

  it('run() calls focusView when SideBar is visible with a different container', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService('workbench.view.search')
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ShowExplorerAction))

    await inst.invokeFunction((accessor) => {
      return CommandsRegistry.getCommand(ShowExplorerAction.ID)!.handler(accessor)
    })

    expect(layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(layout.setVisible).not.toHaveBeenCalled()
  })
})
