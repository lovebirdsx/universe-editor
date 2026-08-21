/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/codexBinary/codexBinaryMainService.ts
 *  remote-authority routing: an `authority` on resolve routes through the
 *  AgentBinary channel of the remote connection (download semantics only),
 *  forwards progress with the authority attached, and filters out the other
 *  agent's events.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter, Event, RemoteChannels } from '@universe-editor/platform'
import {
  AgentBinaryStore,
  type AgentBinaryId,
  type AgentBinaryRemoteProgressEvent,
  type AgentBinaryVersionInfo,
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { CodexBinaryMainService } from '../codexBinaryMainService.js'
import type { ICodexBinaryProgress } from '../../../../shared/ipc/codexBinaryService.js'
import type { IRemoteConnectionService } from '../../remote/remoteConnectionMainService.js'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => tmpdir() },
}))

class FakeRemoteBinaryService implements IRemoteAgentBinaryService {
  declare readonly _serviceBrand: undefined
  private readonly _onProgress = new Emitter<AgentBinaryRemoteProgressEvent>()
  readonly onDidChangeProgress = this._onProgress.event
  readonly resolves: { agent: AgentBinaryId; allowDownload: boolean }[] = []
  readonly versionInfos: AgentBinaryId[] = []
  readonly forceDownloads: { agent: AgentBinaryId; version: string }[] = []
  readonly prefetches: AgentBinaryId[] = []
  readonly cleanups: AgentBinaryId[] = []

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

  async prefetch(agent: AgentBinaryId): Promise<void> {
    this.prefetches.push(agent)
  }

  async cleanupStaleVersions(agent: AgentBinaryId): Promise<void> {
    this.cleanups.push(agent)
  }

  fireProgress(e: AgentBinaryRemoteProgressEvent): void {
    this._onProgress.fire(e)
  }
}

interface Fixture {
  svc: CodexBinaryMainService
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
  const svc = new CodexBinaryMainService(undefined, connService)
  return { svc, remote, proxyCalls }
}

describe('CodexBinaryMainService — remote routing', () => {
  let svc: CodexBinaryMainService

  afterEach(() => {
    svc?.dispose()
  })

  it('routes an authority resolve to the AgentBinary channel (download semantics, source ignored)', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(
      svc.resolve({ source: 'custom', customPath: '/local/codex.exe', authority: 'host' }),
    ).resolves.toEqual({ path: '/remote/codex' })
    expect(fixture.remote.resolves).toEqual([{ agent: 'codex', allowDownload: true }])
  })

  it('forwards allowDownload:false verbatim to the remote resolve', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.resolve({ source: 'download', authority: 'host', allowDownload: false })
    expect(fixture.remote.resolves).toEqual([{ agent: 'codex', allowDownload: false }])
  })

  it('forwards progress with the authority attached, filtering out claude events', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const events: ICodexBinaryProgress[] = []
    const sub = svc.onDidChangeProgress((e) => events.push(e))
    try {
      await svc.resolve({ source: 'download', authority: 'host' })

      fixture.remote.fireProgress({ agent: 'codex', received: 5, total: 100 })
      fixture.remote.fireProgress({ agent: 'claude', received: 9, total: 100 })
      fixture.remote.fireProgress({ agent: 'codex', received: 100, total: 100 })

      expect(events).toEqual([
        { received: 5, total: 100, authority: 'host' },
        { received: 100, total: 100, authority: 'host' },
      ])
    } finally {
      sub.dispose()
    }
  })

  it('routes getVersionInfo(authority) to the remote channel with the codex agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(svc.getVersionInfo('host')).resolves.toEqual({
      bundledVersion: 'bundled-codex',
      installedVersion: 'installed-codex',
      latestVersion: 'latest-codex',
      prefetchedVersion: null,
    })
    expect(fixture.remote.versionInfos).toEqual(['codex'])
  })

  it('routes forceDownload(version, authority) to the remote channel and passes the version through', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await expect(svc.forceDownload('1.2.3', 'host')).resolves.toEqual({
      path: '/remote/codex/1.2.3',
    })
    expect(fixture.remote.forceDownloads).toEqual([{ agent: 'codex', version: '1.2.3' }])
  })

  it('routes prefetch(authority) to the remote channel with the codex agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.prefetch('host')
    expect(fixture.remote.prefetches).toEqual(['codex'])
  })

  it('routes cleanupStaleVersions(authority) to the remote channel with the codex agent id', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.cleanupStaleVersions('host')
    expect(fixture.remote.cleanups).toEqual(['codex'])
  })

  it('prefetch without authority hits the local store and not the remote proxy', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const spy = vi.spyOn(AgentBinaryStore.prototype, 'prefetch').mockResolvedValue(undefined)
    try {
      await svc.prefetch()
      expect(spy).toHaveBeenCalledTimes(1)
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

  it('rejects an authority resolve when no connection service is injected', async () => {
    svc = new CodexBinaryMainService()
    await expect(svc.resolve({ source: 'download', authority: 'host' })).rejects.toThrow(
      /remote connection service not available/,
    )
  })

  it('routes repeated resolves through getServiceProxy with the AgentBinary channel', async () => {
    const fixture = makeFixture()
    svc = fixture.svc

    await svc.resolve({ source: 'download', authority: 'host' })
    await svc.resolve({ source: 'download', authority: 'host' })

    expect(fixture.proxyCalls).toEqual([
      { authority: 'host', channel: RemoteChannels.AgentBinary },
      { authority: 'host', channel: RemoteChannels.AgentBinary },
    ])
  })

  it('subscribes to remote progress once per authority across repeated resolves', async () => {
    const fixture = makeFixture()
    svc = fixture.svc
    const events: ICodexBinaryProgress[] = []
    const sub = svc.onDidChangeProgress((e) => events.push(e))
    try {
      await svc.resolve({ source: 'download', authority: 'host' })
      await svc.resolve({ source: 'download', authority: 'host' })

      fixture.remote.fireProgress({ agent: 'codex', received: 5, total: 100 })

      expect(events).toEqual([{ received: 5, total: 100, authority: 'host' }])
    } finally {
      sub.dispose()
    }
  })
})
