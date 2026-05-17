import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  ILayoutService,
  IQuickInputService,
  IViewsService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  PartId,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IQuickPickItem,
} from '@universe-editor/platform'
import {
  ShowCommandsAction,
  TogglePanelAction,
  ToggleSecondarySidebarVisibilityAction,
  ToggleSidebarVisibilityAction,
} from '../../actions/layoutActions.js'
import { FileEditorInput } from '../../workbench/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../workbench/editor/FileEditorRegistry.js'

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

  it('TogglePanel handler toggles Panel', async () => {
    const toggleVisible = vi.fn()
    const services = new ServiceCollection()
    services.set(ILayoutService, { _serviceBrand: undefined, toggleVisible } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(TogglePanelAction))
    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(TogglePanelAction.ID)!
      cmd.handler(accessor)
    })
    expect(toggleVisible).toHaveBeenCalledWith(PartId.Panel)
  })

  it('ShowCommands invokes quick input and executes selected command', async () => {
    const pick = vi.fn().mockResolvedValue({ id: 'demo.cmd' })
    const executeCommand = vi.fn().mockResolvedValue(undefined)
    const services = new ServiceCollection()
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: undefined },
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(CommandsRegistry.registerCommand('demo.cmd', () => undefined))
    disposables.push(registerAction2(ShowCommandsAction))
    await inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(ShowCommandsAction.ID)!
      await cmd.handler(accessor)
    })
    expect(pick).toHaveBeenCalled()
    const pickedOptions = pick.mock.calls[0]?.[1] as { prefix?: string } | undefined
    expect(pickedOptions?.prefix).toBe('>')
    expect(executeCommand).toHaveBeenCalledWith('demo.cmd')
  })

  it('ShowCommands includes Monaco actions from the active FileEditor', async () => {
    const input = new FileEditorInput(URI.file('/a.ts'), {} as IFileService)
    const fakeEditor = {
      getSupportedActions: () => [
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          alias: '',
          metadata: undefined,
          isSupported: () => true,
          run: () => Promise.resolve(),
        },
      ],
    }
    FileEditorRegistry.register(input, fakeEditor as never)
    disposables.push({ dispose: () => FileEditorRegistry._resetForTests() })

    const pick = vi.fn().mockResolvedValue(undefined)
    const services = new ServiceCollection()
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(ICommandService, { _serviceBrand: undefined, executeCommand: vi.fn() } as never)
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: input },
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ShowCommandsAction))
    await inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(ShowCommandsAction.ID)!
      await cmd.handler(accessor)
    })
    const items = pick.mock.calls[0]?.[0] as IQuickPickItem[] | undefined
    expect(items?.some((i) => i.id === 'editor.action.formatDocument')).toBe(true)
  })

  it('ShowCommands deduplicates Monaco actions already registered as project commands', async () => {
    const input = new FileEditorInput(URI.file('/a.ts'), {} as IFileService)
    const fakeEditor = {
      getSupportedActions: () => [
        {
          id: 'demo.collide',
          label: 'Monaco Collide',
          alias: '',
          metadata: undefined,
          isSupported: () => true,
          run: () => Promise.resolve(),
        },
      ],
    }
    FileEditorRegistry.register(input, fakeEditor as never)
    disposables.push({ dispose: () => FileEditorRegistry._resetForTests() })
    disposables.push(CommandsRegistry.registerCommand('demo.collide', () => undefined))

    const pick = vi.fn().mockResolvedValue(undefined)
    const services = new ServiceCollection()
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(ICommandService, { _serviceBrand: undefined, executeCommand: vi.fn() } as never)
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: input },
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(ShowCommandsAction))
    await inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(ShowCommandsAction.ID)!
      await cmd.handler(accessor)
    })
    const items = pick.mock.calls[0]?.[0] as IQuickPickItem[] | undefined
    const count = items?.filter((i) => i.id === 'demo.collide').length ?? 0
    expect(count).toBe(1)
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
