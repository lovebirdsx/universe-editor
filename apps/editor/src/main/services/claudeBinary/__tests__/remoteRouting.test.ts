/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/claudeBinary/claudeBinaryMainService.ts
 *  remote-authority routing: an `authority` on resolve routes through the
 *  AgentBinary channel of the remote connection (download semantics only),
 *  forwards download state with the authority attached, and filters out the
 *  other agent's events.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  RemoteChannels,
  type AgentBinaryVersionPolicy,
} from '@universe-editor/platform'
import {
  AgentBinaryStore,
  type AgentBinaryDownloadState,
  type AgentBinaryId,
  type AgentBinaryRemoteDownloadEvent,
  type AgentBinaryVersionInfo,
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { ClaudeBinaryMainService } from '../claudeBinaryMainService.js'
import type { IClaudeBinaryDownloadEvent } from '../../../../shared/ipc/claudeBinaryService.js'
import type { IRemoteConnectionService } from '../../remote/remoteConnectionMainService.js'
import { getTempRoot } from '@universe-editor/temp-root'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => getTempRoot() },
}))

function downloading(received: number, total: number): AgentBinaryDownloadState[] {
  return [{ version: '1.0.0', received, total, background: false }]
}

class FakeRemoteBinaryService implements IRemoteAgentBinaryService {
  declare readonly _serviceBrand: undefined
  private readonly _onDownload = new Emitter<AgentBinaryRemoteDownloadEvent>()
  readonly onDidChangeDownload = this._onDownload.event
  readonly resolves: {
    agent: AgentBinaryId
    allowDownload: boolean
    policy: AgentBinaryVersionPolicy
  }[] = []
  readonly versionInfos: { agent: AgentBinaryId; policy: AgentBinaryVersionPolicy }[] = []
  readonly forceDownloads: { agent: AgentBinaryId; version: string }[] = []
  readonly prefetches: { agent: AgentBinaryId; policy: AgentBinaryVersionPolicy }[] = []
  readonly cleanups: AgentBinaryId[] = []
  readonly syncs: AgentBinaryId[] = []
  syncResult: string | null = null

  async resolve(
    agent: AgentBinaryId,
    opts: { readonly allowDownload?: boolean; readonly policy: AgentBinaryVersionPolicy },
  ): Promise<{ readonly path: string }> {
    this.resolves.push({ agent, allowDownload: opts.allowDownload ?? true, policy: opts.policy })
    return { path: `/remote/${agent}` }
  }

  async getVersionInfo(
    agent: AgentBinaryId,
    policy: AgentBinaryVersionPolicy,
  ): Promise<AgentBinaryVersionInfo> {
    this.versionInfos.push({ agent, policy })
    return {
      bundledVersion: `bundled-${agent}`,
      installedVersion: `installed-${agent}`,
      latestVersion: `latest-${agent}`,
      downloadedVersions: [`installed-${agent}`],
      downloads: [],
    }
  }

  async forceDownload(agent: AgentBinaryId, version: string): Promise<{ readonly path: string }> {
    this.forceDownloads.push({ agent, version })
    return { path: `/remote/${agent}/${version}` }
  }

  async prefetch(agent: AgentBinaryId, policy: AgentBinaryVersionPolicy): Promise<void> {
    this.prefetches.push({ agent, policy })
  }

  async cleanupStaleVersions(agent: AgentBinaryId): Promise<void> {
    this.cleanups.push(agent)
  }

  async syncBundled(agent: AgentBinaryId): Promise<{ readonly version: string | null }> {
    this.syncs.push(agent)
    return { version: this.syncResult }
  }

  fireDownload(e: AgentBinaryRemoteDownloadEvent): void {
    this._onDownload.fire(e)
  }
}

interface Fixture {
  svc: ClaudeBinaryMainService
  remote: FakeRemoteBinaryService
  proxyCalls: Array<{ authority: string; channel: string }>
}

function makeFixture(): Fixture {
  const remote = new FakeRemoteBinaryService()
  const proxyCalls: Array<{ authority: string; channel: string }> = []
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getConnection: async () => {
      throw new Error('getConnection must not be used')
    },
    connect: async () => {
      throw new Error('not used')
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
    getServiceProxy: ((authority: string, channelName: string) => {
      proxyCalls.push({ authority, channel: channelName })
      return remote
    }) as IRemoteConnectionService['getServiceProxy'],
  }
  const svc = new ClaudeBinaryMainService(undefined, connService)
  return { svc, remote, proxyCalls }
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
      svc.resolve({
        source: 'custom',
        customPath: '/local/claude.exe',
        authority: 'host',
        policy: 'pinned',
      }),
    ).resolves.toEqual({ path: '/remote/claude' })
    expect(fixture.remote.resolves).toEqual([
      { agent: 'claude', allowDownload: true, policy: 'pinned' },
    ])
  })

  it('forwards allowDownload:false and the policy verbatim to the remote resolve', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.resolve({
      source: 'download',
      authority: 'host',
      allowDownload: false,
      policy: 'manual',
    })
    expect(fixture.remote.resolves).toEqual([
      { agent: 'claude', allowDownload: false, policy: 'manual' },
    ])
  })

  it('forwards remote download state with the authority attached, filtering out codex events', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const events: IClaudeBinaryDownloadEvent[] = []
    const sub = svc.onDidChangeDownload((e) => events.push(e))
    try {
      await svc.resolve({ source: 'download', authority: 'host', policy: 'pinned' })

      fixture.remote.fireDownload({ agent: 'claude', downloads: downloading(5, 100) })
      fixture.remote.fireDownload({ agent: 'codex', downloads: downloading(9, 100) })
      fixture.remote.fireDownload({ agent: 'claude', downloads: [] })

      expect(events).toEqual([
        { downloads: downloading(5, 100), authority: 'host' },
        { downloads: [], authority: 'host' },
      ])
    } finally {
      sub.dispose()
    }
  })

  it('routes getVersionInfo(policy, authority) to the remote channel with the claude agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(svc.getVersionInfo('pinned', 'host')).resolves.toEqual({
      bundledVersion: 'bundled-claude',
      installedVersion: 'installed-claude',
      latestVersion: 'latest-claude',
      downloadedVersions: ['installed-claude'],
      downloads: [],
    })
    expect(fixture.remote.versionInfos).toEqual([{ agent: 'claude', policy: 'pinned' }])
  })

  it('routes forceDownload(version, authority) to the remote channel and passes the version through', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(svc.forceDownload('1.2.3', 'host')).resolves.toEqual({
      path: '/remote/claude/1.2.3',
    })
    expect(fixture.remote.forceDownloads).toEqual([{ agent: 'claude', version: '1.2.3' }])
  })

  it('routes prefetch(policy, authority) to the remote channel with the claude agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.prefetch('pinned', 'host')
    expect(fixture.remote.prefetches).toEqual([{ agent: 'claude', policy: 'pinned' }])
  })

  it('routes cleanupStaleVersions(authority) to the remote channel with the claude agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.cleanupStaleVersions('host')
    expect(fixture.remote.cleanups).toEqual(['claude'])
  })

  it('prefetch without authority hits the local store and not the remote proxy', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const spy = vi.spyOn(AgentBinaryStore.prototype, 'prefetch').mockResolvedValue(undefined)
    try {
      await svc.prefetch('manual')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('manual')
      expect(fixture.remote.prefetches).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('cleanupStaleVersions without authority hits the local store and not the remote proxy', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const spy = vi
      .spyOn(AgentBinaryStore.prototype, 'cleanupStaleVersions')
      .mockResolvedValue(undefined)
    try {
      await svc.cleanupStaleVersions()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(fixture.remote.cleanups).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('routes syncBundled(authority) to the remote channel and unwraps the version', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    fixture.remote.syncResult = '1.2.3'

    await expect(svc.syncBundled('host')).resolves.toBe('1.2.3')
    expect(fixture.remote.syncs).toEqual(['claude'])
  })

  it('syncBundled without authority hits the local store and not the remote proxy', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const spy = vi.spyOn(AgentBinaryStore.prototype, 'syncBundled').mockResolvedValue('9.9.9')
    try {
      await expect(svc.syncBundled()).resolves.toBe('9.9.9')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(fixture.remote.syncs).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects an authority resolve when no connection service is injected', async () => {
    svc = new ClaudeBinaryMainService()
    await expect(
      svc.resolve({ source: 'download', authority: 'host', policy: 'pinned' }),
    ).rejects.toThrow(/remote connection service not available/)
  })

  it('routes repeated resolves through getServiceProxy with the AgentBinary channel', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.resolve({ source: 'download', authority: 'host', policy: 'pinned' })
    await svc.resolve({ source: 'download', authority: 'host', policy: 'pinned' })

    expect(fixture.proxyCalls).toEqual([
      { authority: 'host', channel: RemoteChannels.AgentBinary },
      { authority: 'host', channel: RemoteChannels.AgentBinary },
    ])
  })

  it('subscribes to remote download events once per authority across repeated resolves', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const events: IClaudeBinaryDownloadEvent[] = []
    const sub = svc.onDidChangeDownload((e) => events.push(e))
    try {
      await svc.resolve({ source: 'download', authority: 'host', policy: 'pinned' })
      await svc.resolve({ source: 'download', authority: 'host', policy: 'pinned' })

      fixture.remote.fireDownload({ agent: 'claude', downloads: downloading(5, 100) })

      expect(events).toEqual([{ downloads: downloading(5, 100), authority: 'host' }])
    } finally {
      sub.dispose()
    }
  })
})
