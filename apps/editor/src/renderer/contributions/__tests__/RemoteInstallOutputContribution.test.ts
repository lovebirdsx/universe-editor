/*---------------------------------------------------------------------------------------------
 *  Tests for RemoteInstallOutputContribution — reveal the "Remote Connection"
 *  output channel once per authority when a bring-up performs an actual install.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  ILayoutService,
  IOutputService,
  InstantiationService,
  IViewsService,
  PartId,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  REMOTE_CONNECTION_LOG_CHANNEL_NAME,
  type RemoteConnectionProgressDto,
  type RemoteConnectionStatusDto,
} from '../../../shared/ipc/remoteStatusService.js'
import { OutputService } from '../../services/output/OutputService.js'
import { RemoteInstallOutputContribution } from '../RemoteInstallOutputContribution.js'

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
    connect: vi.fn(),
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

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function makeLayoutService() {
  const focus = vi.fn()
  return {
    _serviceBrand: undefined,
    setVisible: vi.fn(),
    getPart: vi.fn(() => ({ focus })),
    focus,
  }
}

function makeViewsService() {
  return {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  }
}

function installProgress(
  overrides: Partial<RemoteConnectionProgressDto> = {},
): RemoteConnectionProgressDto {
  return {
    stepId: 'uploading',
    stepIndex: 2,
    stepTotal: 4,
    startedAt: Date.now(),
    needsInstall: true,
    ...overrides,
  }
}

function instantiate(
  remoteStatus: FakeRemoteStatusService,
  output: OutputService,
  layout: ReturnType<typeof makeLayoutService>,
  views: ReturnType<typeof makeViewsService>,
): RemoteInstallOutputContribution {
  const services = new ServiceCollection()
  services.set(IRemoteStatusService, remoteStatus as never)
  services.set(IOutputService, output)
  services.set(ILayoutService, layout as never)
  services.set(IViewsService, views as never)
  const inst = new InstantiationService(services)
  return inst.createInstance(RemoteInstallOutputContribution)
}

function fireStatus(
  remoteStatus: FakeRemoteStatusService,
  status: Partial<RemoteConnectionStatusDto> & {
    authority: string
    state: RemoteConnectionStatusDto['state']
  },
): void {
  remoteStatus._emitter.fire(status as RemoteConnectionStatusDto)
}

describe('RemoteInstallOutputContribution', () => {
  let remoteStatus: FakeRemoteStatusService
  let output: OutputService
  let layout: ReturnType<typeof makeLayoutService>
  let views: ReturnType<typeof makeViewsService>

  beforeEach(() => {
    remoteStatus = makeRemoteStatus()
    output = new OutputService(makeStorage())
    layout = makeLayoutService()
    views = makeViewsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reveals the Remote Connection channel on an install bring-up', () => {
    const contribution = instantiate(remoteStatus, output, layout, views)
    fireStatus(remoteStatus, {
      authority: AUTHORITY,
      state: 'deploying',
      progress: installProgress(),
    })

    expect(output.activeChannelName.get()).toBe(REMOTE_CONNECTION_LOG_CHANNEL_NAME)
    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.output')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    expect(layout.focus).toHaveBeenCalledTimes(1)
    contribution.dispose()
  })

  it('does not reveal again for a second install step on the same authority', () => {
    const contribution = instantiate(remoteStatus, output, layout, views)
    fireStatus(remoteStatus, {
      authority: AUTHORITY,
      state: 'deploying',
      progress: installProgress(),
    })
    fireStatus(remoteStatus, {
      authority: AUTHORITY,
      state: 'deploying',
      progress: installProgress({ stepId: 'installing', stepIndex: 3 }),
    })

    expect(views.openViewContainer).toHaveBeenCalledTimes(1)
    expect(layout.setVisible).toHaveBeenCalledTimes(1)
    contribution.dispose()
  })

  it('ignores a coarse deploying event without progress', () => {
    const contribution = instantiate(remoteStatus, output, layout, views)
    fireStatus(remoteStatus, { authority: AUTHORITY, state: 'deploying' })

    expect(views.openViewContainer).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('ignores a progress event that did not need an install', () => {
    const contribution = instantiate(remoteStatus, output, layout, views)
    fireStatus(remoteStatus, {
      authority: AUTHORITY,
      state: 'deploying',
      progress: installProgress({ needsInstall: false }),
    })

    expect(views.openViewContainer).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('reveals again after a failure resets the authority', () => {
    const contribution = instantiate(remoteStatus, output, layout, views)
    fireStatus(remoteStatus, {
      authority: AUTHORITY,
      state: 'deploying',
      progress: installProgress(),
    })
    expect(views.openViewContainer).toHaveBeenCalledTimes(1)

    fireStatus(remoteStatus, { authority: AUTHORITY, state: 'failed' })
    fireStatus(remoteStatus, {
      authority: AUTHORITY,
      state: 'deploying',
      progress: installProgress(),
    })
    expect(views.openViewContainer).toHaveBeenCalledTimes(2)
    contribution.dispose()
  })
})
