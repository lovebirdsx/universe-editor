/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/remoteActions.ts (WSL command surface).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IDialogService,
  IFileDialogService,
  ILifecycleService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  IWindowsService,
  IWorkspaceService,
  InstantiationService,
  LifecycleService,
  MenuId,
  MenuRegistry,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IFileDialogService as IFileDialogServiceType,
  type INotification,
  type INotificationService as INotificationServiceType,
  type IOpenWindowInfo,
  type IProgressService as IProgressServiceType,
  type IQuickInputService as IQuickInputServiceType,
  type IQuickPick,
  type IQuickPickItem,
  type IWorkspaceService as IWorkspaceServiceType,
  type QuickPickInput,
} from '@universe-editor/platform'
import { IRemoteStatusService } from '../../../shared/ipc/remoteStatusService.js'
import type {
  IRemoteStatusService as IRemoteStatusServiceType,
  RemoteConnectionStatusDto,
  RemoteEnvironmentDto,
  WslDistroDto,
} from '../../../shared/ipc/remoteStatusService.js'
import {
  CloseConnectionAction,
  ConnectToHostAction,
  ConnectToWslAction,
  RemoveManualHostAction,
  StopRemoteServerAction,
} from '../remoteActions.js'
import { IRemoteExplorerService } from '../../services/remote/RemoteExplorerService.js'

function distro(name: string, over: Partial<WslDistroDto> = {}): WslDistroDto {
  return { name, isDefault: false, isRunning: false, version: 2, ...over }
}

const ENV: RemoteEnvironmentDto = {
  os: 'linux',
  arch: 'x64',
  homeDir: '/home/u',
  tmpDir: '/tmp',
  pathCaseSensitive: true,
  serverVersion: '0.0.0',
}

interface RemoteStatusStub extends IRemoteStatusServiceType {
  readonly connectCalls: string[]
}

function makeRemoteStatusStub(cfg: {
  hosts?: readonly string[]
  wslDistros?: readonly WslDistroDto[]
  wslError?: Error
}): RemoteStatusStub {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  const connectCalls: string[] = []
  return {
    connectCalls,
    listSshHosts: () => Promise.resolve([...(cfg.hosts ?? [])]),
    listWslDistros: () =>
      cfg.wslError ? Promise.reject(cfg.wslError) : Promise.resolve(cfg.wslDistros ?? []),
    getConnections: () => Promise.resolve([]),
    connect: (authority: string) => {
      connectCalls.push(authority)
      return Promise.resolve(ENV)
    },
    onDidChangeState: emitter.event,
  } as unknown as RemoteStatusStub
}

interface NotificationStub extends INotificationServiceType {
  readonly notified: INotification[]
}

function makeNotificationStub(): NotificationStub {
  const notified: INotification[] = []
  return {
    notified,
    notify: (n: INotification) => notified.push(n),
  } as unknown as NotificationStub
}

function isSeparator(item: QuickPickInput<IQuickPickItem>): boolean {
  return 'type' in item && item.type === 'separator'
}

/**
 * QuickInput stub whose createQuickPick auto-accepts the selectable item at
 * `acceptIndex` on show (undefined → hide without accepting), recording the
 * items every picker was shown with.
 */
function makeQuickInputStub(acceptIndex?: number): IQuickInputServiceType & {
  shownItems: QuickPickInput<IQuickPickItem>[][]
} {
  const shownItems: QuickPickInput<IQuickPickItem>[][] = []
  return {
    _serviceBrand: undefined,
    shownItems,
    createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
      let items: readonly QuickPickInput<T>[] = []
      const acceptEmitter = new Emitter<T[]>()
      const hideEmitter = new Emitter<void>()
      return {
        placeholder: undefined,
        get items() {
          return items
        },
        set items(next: readonly QuickPickInput<T>[]) {
          items = next
        },
        value: '',
        autoFocusFirstItem: true,
        onDidAccept: acceptEmitter.event,
        onDidHide: hideEmitter.event,
        show() {
          shownItems.push([...items])
          if (acceptIndex === undefined) {
            hideEmitter.fire()
            return
          }
          const selectable = items.filter((i): i is T => !isSeparator(i))
          acceptEmitter.fire([selectable[acceptIndex]!])
        },
        hide() {
          hideEmitter.fire()
        },
        dispose() {},
      } as unknown as IQuickPick<T>
    },
    pick: () => Promise.resolve(undefined),
    input: () => Promise.resolve(undefined),
    hide: () => {},
  } as unknown as IQuickInputServiceType & { shownItems: QuickPickInput<IQuickPickItem>[][] }
}

function makeProgressStub(): IProgressServiceType {
  return {
    withProgress: <R>(_o: unknown, task: () => Promise<R>) => task(),
  } as unknown as IProgressServiceType
}

interface FileDialogStub extends IFileDialogServiceType {
  readonly openCalls: number
}

function makeFileDialogStub(): FileDialogStub {
  let openCalls = 0
  return {
    get openCalls() {
      return openCalls
    },
    showOpenDialog: () => {
      openCalls++
      return Promise.resolve(undefined)
    },
  } as unknown as FileDialogStub
}

function makeWorkspaceStub(): IWorkspaceServiceType {
  return {
    current: null,
    openFolder: () => Promise.resolve(),
  } as unknown as IWorkspaceServiceType
}

function runCommand(
  id: string,
  services: {
    remoteStatus: IRemoteStatusServiceType
    notification: INotificationServiceType
    quickInput: IQuickInputServiceType
    fileDialog?: IFileDialogServiceType
  },
  authorityArg?: string,
): Promise<unknown> {
  const collection = new ServiceCollection()
  collection.set(IRemoteStatusService, services.remoteStatus)
  collection.set(INotificationService, services.notification)
  collection.set(IQuickInputService, services.quickInput)
  collection.set(IProgressService, makeProgressStub())
  collection.set(IFileDialogService, services.fileDialog ?? makeFileDialogStub())
  collection.set(IWorkspaceService, makeWorkspaceStub())
  collection.set(ILifecycleService, new LifecycleService())
  const inst = new InstantiationService(collection)
  return new Promise((resolve) => {
    inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(id)!
      resolve(await cmd.handler(accessor, authorityArg))
    })
  })
}

describe('remoteActions — WSL command surface', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('ConnectToWsl registers under the WSL category in the command palette', () => {
    disposables.push(registerAction2(ConnectToWslAction))
    expect(CommandsRegistry.getCommand(ConnectToWslAction.ID)).toBeDefined()
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === ConnectToWslAction.ID,
      ),
    ).toBe(true)
  })

  it('ConnectToWsl.run notifies and stops when no distro is detected', async () => {
    disposables.push(registerAction2(ConnectToWslAction))
    const remoteStatus = makeRemoteStatusStub({ wslDistros: [] })
    const notification = makeNotificationStub()
    await runCommand(ConnectToWslAction.ID, {
      remoteStatus,
      notification,
      quickInput: makeQuickInputStub(),
    })
    expect(notification.notified).toHaveLength(1)
    expect(remoteStatus.connectCalls).toEqual([])
  })

  it('ConnectToWsl.run treats a listWslDistros failure as "none detected"', async () => {
    disposables.push(registerAction2(ConnectToWslAction))
    const remoteStatus = makeRemoteStatusStub({ wslError: new Error('wsl.exe missing') })
    const notification = makeNotificationStub()
    await runCommand(ConnectToWslAction.ID, {
      remoteStatus,
      notification,
      quickInput: makeQuickInputStub(),
    })
    expect(notification.notified).toHaveLength(1)
    expect(remoteStatus.connectCalls).toEqual([])
  })

  it('ConnectToWsl.run connects directly when a single distro exists', async () => {
    disposables.push(registerAction2(ConnectToWslAction))
    const remoteStatus = makeRemoteStatusStub({
      wslDistros: [distro('Ubuntu', { isDefault: true })],
    })
    const quickInput = makeQuickInputStub()
    const fileDialog = makeFileDialogStub()
    await runCommand(ConnectToWslAction.ID, {
      remoteStatus,
      notification: makeNotificationStub(),
      quickInput,
      fileDialog,
    })
    expect(remoteStatus.connectCalls).toEqual(['wsl+ubuntu'])
    expect(quickInput.shownItems).toHaveLength(0)
    expect(fileDialog.openCalls).toBe(1)
  })

  it('ConnectToWsl.run picks among multiple distros with the default on top', async () => {
    disposables.push(registerAction2(ConnectToWslAction))
    const remoteStatus = makeRemoteStatusStub({
      wslDistros: [distro('Debian'), distro('Ubuntu', { isDefault: true })],
    })
    const quickInput = makeQuickInputStub(0)
    await runCommand(ConnectToWslAction.ID, {
      remoteStatus,
      notification: makeNotificationStub(),
      quickInput,
    })
    expect(quickInput.shownItems).toHaveLength(1)
    const labels = quickInput.shownItems[0]!.map((i) => (isSeparator(i) ? '—' : i.label))
    expect(labels).toEqual(['Ubuntu (WSL)', 'Debian (WSL)'])
    expect(remoteStatus.connectCalls).toEqual(['wsl+ubuntu'])
  })

  it('ConnectToWsl.run connects the given authority argument without picking', async () => {
    disposables.push(registerAction2(ConnectToWslAction))
    const remoteStatus = makeRemoteStatusStub({ wslDistros: [] })
    const quickInput = makeQuickInputStub()
    await runCommand(
      ConnectToWslAction.ID,
      { remoteStatus, notification: makeNotificationStub(), quickInput },
      'wsl+Debian',
    )
    expect(remoteStatus.connectCalls).toEqual(['wsl+Debian'])
    expect(quickInput.shownItems).toHaveLength(0)
  })

  it('ConnectToHost.run merges WSL distros into the host picker behind a separator', async () => {
    disposables.push(registerAction2(ConnectToHostAction))
    const remoteStatus = makeRemoteStatusStub({
      hosts: ['alpha'],
      wslDistros: [distro('Ubuntu', { isDefault: true })],
    })
    const quickInput = makeQuickInputStub(1)
    await runCommand(ConnectToHostAction.ID, {
      remoteStatus,
      notification: makeNotificationStub(),
      quickInput,
    })
    const shown = quickInput.shownItems[0]!
    expect(shown.map((i) => (isSeparator(i) ? 'separator' : i.label))).toEqual([
      'alpha',
      'separator',
      'Ubuntu (WSL)',
    ])
    expect(remoteStatus.connectCalls).toEqual(['wsl+ubuntu'])
  })

  it('ConnectToHost.run keeps working when WSL enumeration fails', async () => {
    disposables.push(registerAction2(ConnectToHostAction))
    const remoteStatus = makeRemoteStatusStub({
      hosts: ['alpha'],
      wslError: new Error('wsl.exe missing'),
    })
    const quickInput = makeQuickInputStub(0)
    await runCommand(ConnectToHostAction.ID, {
      remoteStatus,
      notification: makeNotificationStub(),
      quickInput,
    })
    expect(quickInput.shownItems[0]!.map((i) => (isSeparator(i) ? 'separator' : i.label))).toEqual([
      'alpha',
    ])
    expect(remoteStatus.connectCalls).toEqual(['alpha'])
  })
})

describe('remoteActions — RemoveManualHostAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function makeExplorerStub() {
    const removed: string[] = []
    return {
      removed,
      async removeManualHost(host: string) {
        removed.push(host)
      },
    }
  }

  async function invokeHandler(host?: string): Promise<{ removed: string[] }> {
    const explorer = makeExplorerStub()
    const services = new ServiceCollection()
    services.set(IRemoteExplorerService, explorer as unknown as IRemoteExplorerService)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(RemoveManualHostAction.ID)!
      await cmd.handler(accessor, host)
    })
    return explorer
  }

  it('registers outside the command palette (menu-only command)', () => {
    disposables.push(registerAction2(RemoveManualHostAction))
    expect(CommandsRegistry.getCommand(RemoveManualHostAction.ID)).toBeDefined()
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === RemoveManualHostAction.ID,
      ),
    ).toBe(false)
  })

  it('removes the manual host passed as argument', async () => {
    disposables.push(registerAction2(RemoveManualHostAction))
    const explorer = await invokeHandler('alice@host')
    expect(explorer.removed).toEqual(['alice@host'])
  })

  it('is a no-op without a host argument or with a blank one', async () => {
    disposables.push(registerAction2(RemoveManualHostAction))
    expect((await invokeHandler()).removed).toEqual([])
    expect((await invokeHandler('   ')).removed).toEqual([])
  })
})

describe('remoteActions — StopRemoteServerAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  async function invoke(
    authorityArg: string,
    openWindows: readonly IOpenWindowInfo[],
    confirmAnswer = true,
  ): Promise<{ calls: string[]; confirms: Array<{ message: string; detail?: string }> }> {
    const calls: string[] = []
    const confirms: Array<{ message: string; detail?: string }> = []
    const remoteStatus = {
      stopServer: async (authority: string) => {
        calls.push(`stopServer:${authority}`)
        return true
      },
    }
    const windows = {
      getWindows: async () => openWindows,
    }
    const dialog = {
      confirm: async (opts: { message: string; detail?: string }) => {
        confirms.push({
          message: opts.message,
          ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
        })
        return { confirmed: confirmAnswer, choice: 'primary' as const }
      },
      prompt: () => Promise.resolve(undefined),
    }
    const services = new ServiceCollection()
    services.set(IRemoteStatusService, remoteStatus as never)
    services.set(IWindowsService, windows as never)
    services.set(IDialogService, dialog as never)
    services.set(INotificationService, makeNotificationStub())
    services.set(IQuickInputService, makeQuickInputStub())
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(StopRemoteServerAction.ID)!
      await cmd.handler(accessor, authorityArg)
    })
    return { calls, confirms }
  }

  function remoteWindow(id: number, name: string | null, remoteAuthority: string): IOpenWindowInfo {
    return { id, folder: null, name, remoteAuthority }
  }

  it('lists the related workspace windows in the confirmation and stops the server', async () => {
    disposables.push(registerAction2(StopRemoteServerAction))
    const { calls, confirms } = await invoke('myhost', [
      remoteWindow(1, 'proj-a', 'myhost'),
      remoteWindow(2, 'proj-b', 'myhost'),
      { id: 3, folder: URI.file('C:/local-project').toJSON(), name: 'local-project' },
    ])
    expect(calls).toEqual(['stopServer:myhost'])
    expect(confirms[0]?.message).toContain("'myhost'")
    expect(confirms[0]?.detail).toContain('2 related workspace window(s)')
    expect(confirms[0]?.detail).toContain('proj-a, proj-b')
    expect(confirms[0]?.detail).not.toContain('local-project')
  })

  it('matches windows through authority normalization (WSL case-insensitive)', async () => {
    disposables.push(registerAction2(StopRemoteServerAction))
    const { confirms } = await invoke('wsl+Ubuntu', [remoteWindow(1, 'proj', 'wsl+ubuntu')])
    expect(confirms[0]?.detail).toContain('proj')
  })

  it('labels an empty remote-scoped window in the confirmation', async () => {
    disposables.push(registerAction2(StopRemoteServerAction))
    const { confirms } = await invoke('myhost', [remoteWindow(1, null, 'myhost')])
    expect(confirms[0]?.detail).toContain('Empty Window')
  })

  it('keeps a plain teardown message when no window uses the host', async () => {
    disposables.push(registerAction2(StopRemoteServerAction))
    const { calls, confirms } = await invoke('myhost', [])
    expect(calls).toEqual(['stopServer:myhost'])
    expect(confirms[0]?.detail).toBe('The connection will be torn down.')
  })

  it('does not stop the server when the confirmation is cancelled', async () => {
    disposables.push(registerAction2(StopRemoteServerAction))
    const { calls } = await invoke('myhost', [remoteWindow(1, 'proj', 'myhost')], false)
    expect(calls).toEqual([])
  })
})

describe('remoteActions — CloseConnectionAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  async function invoke(
    authorityArg: string,
    currentFolder: URI | null,
    confirmAnswer = true,
  ): Promise<{ calls: string[]; confirms: Array<{ message: string }> }> {
    const calls: string[] = []
    const confirms: Array<{ message: string }> = []
    const remoteStatus = {
      closeRemoteWorkspace: async (authority: string) => {
        calls.push(`closeRemoteWorkspace:${authority}`)
        return true
      },
      closeConnection: async (authority: string) => {
        calls.push(`closeConnection:${authority}`)
      },
    }
    const workspace = {
      current: currentFolder
        ? { folder: currentFolder, name: currentFolder.authority || 'local' }
        : null,
    }
    const dialog = {
      confirm: async (opts: { message: string }) => {
        confirms.push({ message: opts.message })
        return { confirmed: confirmAnswer, choice: 'primary' as const }
      },
      prompt: () => Promise.resolve(undefined),
    }
    const services = new ServiceCollection()
    services.set(IRemoteStatusService, remoteStatus as never)
    services.set(IWorkspaceService, workspace as never)
    services.set(IDialogService, dialog as never)
    services.set(INotificationService, makeNotificationStub())
    services.set(IQuickInputService, makeQuickInputStub())
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(CloseConnectionAction.ID)!
      await cmd.handler(accessor, authorityArg)
    })
    return { calls, confirms }
  }

  it('closes the remote workspace window via closeRemoteWorkspace for the current authority', async () => {
    disposables.push(registerAction2(CloseConnectionAction))
    const { calls, confirms } = await invoke(
      'myhost',
      URI.from({ scheme: REMOTE_SCHEME, authority: 'myhost', path: '/' }),
    )
    expect(confirms).toHaveLength(1)
    expect(confirms[0]?.message).toContain("'myhost'")
    expect(calls).toEqual(['closeRemoteWorkspace:myhost'])
  })

  it('skips the close when the confirmation is cancelled', async () => {
    disposables.push(registerAction2(CloseConnectionAction))
    const { calls } = await invoke(
      'myhost',
      URI.from({ scheme: REMOTE_SCHEME, authority: 'myhost', path: '/' }),
      false,
    )
    expect(calls).toEqual([])
  })

  it('disconnects without a confirmation when the current window is not scoped to the authority', async () => {
    disposables.push(registerAction2(CloseConnectionAction))
    const { calls, confirms } = await invoke('myhost', URI.file('C:/local-project'))
    expect(confirms).toHaveLength(0)
    expect(calls).toEqual(['closeRemoteWorkspace:myhost'])
  })
})
