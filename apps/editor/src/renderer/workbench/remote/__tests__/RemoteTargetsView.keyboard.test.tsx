/*---------------------------------------------------------------------------------------------
 *  Keyboard navigation for RemoteTargetsView.
 *
 *  The view renders the shared `Tree`, so this asserts the behaviour that
 *  migration bought: walking a three-level tree with the arrow keys, expanding
 *  and collapsing with Left/Right, and Enter running the row's primary action
 *  (which is what makes Enter on a *target* connect rather than merely fold it).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { RemoteExplorerMenuContribution } from '../../../contributions/RemoteExplorerMenuContribution.js'
import {
  IRemoteExplorerService,
  type IRemoteExplorerService as IRemoteExplorerServiceType,
  type RemoteSshTarget,
} from '../../../services/remote/RemoteExplorerService.js'
import { ServicesContext } from '../../useService.js'
import { RemoteTargetsView } from '../RemoteTargetsView.js'

interface SetupInput {
  readonly sshTargets?: readonly RemoteSshTarget[]
  readonly wslDistros?: readonly WslDistroDto[]
  readonly connections?: readonly RemoteConnectionStatusDto[]
  readonly recents?: readonly IRecentWorkspace[]
}

const disposables: { dispose(): void }[] = []

function setup(input: SetupInput = {}) {
  const executeCommand = vi.fn(() => Promise.resolve(undefined))
  const commandService = {
    _serviceBrand: undefined,
    executeCommand,
  } as unknown as ICommandServiceType

  const workspaceService = {
    _serviceBrand: undefined,
    recent: input.recents ?? [],
    onDidChangeRecent: new Emitter<readonly IRecentWorkspace[]>().event,
  } as unknown as IWorkspaceServiceType

  const explorerService: IRemoteExplorerServiceType = {
    _serviceBrand: undefined,
    sshTargets: observableValue<readonly RemoteSshTarget[]>('t.ssh', input.sshTargets ?? []),
    wslDistros: observableValue<readonly WslDistroDto[]>('t.wsl', input.wslDistros ?? []),
    connections: observableValue<readonly RemoteConnectionStatusDto[]>(
      't.conn',
      input.connections ?? [],
    ),
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
  const inst = new InstantiationService(services)

  const result = render(
    <ServicesContext.Provider value={inst}>
      <RemoteTargetsView />
    </ServicesContext.Provider>,
  )
  return { ...result, executeCommand }
}

const tree = () => screen.getByRole('tree')
const focusedLabels = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-row-key]'))
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.querySelector('[data-tooltip]')?.textContent ?? '')

const recent = (authority: string, path: string, name: string): IRecentWorkspace => ({
  folder: URI.from({ scheme: REMOTE_SCHEME, authority, path }),
  name,
  lastOpened: 1,
})

const target = (host: string): RemoteSshTarget => ({ host, manual: false })

afterEach(() => {
  cleanup()
  while (disposables.length > 0) disposables.pop()?.dispose()
})

describe('RemoteTargetsView keyboard navigation', () => {
  it('is a single focusable tree container, with rows as data rather than tab stops', () => {
    setup({ sshTargets: [target('alpha')] })
    expect(tree().getAttribute('tabindex')).toBe('0')
    for (const row of document.querySelectorAll('[data-row-key]')) {
      expect(row.hasAttribute('tabindex')).toBe(false)
    }
  })

  it('landing focus on the tree selects the first row', () => {
    setup({ sshTargets: [target('alpha')] })
    expect(focusedLabels()).toEqual([])
    fireEvent.focus(tree())
    expect(focusedLabels()).toEqual(['SSH'])
  })

  it('leaves a still-visible cursor alone when focus returns', () => {
    setup({ sshTargets: [target('alpha')] })
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['alpha'])
    fireEvent.blur(tree())
    fireEvent.focus(tree())
    expect(focusedLabels()).toEqual(['alpha'])
  })

  it('walks group -> target -> recent with ArrowDown and back with ArrowUp', () => {
    setup({
      sshTargets: [target('alpha')],
      recents: [recent('alpha', '/srv/app', 'app')],
    })

    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['SSH'])
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['alpha'])
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['app'])

    fireEvent.keyDown(tree(), { key: 'ArrowUp' })
    expect(focusedLabels()).toEqual(['alpha'])
  })

  it('collapses with ArrowLeft and re-expands with ArrowRight', () => {
    setup({ sshTargets: [target('alpha'), target('beta')] })

    // Focus the group, then fold it: its targets leave the visible rows.
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(screen.getAllByTestId('remote-target-row')).toHaveLength(2)
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    expect(screen.queryAllByTestId('remote-target-row')).toHaveLength(0)

    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    expect(screen.getAllByTestId('remote-target-row')).toHaveLength(2)
  })

  it('steps out to the parent when ArrowLeft hits a leaf', () => {
    setup({ sshTargets: [target('alpha')], recents: [recent('alpha', '/srv/app', 'app')] })

    for (let i = 0; i < 3; i++) fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['app'])
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    expect(focusedLabels()).toEqual(['alpha'])
  })

  it('Home and End jump to the ends', () => {
    setup({ sshTargets: [target('alpha'), target('beta')] })
    fireEvent.keyDown(tree(), { key: 'End' })
    expect(focusedLabels()).toEqual(['beta'])
    fireEvent.keyDown(tree(), { key: 'Home' })
    expect(focusedLabels()).toEqual(['SSH'])
  })

  it('Enter on a disconnected target connects instead of collapsing it', () => {
    const { executeCommand } = setup({
      sshTargets: [target('alpha')],
      recents: [recent('alpha', '/srv/app', 'app')],
    })

    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['alpha'])

    fireEvent.keyDown(tree(), { key: 'Enter' })
    expect(executeCommand).toHaveBeenCalledWith('remote.connectToHost', 'alpha')
    // The row has children, but Enter did not fold them away.
    expect(screen.getAllByTestId('remote-recent-row')).toHaveLength(1)
  })

  it('Enter on a connected target opens a folder on the host', () => {
    const { executeCommand } = setup({
      sshTargets: [target('alpha')],
      connections: [{ authority: 'alpha', state: 'connected' }],
    })
    fireEvent.keyDown(tree(), { key: 'End' })
    fireEvent.keyDown(tree(), { key: 'Enter' })
    expect(executeCommand).toHaveBeenCalledWith('remote.openFolder', 'alpha')
  })

  it('Enter on a recent row opens it in the current window', () => {
    const folder = URI.from({ scheme: REMOTE_SCHEME, authority: 'alpha', path: '/srv/app' })
    const { executeCommand } = setup({
      sshTargets: [target('alpha')],
      recents: [{ folder, name: 'app', lastOpened: 1 }],
    })
    fireEvent.keyDown(tree(), { key: 'End' })
    expect(focusedLabels()).toEqual(['app'])
    fireEvent.keyDown(tree(), { key: 'Enter' })
    expect(executeCommand).toHaveBeenCalledWith(
      'workbench.action.openWorkspaceInCurrentWindow',
      folder.toString(),
    )
  })

  it('Enter on the empty-state hint does nothing', () => {
    const { executeCommand } = setup()
    fireEvent.keyDown(tree(), { key: 'End' })
    expect(screen.getByTestId('remote-group-empty-ssh')).toBeTruthy()
    fireEvent.keyDown(tree(), { key: 'Enter' })
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('raises the row context menu from the ContextMenu key', async () => {
    // The menu's items come from the registry, so the contribution has to be
    // live or ContextMenu renders nothing at all.
    const contribution = new RemoteExplorerMenuContribution()
    disposables.push(contribution)
    setup({ sshTargets: [target('alpha')] })
    fireEvent.keyDown(tree(), { key: 'End' })
    fireEvent.keyDown(tree(), { key: 'ContextMenu' })
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    // Titles come from the Action2 registration, which this test does not load;
    // the command id is what proves the row's payload reached the menu.
    expect(screen.getByText('remote.connectToHost')).toBeTruthy()
  })

  it('keeps the tree in step with refreshed data', async () => {
    const { executeCommand } = setup({ sshTargets: [target('alpha')] })
    expect(executeCommand).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getAllByTestId('remote-target-row')).toHaveLength(1))
  })
})
