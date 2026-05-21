import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IHostService,
  ILoggerService,
  InstantiationService,
  KeybindingsRegistry,
  LogLevel,
  MenuId,
  MenuRegistry,
  NullLogger,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type IHostService as IHostServiceType,
} from '@universe-editor/platform'
import {
  AboutAction,
  CloseWindowAction,
  RestartEditorAction,
  ToggleDevToolsAction,
} from '../windowActions.js'

function makeHostStub(): IHostServiceType & {
  closeCalls: number
  restartCalls: number
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
    restart: vi.fn().mockResolvedValue(undefined) as unknown as () => Promise<void>,
    toggleDevTools: vi.fn().mockResolvedValue(undefined) as unknown as () => Promise<void>,
    closeCalls: 0,
    restartCalls: 0,
    devToolsCalls: 0,
  } as never
}

function runCommand(commandId: string, host: IHostServiceType): void {
  const services = new ServiceCollection()
  services.set(IHostService, host)
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  })
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

  it('registers RestartEditor with keybinding + File menu wiring', () => {
    disposables.push(registerAction2(RestartEditorAction))
    expect(CommandsRegistry.getCommand(RestartEditorAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+r')).toBe(RestartEditorAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.MenubarFileMenu).some(
        (i) => 'command' in i && i.command === RestartEditorAction.ID,
      ),
    ).toBe(true)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === RestartEditorAction.ID,
      ),
    ).toBe(true)
  })

  it('RestartEditor.run invokes IHostService.restart', () => {
    disposables.push(registerAction2(RestartEditorAction))
    const host = makeHostStub()
    runCommand(RestartEditorAction.ID, host)
    expect(host.restart).toHaveBeenCalledTimes(1)
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
    expect(() => runCommand(AboutAction.ID, host)).not.toThrow()
  })
})
