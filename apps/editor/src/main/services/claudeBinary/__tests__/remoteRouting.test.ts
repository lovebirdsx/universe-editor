/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/claudeBinary/claudeBinaryMainService.ts
 *  remote-authority routing: an `authority` on resolve routes through the
 *  AgentBinary channel of the remote connection (download semantics only),
 *  forwards progress with the authority attached, and filters out the other
 *  agent's events.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
} from '@universe-editor/platform'
import type { IRemoteEnvironment } from '@universe-editor/platform'
import type {
  AgentBinaryId,
  AgentBinaryRemoteProgressEvent,
  AgentBinaryVersionInfo,
  IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { ClaudeBinaryMainService } from '../claudeBinaryMainService.js'
import type { IClaudeBinaryProgress } from '../../../../shared/ipc/claudeBinaryService.js'
import type {
  IRemoteConnection,
  IRemoteConnectionService,
} from '../../remote/remoteConnectionMainService.js'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => tmpdir() },
}))

const REMOTE_ENV: IRemoteEnvironment = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  serverVersion: '0.0.0',
  os: 'linux',
  arch: 'x64',
  nodeVersion: '20.0.0',
  pathCaseSensitive: true,
  homeDir: '/home/u',
  tmpDir: '/tmp',
}

class FakeRemoteBinaryService implements IRemoteAgentBinaryService {
  declare readonly _serviceBrand: undefined
  private readonly _onProgress = new Emitter<AgentBinaryRemoteProgressEvent>()
  readonly onDidChangeProgress = this._onProgress.event
  readonly resolves: { agent: AgentBinaryId; allowDownload: boolean }[] = []
  readonly versionInfos: AgentBinaryId[] = []
  readonly forceDownloads: { agent: AgentBinaryId; version: string }[] = []

  async resolve(
    agent: AgentBinaryId,
    opts: { readonly allowDownload?: boolean },
  ): Promise<{ readonly path: string }> {
    this.resolves.push({ agent, allowDownload: opts.allowDownload ?? true })
    return { path: `/remote/${agent}` }
  }

  async getVersionInfo(agent: AgentBinaryId): Promise<AgentBinaryVersionInfo> {
    this.versionInfos.push(agent)
    return {
      bundledVersion: `bundled-${agent}`,
      installedVersion: `installed-${agent}`,
      latestVersion: `latest-${agent}`,
      prefetchedVersion: null,
    }
  }

  async forceDownload(agent: AgentBinaryId, version: string): Promise<{ readonly path: string }> {
    this.forceDownloads.push({ agent, version })
    return { path: `/remote/${agent}/${version}` }
  }

  fireProgress(e: AgentBinaryRemoteProgressEvent): void {
    this._onProgress.fire(e)
  }
}

interface Fixture {
  svc: ClaudeBinaryMainService
  remote: FakeRemoteBinaryService
  closeEmitter: Emitter<void>
  connectionCalls: () => number
}

function makeFixture(): Fixture {
  const remote = new FakeRemoteBinaryService()
  const closeEmitter = new Emitter<void>()
  let connectionCalls = 0
  const conn: IRemoteConnection = {
    authority: 'host',
    env: REMOTE_ENV,
    getChannel: (name) => {
      expect(name).toBe(RemoteChannels.AgentBinary)
      return ProxyChannel.fromService(remote)
    },
    onDidClose: closeEmitter.event,
  }
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getConnection: async () => {
      connectionCalls++
      return conn
    },
    openExtensionHostConnection: async () => {
      throw new Error('not used')
    },
    onDidChangeState: Event.None,
    retryConnection: () => undefined,
    stopServer: async () => undefined,
    closeConnection: async () => undefined,
    dropSocketForTesting: () => undefined,
    dropExtensionHostSocketForTesting: () => undefined,
    dispose: () => undefined,
  }
  const svc = new ClaudeBinaryMainService(undefined, connService)
  return { svc, remote, closeEmitter, connectionCalls: () => connectionCalls }
}

describe('ClaudeBinaryMainService — remote routing', () => {
  let svc: ClaudeBinaryMainService

  afterEach(() => {
    svc?.dispose()
  })

  it('routes an authority resolve to the AgentBinary channel (download semantics, source ignored)', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(
      svc.resolve({ source: 'custom', customPath: '/local/claude.exe', authority: 'host' }),
    ).resolves.toEqual({ path: '/remote/claude' })
    expect(fixture.remote.resolves).toEqual([{ agent: 'claude', allowDownload: true }])
  })

  it('forwards allowDownload:false verbatim to the remote resolve', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.resolve({ source: 'download', authority: 'host', allowDownload: false })
    expect(fixture.remote.resolves).toEqual([{ agent: 'claude', allowDownload: false }])
  })

  it('forwards progress with the authority attached, filtering out codex events', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const events: IClaudeBinaryProgress[] = []
    const sub = svc.onDidChangeProgress((e) => events.push(e))
    try {
      await svc.resolve({ source: 'download', authority: 'host' })

      fixture.remote.fireProgress({ agent: 'claude', received: 5, total: 100 })
      fixture.remote.fireProgress({ agent: 'codex', received: 9, total: 100 })
      fixture.remote.fireProgress({ agent: 'claude', received: 100, total: 100 })

      expect(events).toEqual([
        { received: 5, total: 100, authority: 'host' },
        { received: 100, total: 100, authority: 'host' },
      ])
    } finally {
      sub.dispose()
    }
  })

  it('routes getVersionInfo(authority) to the remote channel with the claude agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(svc.getVersionInfo('host')).resolves.toEqual({
      bundledVersion: 'bundled-claude',
      installedVersion: 'installed-claude',
      latestVersion: 'latest-claude',
      prefetchedVersion: null,
    })
    expect(fixture.remote.versionInfos).toEqual(['claude'])
  })

  it('routes forceDownload(version, authority) to the remote channel and passes the version through', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(svc.forceDownload('1.2.3', 'host')).resolves.toEqual({
      path: '/remote/claude/1.2.3',
    })
    expect(fixture.remote.forceDownloads).toEqual([{ agent: 'claude', version: '1.2.3' }])
  })

  it('rejects an authority resolve when no connection service is injected', async () => {
    svc = new ClaudeBinaryMainService()
    await expect(svc.resolve({ source: 'download', authority: 'host' })).rejects.toThrow(
      /remote connection service not available/,
    )
  })

  it('drops the remote proxy on connection close and rebuilds on the next resolve', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.resolve({ source: 'download', authority: 'host' })
    expect(fixture.connectionCalls()).toBe(1)

    fixture.closeEmitter.fire()
    await svc.resolve({ source: 'download', authority: 'host' })
    expect(fixture.connectionCalls()).toBe(2)
  })
})
