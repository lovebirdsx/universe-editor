/*---------------------------------------------------------------------------------------------
 *  Tests for RemoteStatusContribution — status-bar text surfaces the install
 *  step/progress while a remote bring-up is deploying, refreshes the elapsed
 *  time every second, and falls back to "Connecting..." once progress clears.
 *  Remote entries carry a stable id plus state colors; a local window keeps a
 *  plain `$(remote)` entry that opens the "Open a Remote Window" menu.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  Emitter,
  ICommandService,
  IContextKeyService,
  IQuickInputService,
  InstantiationService,
  IStatusBarService,
  IWorkspaceService,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  type IRecentWorkspace,
  type IStatusBarEntry,
  type IWorkspace,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type RemoteConnectionProgressDto,
  type RemoteConnectionStateDto,
  type RemoteConnectionStatusDto,
} from '../../../shared/ipc/remoteStatusService.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { RemoteStatusContribution, formatElapsedMs } from '../RemoteStatusContribution.js'

const REMOTE_STATUS_MENU_COMMAND_ID = 'workbench.action.remote.showMenu'

interface FakeRemoteStatusService {
  _serviceBrand: undefined
  getConnections: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  getEnvironment: ReturnType<typeof vi.fn>
  listSshHosts: ReturnType<typeof vi.fn>
  listWslDistros: ReturnType<typeof vi.fn>
  retryConnection: ReturnType<typeof vi.fn>
  closeConnection: ReturnType<typeof vi.fn>
  stopServer: ReturnType<typeof vi.fn>
  dropSocketForTesting: ReturnType<typeof vi.fn>
  dropExtensionHostSocketForTesting: ReturnType<typeof vi.fn>
  onDidChangeState: Emitter<RemoteConnectionStatusDto>['event']
  _emitter: Emitter<RemoteConnectionStatusDto>
}

interface MenuItemLike {
  readonly id?: string
  readonly label: string
  readonly commandId: string
}

const AUTHORITY = 'myhost'

function makeRemoteStatus(): FakeRemoteStatusService {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  return {
    _serviceBrand: undefined,
    getConnections: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    getEnvironment: vi.fn(),
    listSshHosts: vi.fn().mockResolvedValue([]),
    listWslDistros: vi.fn().mockResolvedValue([]),
    retryConnection: vi.fn(),
    closeConnection: vi.fn(),
    stopServer: vi.fn(),
    dropSocketForTesting: vi.fn(),
    dropExtensionHostSocketForTesting: vi.fn(),
    onDidChangeState: emitter.event,
    _emitter: emitter,
  }
}

function makeWorkspace(folder: URI) {
  const emitter = new Emitter<IWorkspace | null>()
  let current: IWorkspace | null = {
    folder,
    name: folder.authority || 'local',
  }
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    setCurrent(next: IWorkspace | null) {
      current = next
      emitter.fire(current)
    },
    onDidChangeWorkspace: emitter.event,
    _emitter: emitter,
    recent: [] as readonly IRecentWorkspace[],
    onDidChangeRecent: new Emitter<readonly IRecentWorkspace[]>().event,
    whenReady: Promise.resolve(),
    openFolder: vi.fn(),
    closeFolder: vi.fn(),
    removeRecent: vi.fn(),
    clearRecent: vi.fn(),
  }
}

let contribution: RemoteStatusContribution | undefined
let contextKeyService: ContextKeyService | undefined
let remoteStatus: FakeRemoteStatusService
let statusBar: StatusBarService
let workspace: ReturnType<typeof makeWorkspace> | undefined
let commands: { _serviceBrand: undefined; executeCommand: ReturnType<typeof vi.fn> }
let quickInput: { _serviceBrand: undefined; pick: ReturnType<typeof vi.fn> }
let inst: InstantiationService | undefined

function setup(opts?: { localWorkspace?: boolean; authority?: string }): void {
  remoteStatus = makeRemoteStatus()
  statusBar = new StatusBarService()
  contextKeyService = new ContextKeyService()
  const folder = opts?.localWorkspace
    ? URI.file('C:/local-project')
    : URI.from({ scheme: REMOTE_SCHEME, authority: opts?.authority ?? AUTHORITY, path: '/' })
  workspace = makeWorkspace(folder)
  commands = {
    _serviceBrand: undefined,
    executeCommand: vi.fn(),
  }
  quickInput = {
    _serviceBrand: undefined,
    pick: vi.fn(),
  }

  const services = new ServiceCollection()
  services.set(IStatusBarService, statusBar)
  services.set(IWorkspaceService, workspace as never)
  services.set(IRemoteStatusService, remoteStatus as never)
  services.set(IContextKeyService, contextKeyService)
  services.set(ICommandService, commands as never)
  services.set(IQuickInputService, quickInput as never)
  inst = new InstantiationService(services)
  contribution = inst.createInstance(RemoteStatusContribution)
}

function fireProgress(authority: string, progress: RemoteConnectionProgressDto): void {
  remoteStatus._emitter.fire({ authority, state: 'deploying', progress })
}

function fireState(authority: string, state: RemoteConnectionStateDto): void {
  remoteStatus._emitter.fire({ authority, state })
}

function entry(): IStatusBarEntry | undefined {
  return statusBar.entries.get()[0]?.entry
}

function entryText(): string | undefined {
  return entry()?.text
}

describe('RemoteStatusContribution', () => {
  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
    contextKeyService?.dispose()
    contextKeyService = undefined
    workspace = undefined
    inst = undefined
    vi.useRealTimers()
  })

  it('shows the install step with index and step label', () => {
    setup()
    fireProgress(AUTHORITY, {
      stepId: 'uploading',
      stepIndex: 2,
      stepTotal: 4,
      startedAt: Date.now(),
      needsInstall: true,
    })

    expect(entryText()).toContain('SSH: myhost (Step 2/4: Uploading server bundle')
    expect(entryText()).toContain('· 0s')
  })

  it('refreshes the elapsed time every second', async () => {
    vi.useFakeTimers()
    setup()
    const startedAt = Date.now()
    fireProgress(AUTHORITY, {
      stepId: 'uploading',
      stepIndex: 2,
      stepTotal: 4,
      startedAt,
      needsInstall: true,
    })

    expect(entryText()).toContain('· 0s')
    await vi.advanceTimersByTimeAsync(1000)
    expect(entryText()).toContain('· 1s')
  })

  it('falls back to Connecting... when a coarse forwarding event clears progress', () => {
    setup()
    fireProgress(AUTHORITY, {
      stepId: 'installing',
      stepIndex: 4,
      stepTotal: 4,
      startedAt: Date.now(),
      needsInstall: true,
    })
    expect(entryText()).toContain('Installing server')

    fireState(AUTHORITY, 'forwarding')
    expect(entryText()).toContain('Connecting...')
  })

  it('surfaces an in-flight bring-up while the workspace is still local', () => {
    setup({ localWorkspace: true })
    expect(entryText()).toBe('$(remote)')

    fireProgress(AUTHORITY, {
      stepId: 'uploading',
      stepIndex: 2,
      stepTotal: 4,
      startedAt: Date.now(),
      needsInstall: true,
    })
    expect(entryText()).toContain('Step 2/4: Uploading server bundle')

    fireState(AUTHORITY, 'connected')
    expect(entryText()).toBe('$(remote)')
  })

  it('connects the current remote authority once, reconnecting after a local round-trip', () => {
    setup()
    expect(remoteStatus.connect).toHaveBeenCalledTimes(1)
    expect(remoteStatus.connect).toHaveBeenCalledWith(AUTHORITY)

    // Refiring the same remote workspace must not duplicate the connect.
    workspace!.setCurrent(workspace!.current)
    expect(remoteStatus.connect).toHaveBeenCalledTimes(1)

    // Leaving the remote workspace clears the record.
    remoteStatus.connect.mockClear()
    workspace!.setCurrent(null)
    expect(remoteStatus.connect).not.toHaveBeenCalled()

    // Re-opening the same remote authority triggers a fresh connect.
    workspace!.setCurrent({
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: AUTHORITY, path: '/' }),
      name: AUTHORITY,
    })
    expect(remoteStatus.connect).toHaveBeenCalledTimes(1)
    expect(remoteStatus.connect).toHaveBeenCalledWith(AUTHORITY)
  })

  it('does not connect when the workspace is local', () => {
    setup({ localWorkspace: true })
    expect(remoteStatus.connect).not.toHaveBeenCalled()
  })

  it('renders the remote indicator with id, colors, and a wsl label', () => {
    setup({ authority: 'wsl+ubuntu-24.04' })
    const e = entry()
    expect(e?.id).toBe('remote.indicator')
    expect(e?.text).toContain('WSL: ubuntu-24.04')
    expect(e?.backgroundColor).toBe('statusBarItem.remoteBackground')
    expect(e?.color).toBe('statusBarItem.remoteForeground')
    expect(contextKeyService!.get('isRemote')).toBe(true)
    expect(contextKeyService!.get('remoteName')).toBe('wsl')
  })

  it('labels a non-wsl authority as ssh and tracks the ssh remoteName', () => {
    setup()
    expect(entryText()).toContain('SSH: myhost')
    expect(entry()?.backgroundColor).toBe('statusBarItem.remoteBackground')
    expect(contextKeyService!.get('isRemote')).toBe(true)
    expect(contextKeyService!.get('remoteName')).toBe('ssh')
  })

  it('switches to the error colors in the failed state', () => {
    setup()
    fireState(AUTHORITY, 'failed')
    const e = entry()
    expect(e?.text).toContain('$(warning) SSH: myhost (Failed)')
    expect(e?.backgroundColor).toBe('statusBarItem.errorBackground')
    expect(e?.color).toBe('statusBarItem.errorForeground')
  })

  it('keeps a plain local entry with local context keys', () => {
    setup({ localWorkspace: true })
    const e = entry()
    expect(e?.id).toBe('remote.indicator')
    expect(e?.text).toBe('$(remote)')
    expect(e?.backgroundColor).toBeUndefined()
    expect(e?.color).toBeUndefined()
    expect(contextKeyService!.get('isRemote')).toBe(false)
    expect(contextKeyService!.get('remoteName')).toBe('')
  })

  it('opens the open-a-remote-window menu from the local entry', async () => {
    setup({ localWorkspace: true })
    remoteStatus.listWslDistros.mockResolvedValue([
      { name: 'ubuntu-24.04', isDefault: true, isRunning: true, version: 2 },
    ])
    quickInput.pick.mockResolvedValue({
      id: 'remote.connectToHost',
      label: 'Connect to Host...',
      commandId: 'remote.connectToHost',
    })

    const cmd = CommandsRegistry.getCommand(REMOTE_STATUS_MENU_COMMAND_ID)
    expect(cmd).toBeDefined()
    inst!.invokeFunction((accessor) => cmd!.handler(accessor))

    await vi.waitFor(() => expect(quickInput.pick).toHaveBeenCalledTimes(1))
    const [items, options] = quickInput.pick.mock.calls[0]! as [
      MenuItemLike[],
      { placeholder: string },
    ]
    expect(items.map((item) => item.id)).toEqual(['remote.connectToHost', 'remote.connectToWsl'])
    expect(options.placeholder).toBe('Select an option to open a Remote Window')

    await vi.waitFor(() =>
      expect(commands.executeCommand).toHaveBeenCalledWith('remote.connectToHost'),
    )
  })

  it('offers only connect to host when no wsl distros are detected', async () => {
    setup({ localWorkspace: true })
    quickInput.pick.mockResolvedValue(undefined)

    const cmd = CommandsRegistry.getCommand(REMOTE_STATUS_MENU_COMMAND_ID)
    inst!.invokeFunction((accessor) => cmd!.handler(accessor))

    await vi.waitFor(() => expect(quickInput.pick).toHaveBeenCalledTimes(1))
    const [items] = quickInput.pick.mock.calls[0]! as [MenuItemLike[], { placeholder: string }]
    expect(items.map((item) => item.id)).toEqual(['remote.connectToHost'])
    expect(commands.executeCommand).not.toHaveBeenCalled()
  })
})

describe('formatElapsedMs', () => {
  it('formats elapsed milliseconds as human-readable durations', () => {
    expect(formatElapsedMs(0)).toBe('0s')
    expect(formatElapsedMs(45000)).toBe('45s')
    expect(formatElapsedMs(105000)).toBe('1m 45s')
    expect(formatElapsedMs(3723000)).toBe('1h 2m 3s')
    expect(formatElapsedMs(-5000)).toBe('0s')
  })
})
