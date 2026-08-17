/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for apps/editor/src/main/services/extensionHost/remoteExtensionHostService.ts
 *  and the authority-branch routing added to ExtensionHostMainService. Uses a fake
 *  IRemoteConnectionService + fake tunnel so no TCP / real process is spawned.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter, Event } from '@universe-editor/platform'
import type { IRemoteConnectionService as IRemoteConnectionServiceType } from '../../remote/remoteConnectionMainService.js'
import type { IRemoteExtensionHostTunnel } from '../../remote/remoteExtensionHostTunnel.js'
import type {
  ExtHostExitEvent,
  ExtHostStdioChunk,
} from '../../../../shared/ipc/extensionHostService.js'
import { RemoteExtensionHostService } from '../remoteExtensionHostService.js'
import { ExtensionHostMainService } from '../extensionHostMainService.js'
import type { IRemoteExtensionHostStartArgs } from '@universe-editor/platform'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => '/fake/userData' },
}))

const decode = (b: Uint8Array): string => new TextDecoder().decode(b)

class FakeTunnel implements IRemoteExtensionHostTunnel {
  private readonly _onData = new Emitter<Uint8Array>()
  readonly onData = this._onData.event
  private readonly _onExit = new Emitter<{ code: number | null }>()
  readonly onExit = this._onExit.event
  private readonly _onDidClose = new Emitter<void>()
  readonly onDidClose = this._onDidClose.event

  readonly sent: Uint8Array[] = []
  disposed = false

  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  fireData(data: string): void {
    this._onData.fire(new TextEncoder().encode(data))
  }
  fireExit(code: number | null): void {
    this._onExit.fire({ code })
  }
  fireClose(): void {
    this._onDidClose.fire()
  }
  dropSocketForTesting(): void {
    // No-op for the fake — reconnection is exercised at the connection-service level.
  }
  dispose(): void {
    this.disposed = true
  }
}

function makeConnectionService(): {
  connService: IRemoteConnectionServiceType
  tunnels: FakeTunnel[]
  startArgs: IRemoteExtensionHostStartArgs[]
} {
  const tunnels: FakeTunnel[] = []
  const startArgs: IRemoteExtensionHostStartArgs[] = []
  const connService: IRemoteConnectionServiceType = {
    _serviceBrand: undefined,
    getConnection: async () => {
      throw new Error('not used')
    },
    connect: async () => {
      throw new Error('not used')
    },
    openExtensionHostConnection: async (_authority, args) => {
      startArgs.push(args ?? {})
      const t = new FakeTunnel()
      tunnels.push(t)
      return t
    },
    onDidChangeState: Event.None,
    retryConnection: () => undefined,
    stopServer: async () => undefined,
    closeConnection: async () => undefined,
    dropSocketForTesting: () => undefined,
    dropExtensionHostSocketForTesting: () => undefined,
    dispose: () => undefined,
    getServiceProxy: () => {
      throw new Error('not stubbed')
    },
  }
  return { connService, tunnels, startArgs }
}

function makeFacade(remote?: RemoteExtensionHostService): ExtensionHostMainService {
  return new ExtensionHostMainService(
    () => {
      throw new Error('local spawn must not be used in these tests')
    },
    () => '/fake/entry.js',
    () => '/fake/builtin',
    () => '/fake/user',
    () => ({ kind: 'tsls', cli: '/fake/cli.mjs', tsserver: '/fake/tsserver.js', version: '0' }),
    () => [],
    () => ({ port: undefined, brk: undefined }),
    undefined,
    remote,
  )
}

describe('RemoteExtensionHostService', () => {
  let svc: RemoteExtensionHostService | undefined
  let connService: IRemoteConnectionServiceType | undefined
  let tunnels: FakeTunnel[] = []
  let startArgs: IRemoteExtensionHostStartArgs[] = []

  afterEach(() => {
    svc?.dispose()
    svc = undefined
    connService = undefined
    tunnels = []
    startArgs = []
  })

  it('maps start/writeStdin/onData/onExit onto the tunnel', async () => {
    const made = makeConnectionService()
    connService = made.connService
    tunnels = made.tunnels
    svc = new RemoteExtensionHostService(connService)

    const stdout: ExtHostStdioChunk[] = []
    const exits: ExtHostExitEvent[] = []
    svc.onStdout((e) => stdout.push(e))
    svc.onExit((e) => exits.push(e))

    const { handle } = await svc.start({ authority: 'host' })
    expect(tunnels).toHaveLength(1)
    const tunnel = tunnels[0]!

    await svc.writeStdin(handle, 'hello\n')
    expect(tunnel.sent.map(decode)).toEqual(['hello\n'])

    tunnel.fireData('echo:hello\n')
    expect(stdout).toEqual([{ handle, data: 'echo:hello\n' }])

    tunnel.fireExit(7)
    expect(exits).toEqual([{ handle, code: 7, signal: null }])
  })

  it('forwards the host-independent spec fields as env over the tunnel', async () => {
    const made = makeConnectionService()
    connService = made.connService
    tunnels = made.tunnels
    startArgs = made.startArgs
    svc = new RemoteExtensionHostService(connService)

    await svc.start({
      authority: 'host',
      workspaceRoot: '/remote/root',
      locale: 'zh-CN',
      disabledIds: ['a.b', 'c.d'],
    })

    expect(startArgs).toEqual([
      {
        env: {
          UNIVERSE_WORKSPACE_ROOT: '/remote/root',
          UNIVERSE_DISPLAY_LOCALE: 'zh-CN',
          UNIVERSE_DISABLED_EXTENSIONS: 'a.b,c.d',
        },
      },
    ])
  })

  it('maps onDidClose to a code-null exit (permanent connection loss)', async () => {
    const made = makeConnectionService()
    connService = made.connService
    tunnels = made.tunnels
    svc = new RemoteExtensionHostService(connService)

    const exits: ExtHostExitEvent[] = []
    svc.onExit((e) => exits.push(e))

    const { handle } = await svc.start({ authority: 'host' })
    tunnels[0]!.fireClose()
    expect(exits).toEqual([{ handle, code: null, signal: null }])
  })

  it('rejects writeStdin for an unknown handle', async () => {
    const made = makeConnectionService()
    connService = made.connService
    svc = new RemoteExtensionHostService(connService)

    await expect(svc.writeStdin('nope', 'x')).rejects.toThrow(/unknown or exited handle/)
  })
})

describe('ExtensionHostMainService authority routing', () => {
  it('routes start/writeStdin/onStdout to the remote service when authority is set', async () => {
    const made = makeConnectionService()
    const remote = new RemoteExtensionHostService(made.connService)
    const facade = makeFacade(remote)

    const stdout: ExtHostStdioChunk[] = []
    facade.onStdout((e) => stdout.push(e))

    const { handle } = await facade.start({ authority: 'host' })
    expect(made.tunnels).toHaveLength(1)

    await facade.writeStdin(handle, 'ping\n')
    expect(made.tunnels[0]!.sent.map(decode)).toEqual(['ping\n'])

    made.tunnels[0]!.fireData('pong\n')
    expect(stdout).toEqual([{ handle, data: 'pong\n' }])

    facade.dispose()
    remote.dispose()
  })

  it('disposes the remote service when the facade is disposed', async () => {
    const made = makeConnectionService()
    const remote = new RemoteExtensionHostService(made.connService)
    const facade = makeFacade(remote)

    await facade.start({ authority: 'host' })
    const tunnel = made.tunnels[0]!
    expect(tunnel.disposed).toBe(false)

    facade.dispose()
    expect(tunnel.disposed).toBe(true)
  })

  it('rejects start with an authority when no remote service is wired', async () => {
    const facade = makeFacade(undefined)
    await expect(facade.start({ authority: 'host' })).rejects.toThrow(/not wired/)
    facade.dispose()
  })
})
