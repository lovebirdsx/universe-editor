/*---------------------------------------------------------------------------------------------
 *  Regression: the Remote targets tree renders without a React key warning.
 *
 *  Before the shared `Tree` took ownership of row keys, this view was the one tree
 *  consumer of ten whose row root carried no `key` — the hand-rolled rows it
 *  replaced had `key={target.authority}`, and the migration dropped it. Because
 *  `VirtualList`'s default branch returns `renderItem`'s result verbatim, that
 *  produced "Each child in a list should have a unique key prop. Check the render
 *  method of `ForwardRef(VirtualListInner)`" on every render of this view, plus
 *  positional reconciliation of rows whose identity is an authority string.
 *
 *  Separate from the keyboard spec on purpose: React dedupes this warning per
 *  owner component for the lifetime of the module registry, so any earlier test
 *  rendering the view would swallow it and leave this one green for free.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  Emitter,
  ICommandService,
  IContextKeyService,
  IWorkspaceService,
  InstantiationService,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  observableValue,
  type ICommandService as ICommandServiceType,
  type IRecentWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import type {
  RemoteConnectionStatusDto,
  WslDistroDto,
} from '../../../../shared/ipc/remoteStatusService.js'
import {
  IRemoteExplorerService,
  type IRemoteExplorerService as IRemoteExplorerServiceType,
  type RemoteSshTarget,
} from '../../../services/remote/RemoteExplorerService.js'
import { ServicesContext } from '../../useService.js'
import { RemoteTargetsView } from '../RemoteTargetsView.js'

const disposables: { dispose(): void }[] = []

function setup(sshTargets: readonly RemoteSshTarget[], recents: readonly IRecentWorkspace[]) {
  const commandService = {
    _serviceBrand: undefined,
    executeCommand: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as ICommandServiceType

  const workspaceService = {
    _serviceBrand: undefined,
    recent: recents,
    onDidChangeRecent: new Emitter<readonly IRecentWorkspace[]>().event,
  } as unknown as IWorkspaceServiceType

  const explorerService: IRemoteExplorerServiceType = {
    _serviceBrand: undefined,
    sshTargets: observableValue<readonly RemoteSshTarget[]>('t.ssh', sshTargets),
    wslDistros: observableValue<readonly WslDistroDto[]>('t.wsl', []),
    connections: observableValue<readonly RemoteConnectionStatusDto[]>('t.conn', []),
    refresh: vi.fn(() => Promise.resolve()),
    addManualHost: vi.fn(() => Promise.resolve()),
    removeManualHost: vi.fn(() => Promise.resolve()),
  }

  const contextKeyService = new ContextKeyService()
  disposables.push(contextKeyService)

  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IContextKeyService, contextKeyService)
  services.set(IWorkspaceService, workspaceService)
  services.set(IRemoteExplorerService, explorerService)

  return render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <RemoteTargetsView />
    </ServicesContext.Provider>,
  )
}

let errors: string[]

beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  while (disposables.length > 0) disposables.pop()?.dispose()
})

describe('RemoteTargetsView row keys', () => {
  it('renders its rows without a duplicate-key warning', () => {
    setup(
      [
        { host: 'alpha', manual: false },
        { host: 'bravo', manual: false },
      ],
      [
        {
          folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'alpha', path: '/srv/app' }),
          name: 'app',
          lastOpened: 1,
        },
      ],
    )

    // Guard the guard: an empty tree would pass the assertion trivially.
    expect(document.querySelectorAll('[data-row-key]').length).toBeGreaterThan(1)
    expect(screen.getByRole('tree')).toBeTruthy()
    expect(errors.filter((e) => e.includes('unique "key" prop'))).toEqual([])
  })
})
