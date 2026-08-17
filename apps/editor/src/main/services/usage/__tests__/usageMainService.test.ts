/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Routing tests for UsageMainService — local (no authority) reads the local
 *  settings file; remote (authority) proxies through the remote AgentConfig
 *  channel's claudeFetchUsage.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Event,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  type IRemoteEnvironment,
} from '@universe-editor/platform'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  CodexAuthStatus,
  CodexSettings,
  IRemoteAgentConfigService,
  UsageResult,
} from '@universe-editor/node-services'
import { UsageMainService } from '../usageMainService.js'
import type {
  IRemoteConnection,
  IRemoteConnectionService,
} from '../../remote/remoteConnectionMainService.js'

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

class FakeRemoteAgentConfigService implements IRemoteAgentConfigService {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeCodexAuth: Event<void> = Event.None
  usageResult: UsageResult = { kind: 'disabled', reason: 'not configured' }
  usageCalls = 0

  claudeRead(): Promise<ClaudeSettings> {
    return Promise.resolve({})
  }
  claudePatch(): Promise<void> {
    return Promise.resolve()
  }
  claudeConfigPath(): Promise<string> {
    return Promise.resolve('/home/u/.claude/settings.json')
  }
  claudeReadAuthStatus(): Promise<ClaudeAuthStatus> {
    return Promise.resolve({ loggedIn: false, expired: false })
  }
  claudeFetchUsage(): Promise<UsageResult> {
    this.usageCalls++
    return Promise.resolve(this.usageResult)
  }
  codexRead(): Promise<CodexSettings> {
    return Promise.resolve({})
  }
  codexPatch(): Promise<void> {
    return Promise.resolve()
  }
  codexApplyCredential(): Promise<CodexAuthStatus> {
    return Promise.resolve({ active: 'none', hasApiKey: false })
  }
  codexConfigPath(): Promise<string> {
    return Promise.resolve('/home/u/.codex/config.toml')
  }
  codexReadAuthStatus(): Promise<CodexAuthStatus> {
    return Promise.resolve({ active: 'none', hasApiKey: false })
  }
  checkGatewayConnectivity(): Promise<boolean> {
    return Promise.resolve(true)
  }
  codexMatchActiveApiKey(): Promise<number> {
    return Promise.resolve(-1)
  }
}

function makeConnectionService(remote: FakeRemoteAgentConfigService): {
  connService: IRemoteConnectionService
  proxyCalls: Array<{ authority: string; channel: string }>
} {
  const proxyCalls: Array<{ authority: string; channel: string }> = []
  const conn: IRemoteConnection = {
    authority: 'host',
    env: REMOTE_ENV,
    getChannel: () => {
      throw new Error('getChannel must not be used')
    },
    onDidClose: Event.None,
  }
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getConnection: async () => conn,
    connect: async () => conn,
    openExtensionHostConnection: async () => {
      throw new Error('not used in this test')
    },
    onDidChangeState: Event.None,
    retryConnection: () => undefined,
    stopServer: async () => undefined,
    closeConnection: async () => undefined,
    dropSocketForTesting: () => undefined,
    dropExtensionHostSocketForTesting: () => undefined,
    dispose: () => undefined,
    getServiceProxy: <T extends object>(authority: string, channelName: string): T => {
      proxyCalls.push({ authority, channel: channelName })
      return remote as T
    },
  }
  return { connService, proxyCalls }
}

describe('UsageMainService', () => {
  const dirs: string[] = []
  const svcs: UsageMainService[] = []

  afterEach(async () => {
    for (const s of svcs) s.dispose()
    svcs.length = 0
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'usage-main-'))
    dirs.push(dir)
    return dir
  }

  it('reads the local settings file when no authority is given', async () => {
    const dir = await makeTempDir()
    const svc = new UsageMainService(join(dir, 'settings.json'))
    svcs.push(svc)

    // File absent → disabled, and no remote connection service is required.
    await expect(svc.getUsage()).resolves.toMatchObject({ kind: 'disabled' })
  })

  it('routes through the remote AgentConfig channel when an authority is given', async () => {
    const remote = new FakeRemoteAgentConfigService()
    remote.usageResult = {
      kind: 'ok',
      snapshot: {
        date: '20260811',
        periodBucket: 'week:2026W33',
        periodUsedCny: 1,
        periodLimitCny: 2,
        periodRemainingCny: 1,
        requests: 3,
        rawTokens: 4,
        models: [],
      },
    }
    const dir = await makeTempDir()
    const { connService, proxyCalls } = makeConnectionService(remote)
    const svc = new UsageMainService(join(dir, 'settings.json'), undefined, connService)
    svcs.push(svc)

    await expect(svc.getUsage('host')).resolves.toEqual(remote.usageResult)
    expect(remote.usageCalls).toBe(1)
    expect(proxyCalls).toEqual([{ authority: 'host', channel: RemoteChannels.AgentConfig }])
  })

  it('routes repeated calls through the stable remote proxy without re-creating it', async () => {
    const remote = new FakeRemoteAgentConfigService()
    const dir = await makeTempDir()
    const { connService, proxyCalls } = makeConnectionService(remote)
    const svc = new UsageMainService(join(dir, 'settings.json'), undefined, connService)
    svcs.push(svc)

    await svc.getUsage('host')
    await svc.getUsage('host')
    expect(remote.usageCalls).toBe(2)
    expect(proxyCalls).toEqual([
      { authority: 'host', channel: RemoteChannels.AgentConfig },
      { authority: 'host', channel: RemoteChannels.AgentConfig },
    ])
  })
})
