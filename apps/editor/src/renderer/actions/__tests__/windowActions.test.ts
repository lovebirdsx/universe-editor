import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  DisposableTracker,
  Emitter,
  IDialogService,
  IHostService,
  ILifecycleService,
  ILoggerService,
  InstantiationService,
  KeybindingsRegistry,
  LogLevel,
  MenuId,
  MenuRegistry,
  NullLogger,
  ServiceCollection,
  ShutdownReason,
  toDisposable,
  registerAction2,
  setDisposableTracker,
  type IConfirmResult,
  type IDisposable,
  type IHostService as IHostServiceType,
} from '@universe-editor/platform'
import {
  AboutAction,
  CloseWindowAction,
  RestartEditorAction,
  ToggleDevToolsAction,
} from '../windowActions.js'
import {
  IRendererDisposableLeakService,
  RendererDisposableLeakService,
} from '../../services/disposableLeak/DisposableLeakService.js'
import type { IDisposableLeakService } from '../../../shared/ipc/services.js'

const stubProxy: IDisposableLeakService = {
  _serviceBrand: undefined,
  reportLeaks: vi.fn(async () => undefined),
  printLeaks: vi.fn(async () => undefined),
  consumePendingReport: vi.fn(async () => null),
}

class FakeDialogService implements IDialogService {
  declare readonly _serviceBrand: undefined
  result: IConfirmResult = { confirmed: true, choice: 'primary' }
  lastDetail: string | undefined
  async confirm(opts: { detail?: string }): Promise<IConfirmResult> {
    this.lastDetail = opts.detail
    return this.result
  }
  async prompt(): Promise<string | undefined> {
    return undefined
  }
}

class FakeLifecycleService {
  declare readonly _serviceBrand: undefined
  vetoed = false
  phase = 0
  async when(): Promise<void> {}
  onBeforeShutdown = new Emitter<never>().event
  onWillShutdown = new Emitter<never>().event
  async confirmBeforeShutdown(_reason: ShutdownReason): Promise<boolean> {
    return this.vetoed
  }
  async shutdown(_reason: ShutdownReason): Promise<boolean> {
    return this.vetoed
  }
  dispose(): void {}
}

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
    getVersionInfo: vi.fn().mockResolvedValue({
      productName: 'Universe Editor',
      version: '1.2.3',
      electron: '33.0.0',
      node: '20.0.0',
      chromium: '128.0.0',
      v8: '12.0.0',
    }) as unknown as () => Promise<unknown>,
    closeCalls: 0,
    restartCalls: 0,
    devToolsCalls: 0,
  } as never
}

function runCommand(commandId: string, host: IHostServiceType): Promise<unknown> {
  const services = new ServiceCollection()
  services.set(IHostService, host)
  services.set(ILifecycleService, new FakeLifecycleService())
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  })
  const inst = new InstantiationService(services)
  return inst.invokeFunction((accessor) => {
    const cmd = CommandsRegistry.getCommand(commandId)!
    return cmd.handler(accessor) as unknown as Promise<void>
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

  it('RestartEditor.run invokes IHostService.restart', async () => {
    disposables.push(registerAction2(RestartEditorAction))
    const host = makeHostStub()
    await runCommand(RestartEditorAction.ID, host)
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

  it('About.run shows a dialog with version details', async () => {
    disposables.push(registerAction2(AboutAction))
    const host = makeHostStub()
    const dialog = new FakeDialogService()
    const confirm = vi.spyOn(dialog, 'confirm')
    const services = new ServiceCollection()
    services.set(IHostService, host)
    services.set(IDialogService, dialog)
    const inst = new InstantiationService(services)
    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(AboutAction.ID)!
      return cmd.handler(accessor) as unknown as Promise<void>
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(dialog.lastDetail).toContain('1.2.3')
  })
})

describe('RestartEditorAction leak-detection path', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    setDisposableTracker(null)
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  async function runRestart(
    host: IHostServiceType,
    dialog: IDialogService,
    leak: IRendererDisposableLeakService,
    lifecycle = new FakeLifecycleService(),
  ): Promise<void> {
    const services = new ServiceCollection()
    services.set(IHostService, host)
    services.set(IDialogService, dialog)
    services.set(IRendererDisposableLeakService, leak)
    services.set(ILifecycleService, lifecycle)
    const inst = new InstantiationService(services)
    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(RestartEditorAction.ID)!
      return cmd.handler(accessor) as unknown as Promise<void>
    })
  }

  it('skips confirm and restarts when no tracker is installed (production path)', async () => {
    disposables.push(registerAction2(RestartEditorAction))
    const host = makeHostStub()
    const dialog = new FakeDialogService()
    const confirm = vi.spyOn(dialog, 'confirm')
    const leak = new RendererDisposableLeakService(stubProxy)

    await runRestart(host, dialog, leak)

    expect(confirm).not.toHaveBeenCalled()
    expect(host.restart).toHaveBeenCalledTimes(1)
    expect(leak.readUnloadReason()).toBe('unknown')
  })

  it('skips confirm when tracker installed but no leaks', async () => {
    disposables.push(registerAction2(RestartEditorAction))
    setDisposableTracker(new DisposableTracker())
    const host = makeHostStub()
    const dialog = new FakeDialogService()
    const confirm = vi.spyOn(dialog, 'confirm')
    const leak = new RendererDisposableLeakService(stubProxy)

    await runRestart(host, dialog, leak)

    expect(confirm).not.toHaveBeenCalled()
    expect(host.restart).toHaveBeenCalledTimes(1)
    expect(leak.readUnloadReason()).toBe('restart')
  })

  it('shows confirm modal with leak details when tracker reports leaks', async () => {
    disposables.push(registerAction2(RestartEditorAction))
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    disposables.push(toDisposable(() => {}))

    const host = makeHostStub()
    const dialog = new FakeDialogService()
    dialog.result = { confirmed: true, choice: 'primary' }
    const leak = new RendererDisposableLeakService(stubProxy)

    await runRestart(host, dialog, leak)

    expect(dialog.lastDetail).toBeTruthy()
    expect(host.restart).toHaveBeenCalledTimes(1)
    expect(leak.readUnloadReason()).toBe('restart')
  })

  it('does not restart when user cancels the leak confirm', async () => {
    disposables.push(registerAction2(RestartEditorAction))
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    disposables.push(toDisposable(() => {}))

    const host = makeHostStub()
    const dialog = new FakeDialogService()
    dialog.result = { confirmed: false, choice: 'cancel' }
    const leak = new RendererDisposableLeakService(stubProxy)

    await runRestart(host, dialog, leak)

    expect(host.restart).not.toHaveBeenCalled()
    expect(leak.readUnloadReason()).toBe('unknown')
  })
})
