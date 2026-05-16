import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IHostService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type IHostService as IHostServiceType,
} from '@universe-editor/platform'
import { AboutAction, CloseWindowAction, ToggleDevToolsAction } from '../windowActions.js'

function makeHostStub(): IHostServiceType & {
  closeCalls: number
  devToolsCalls: number
} {
  const emitter = new Emitter<boolean>()
  return {
    _serviceBrand: undefined,
    platform: 'win32',
    onDidChangeMaximized: emitter.event,
    isMaximized: () => Promise.resolve(false),
    minimizeWindow: () => Promise.resolve(),
    toggleMaximizeWindow: () => Promise.resolve(),
    closeWindow: vi.fn().mockResolvedValue(undefined) as unknown as () => Promise<void>,
    toggleDevTools: vi.fn().mockResolvedValue(undefined) as unknown as () => Promise<void>,
    closeCalls: 0,
    devToolsCalls: 0,
  } as never
}

function runCommand(commandId: string, host: IHostServiceType): void {
  const services = new ServiceCollection()
  services.set(IHostService, host)
  const inst = new InstantiationService(services)
  inst.invokeFunction((accessor) => {
    const cmd = CommandsRegistry.getCommand(commandId)!
    cmd.handler(accessor)
  })
}

describe('windowActions', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers CloseWindow with keybinding + Help menu wiring', () => {
    disposables.push(registerAction2(CloseWindowAction))
    expect(CommandsRegistry.getCommand(CloseWindowAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+w')).toBe(CloseWindowAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.MenubarFileMenu).some(
        (i) => 'command' in i && i.command === CloseWindowAction.ID,
      ),
    ).toBe(true)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === CloseWindowAction.ID,
      ),
    ).toBe(true)
  })

  it('CloseWindow.run invokes IHostService.closeWindow', () => {
    disposables.push(registerAction2(CloseWindowAction))
    const host = makeHostStub()
    runCommand(CloseWindowAction.ID, host)
    expect(host.closeWindow).toHaveBeenCalledTimes(1)
  })

  it('registers ToggleDevTools with keybinding + Help menu wiring', () => {
    disposables.push(registerAction2(ToggleDevToolsAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+i')).toBe(ToggleDevToolsAction.ID)
    const helpItems = MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu)
    const entry = helpItems.find((i) => 'command' in i && i.command === ToggleDevToolsAction.ID)
    expect(entry).toBeDefined()
    expect(entry?.group).toBe('5_tools')
  })

  it('ToggleDevTools.run invokes IHostService.toggleDevTools', () => {
    disposables.push(registerAction2(ToggleDevToolsAction))
    const host = makeHostStub()
    runCommand(ToggleDevToolsAction.ID, host)
    expect(host.toggleDevTools).toHaveBeenCalledTimes(1)
  })

  it('registers About in Help menu without a keybinding', () => {
    disposables.push(registerAction2(AboutAction))
    const helpItems = MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu)
    const entry = helpItems.find((i) => 'command' in i && i.command === AboutAction.ID)
    expect(entry).toBeDefined()
    expect(entry?.group).toBe('z_about')
  })

  it('About.run is callable without throwing', () => {
    disposables.push(registerAction2(AboutAction))
    const host = makeHostStub()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    runCommand(AboutAction.ID, host)
    expect(infoSpy).toHaveBeenCalled()
    infoSpy.mockRestore()
  })
})
