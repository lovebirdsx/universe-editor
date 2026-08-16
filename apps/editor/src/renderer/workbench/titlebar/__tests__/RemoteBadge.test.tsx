/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  ICommandService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { RemoteBadge } from '../RemoteBadge.js'

function makeWorkspaceStub(initial: IWorkspace | null): IWorkspaceServiceType & {
  fireWorkspaceChange(workspace: IWorkspace | null): void
} {
  const emitter = new Emitter<IWorkspace | null>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: emitter.event,
    get recent() {
      return []
    },
    onDidChangeRecent: new Emitter<readonly IRecentWorkspace[]>().event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {
      current = null
    },
    async clearRecent() {},
    async removeRecent() {},
    fireWorkspaceChange(workspace: IWorkspace | null) {
      current = workspace
      emitter.fire(workspace)
    },
  }
}

function renderBadge(ws: IWorkspaceServiceType): string[] {
  const executed: string[] = []
  const sc = new ServiceCollection()
  sc.set(IWorkspaceService, ws)
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: (id: string) => {
      executed.push(id)
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService)
  const container = new InstantiationService(sc)
  render(
    <ServicesContext.Provider value={container}>
      <RemoteBadge />
    </ServicesContext.Provider>,
  )
  return executed
}

const REMOTE_FOLDER = URI.from({
  scheme: 'remote-ssh',
  authority: 'wsl+ubuntu-24.04',
  path: '/home/x/proj',
})

describe('RemoteBadge', () => {
  it('renders the authority label for a remote workspace', () => {
    renderBadge(makeWorkspaceStub({ folder: REMOTE_FOLDER, name: 'proj' }))
    const badge = screen.getByTestId('titlebar-remote-badge')
    expect(badge.textContent).toContain('WSL: ubuntu-24.04')
  })

  it('executes the remote menu command on click', () => {
    const executed = renderBadge(makeWorkspaceStub({ folder: REMOTE_FOLDER, name: 'proj' }))
    fireEvent.click(screen.getByTestId('titlebar-remote-badge'))
    expect(executed).toEqual(['workbench.action.remote.showMenu'])
  })

  it('renders nothing for a local workspace', () => {
    renderBadge(makeWorkspaceStub({ folder: URI.file('/tmp/proj'), name: 'proj' }))
    expect(screen.queryByTestId('titlebar-remote-badge')).toBeNull()
  })

  it('appears when the workspace changes to a remote folder', () => {
    const ws = makeWorkspaceStub(null)
    renderBadge(ws)
    expect(screen.queryByTestId('titlebar-remote-badge')).toBeNull()

    act(() => {
      ws.fireWorkspaceChange({ folder: REMOTE_FOLDER, name: 'proj' })
    })
    expect(screen.getByTestId('titlebar-remote-badge').textContent).toContain('WSL: ubuntu-24.04')
  })
})
