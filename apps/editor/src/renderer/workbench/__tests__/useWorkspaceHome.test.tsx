/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for useWorkspaceHome — the home of the host the context lives on, and
 *  its degradation rules: without an authority the client home is the right one;
 *  with a remote authority whose environment is unknown the answer is `undefined`
 *  and never the client's home, which would name a file on the wrong machine.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Emitter,
  InstantiationService,
  IWorkspaceService,
  ServiceCollection,
  URI,
  type IWorkspace,
} from '@universe-editor/platform'
import { IRemoteStatusService } from '../../../shared/ipc/remoteStatusService.js'
import type {
  RemoteConnectionStatusDto,
  RemoteEnvironmentDto,
} from '../../../shared/ipc/remoteStatusService.js'
import { ServicesContext } from '../useService.js'
import { useWorkspaceHome } from '../useWorkspaceHome.js'

const AUTHORITY = 'wsl+ubuntu2004'
const CLIENT_HOME = 'C:/Users/testuser'
const REMOTE = URI.from({ scheme: 'remote-ssh', authority: AUTHORITY, path: '/home/dev/proj' })
const LOCAL = URI.file('/repo')
const ENV: RemoteEnvironmentDto = {
  os: 'linux',
  arch: 'x64',
  homeDir: '/home/dev',
  tmpDir: '/tmp',
  pathCaseSensitive: true,
  serverVersion: '0.0.0',
}

function makeWorkspace(initial: IWorkspace | null) {
  const emitter = new Emitter<IWorkspace | null>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: emitter.event,
    set(next: IWorkspace | null) {
      current = next
      emitter.fire(next)
    },
  }
}

function makeRemoteStatus(answer: (authority: string) => RemoteEnvironmentDto | null) {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  const getEnvironment = vi.fn((authority: string) => Promise.resolve(answer(authority)))
  return {
    getEnvironment,
    service: {
      _serviceBrand: undefined,
      getEnvironment,
      onDidChangeState: emitter.event,
    } as unknown as IRemoteStatusService,
    reconnect(authority = AUTHORITY) {
      emitter.fire({ authority, state: 'connected' })
    },
  }
}

function mount(
  contextUri?: URI,
  options: {
    workspace?: ReturnType<typeof makeWorkspace>
    remoteStatus?: IRemoteStatusService
  } = {},
) {
  const services = new ServiceCollection()
  if (options.workspace) services.set(IWorkspaceService, options.workspace as never)
  if (options.remoteStatus) services.set(IRemoteStatusService, options.remoteStatus)
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useWorkspaceHome(contextUri), { wrapper })
}

afterEach(() => {
  cleanup()
  delete (window as { ipc?: unknown }).ipc
})

describe('useWorkspaceHome', () => {
  it('returns no home when neither the bridge nor a workspace reports one', () => {
    const { result } = mount()
    expect(result.current.home).toBeUndefined()
  })

  it('uses the client home for a local workspace', () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const { result } = mount(undefined, {
      workspace: makeWorkspace({ folder: LOCAL, name: 'repo' }),
    })
    expect(result.current.home).toBe(CLIENT_HOME)
  })

  it('reads the remote home for a remote workspace folder', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const remoteStatus = makeRemoteStatus(() => ENV)
    const { result } = mount(undefined, {
      workspace: makeWorkspace({ folder: REMOTE, name: 'proj' }),
      remoteStatus: remoteStatus.service,
    })

    await waitFor(() => expect(result.current.home).toBe('/home/dev'))
    await expect(result.current.resolveHome()).resolves.toBe('/home/dev')
  })

  it('follows workspace hydration from no folder to a remote folder', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const workspace = makeWorkspace(null)
    const remoteStatus = makeRemoteStatus(() => ENV)
    const { result } = mount(undefined, { workspace, remoteStatus: remoteStatus.service })
    expect(result.current.home).toBe(CLIENT_HOME)

    act(() => {
      workspace.set({ folder: REMOTE, name: 'proj' })
    })
    await waitFor(() => expect(result.current.home).toBe('/home/dev'))
  })

  it('re-reads the environment when the authority reconnects', async () => {
    let env: RemoteEnvironmentDto | null = null
    const remoteStatus = makeRemoteStatus(() => env)
    const { result } = mount(undefined, {
      workspace: makeWorkspace({ folder: REMOTE, name: 'proj' }),
      remoteStatus: remoteStatus.service,
    })
    await waitFor(() => expect(remoteStatus.getEnvironment).toHaveBeenCalled())
    expect(result.current.home).toBeUndefined()

    env = ENV
    act(() => {
      remoteStatus.reconnect()
    })
    await waitFor(() => expect(result.current.home).toBe('/home/dev'))
  })

  it('prefers the context URI over the workspace folder', async () => {
    const other = URI.from({
      scheme: 'remote-ssh',
      authority: 'ssh-remote+other',
      path: '/srv/proj',
    })
    const remoteStatus = makeRemoteStatus((authority) =>
      authority === 'ssh-remote+other' ? { ...ENV, homeDir: '/srv/home' } : ENV,
    )
    const { result } = mount(other, {
      workspace: makeWorkspace({ folder: REMOTE, name: 'proj' }),
      remoteStatus: remoteStatus.service,
    })

    await waitFor(() => expect(result.current.home).toBe('/srv/home'))
    expect(remoteStatus.getEnvironment).toHaveBeenCalledWith('ssh-remote+other')
  })

  it('never guesses the client home for a remote authority', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const remoteStatus = makeRemoteStatus(() => null)
    const { result } = mount(undefined, {
      workspace: makeWorkspace({ folder: REMOTE, name: 'proj' }),
      remoteStatus: remoteStatus.service,
    })

    await waitFor(() => expect(remoteStatus.getEnvironment).toHaveBeenCalled())
    expect(result.current.home).toBeUndefined()
    await expect(result.current.resolveHome()).resolves.toBeUndefined()
  })
})
