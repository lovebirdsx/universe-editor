/*---------------------------------------------------------------------------------------------
 *  Tests for RemoteStatusContribution — status-bar text surfaces the install
 *  step/progress while a remote bring-up is deploying, refreshes the elapsed
 *  time every second, and falls back to "Connecting..." once progress clears.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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

function setup(opts?: { localWorkspace?: boolean }): void {
  remoteStatus = makeRemoteStatus()
  statusBar = new StatusBarService()
  contextKeyService = new ContextKeyService()
  const folder = opts?.localWorkspace
    ? URI.file('C:/local-project')
    : URI.from({ scheme: REMOTE_SCHEME, authority: AUTHORITY, path: '/' })
  workspace = makeWorkspace(folder)
  const commands = {
    _serviceBrand: undefined,
    executeCommand: vi.fn(),
  } as unknown as ICommandService
  const quickInput = {
    _serviceBrand: undefined,
    pick: vi.fn(),
  } as unknown as IQuickInputService

  const services = new ServiceCollection()
  services.set(IStatusBarService, statusBar)
  services.set(IWorkspaceService, workspace as never)
  services.set(IRemoteStatusService, remoteStatus as never)
  services.set(IContextKeyService, contextKeyService)
  services.set(ICommandService, commands)
  services.set(IQuickInputService, quickInput)
  const inst = new InstantiationService(services)
  contribution = inst.createInstance(RemoteStatusContribution)
}

function fireProgress(authority: string, progress: RemoteConnectionProgressDto): void {
  remoteStatus._emitter.fire({ authority, state: 'deploying', progress })
}

function fireState(authority: string, state: RemoteConnectionStateDto): void {
  remoteStatus._emitter.fire({ authority, state })
}

function entryText(): string | undefined {
  return statusBar.entries.get()[0]?.entry.text
}

describe('RemoteStatusContribution', () => {
  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
    contextKeyService?.dispose()
    contextKeyService = undefined
    workspace = undefined
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

    expect(entryText()).toContain('Step 2/4: Uploading server bundle')
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
    expect(entryText()).toBeUndefined()

    fireProgress(AUTHORITY, {
      stepId: 'uploading',
      stepIndex: 2,
      stepTotal: 4,
      startedAt: Date.now(),
      needsInstall: true,
    })
    expect(entryText()).toContain('Step 2/4: Uploading server bundle')

    fireState(AUTHORITY, 'connected')
    expect(entryText()).toBeUndefined()
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
