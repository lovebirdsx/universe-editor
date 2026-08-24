/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ClaudeConfigMainService — read fallbacks, deep-merge patch
 *  semantics, env key-by-key merge + delete, and preservation of unmanaged keys.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
} from '@universe-editor/node-services'
import { ClaudeConfigMainService } from '../claudeConfigMainService.js'
import type { IConfigLocationService } from '../../../../shared/ipc/configLocationService.js'
import type {
  IRemoteConnection,
  IRemoteConnectionService,
} from '../../remote/remoteConnectionMainService.js'

function configLocation(dir: string): IConfigLocationService {
  return {
    getInfo: () => Promise.resolve({ dir, origin: 'default', locked: false }),
  } as IConfigLocationService
}

describe('ClaudeConfigMainService', () => {
  let dir: string
  let settingsPath: string
  let svc: ClaudeConfigMainService

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'claude-config-'))
    settingsPath = join(dir, 'settings.json')
    svc = new ClaudeConfigMainService(settingsPath)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeRaw(value: unknown): Promise<void> {
    await fs.writeFile(settingsPath, JSON.stringify(value, null, 2), 'utf8')
  }

  async function readRaw(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>
  }

  it('returns {} when the file is absent', async () => {
    expect(await svc.read()).toEqual({})
  })

  it('returns {} when the file is malformed JSON', async () => {
    await fs.writeFile(settingsPath, '{ not json', 'utf8')
    expect(await svc.read()).toEqual({})
  })

  it('reads back an existing file', async () => {
    await writeRaw({ model: 'opus', env: { ANTHROPIC_API_KEY: 'sk-1' } })
    expect(await svc.read()).toEqual({ model: 'opus', env: { ANTHROPIC_API_KEY: 'sk-1' } })
  })

  it('creates the file (and dir) on first patch', async () => {
    const nested = new ClaudeConfigMainService(join(dir, 'sub', 'settings.json'))
    await nested.patch({ model: 'opus' })
    expect(await nested.read()).toEqual({ model: 'opus' })
  })

  it('merges top-level keys and preserves unmanaged keys', async () => {
    await writeRaw({ model: 'opus', unknownKey: { keep: true } })
    await svc.patch({ language: 'japanese' })
    expect(await readRaw()).toEqual({
      model: 'opus',
      language: 'japanese',
      unknownKey: { keep: true },
    })
  })

  it('deletes a top-level key when patched with null', async () => {
    await writeRaw({ model: 'opus', language: 'spanish' })
    await svc.patch({ model: null })
    expect(await readRaw()).toEqual({ language: 'spanish' })
  })

  it('merges env key-by-key without clobbering other env entries', async () => {
    await writeRaw({ env: { ANTHROPIC_BASE_URL: 'https://x', KEEP: '1' } })
    await svc.patch({ env: { ANTHROPIC_API_KEY: 'sk-2' } })
    expect((await readRaw()).env).toEqual({
      ANTHROPIC_BASE_URL: 'https://x',
      KEEP: '1',
      ANTHROPIC_API_KEY: 'sk-2',
    })
  })

  it('deletes a single env entry with null and drops empty env', async () => {
    await writeRaw({ env: { ANTHROPIC_API_KEY: 'sk-2' } })
    await svc.patch({ env: { ANTHROPIC_API_KEY: null } })
    expect('env' in (await readRaw())).toBe(false)
  })

  it('writes atomically (no leftover temp file)', async () => {
    await svc.patch({ model: 'opus' })
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['settings.json'])
  })

  it('stores the agent settings (authentication / model / subagentModel) in aiSettings.json', async () => {
    const configDir = join(dir, 'editor-settings')
    svc = new ClaudeConfigMainService(settingsPath, undefined, configLocation(configDir))
    await svc.writeAgentSettings({
      authentication: 'gw',
      model: 'kimi-k3',
      subagentModel: 'kimi-k3-mini',
    })

    expect(await svc.readAgentSettings()).toEqual({
      authentication: 'gw',
      model: 'kimi-k3',
      subagentModel: 'kimi-k3-mini',
    })
    const stored = JSON.parse(await fs.readFile(join(configDir, 'aiSettings.json'), 'utf8'))
    expect(stored.agentSettings.claude).toEqual({
      authentication: 'gw',
      model: 'kimi-k3',
      subagentModel: 'kimi-k3-mini',
    })
  })

  describe('readAuthStatus', () => {
    const credPath = () => join(dir, '.credentials.json')

    it('returns logged-out when the credentials file is absent', async () => {
      expect(await svc.readAuthStatus()).toEqual({ loggedIn: false, expired: false })
    })

    it('returns logged-out when the file is malformed JSON', async () => {
      await fs.writeFile(credPath(), '{ not json', 'utf8')
      expect(await svc.readAuthStatus()).toEqual({ loggedIn: false, expired: false })
    })

    it('returns logged-out when there is no usable access token', async () => {
      await fs.writeFile(credPath(), JSON.stringify({ claudeAiOauth: { accessToken: '' } }), 'utf8')
      expect(await svc.readAuthStatus()).toEqual({ loggedIn: false, expired: false })
    })

    it('reports a valid login with subscription and expiry', async () => {
      const expiresAt = Date.now() + 60_000
      await fs.writeFile(
        credPath(),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'sk-ant-oat01-x', expiresAt, subscriptionType: 'pro' },
        }),
        'utf8',
      )
      expect(await svc.readAuthStatus()).toEqual({
        loggedIn: true,
        expired: false,
        subscriptionType: 'pro',
        expiresAt,
      })
    })

    it('flags an expired token when no refresh token can renew it', async () => {
      const expiresAt = Date.now() - 60_000
      await fs.writeFile(
        credPath(),
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', expiresAt } }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.loggedIn).toBe(true)
      expect(status.expired).toBe(true)
    })

    it('is not expired when a refresh token is present, even past expiresAt', async () => {
      const expiresAt = Date.now() - 60_000
      await fs.writeFile(
        credPath(),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-x',
            refreshToken: 'sk-ant-ort01-x',
            expiresAt,
            subscriptionType: 'pro',
          },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.loggedIn).toBe(true)
      expect(status.expired).toBe(false)
    })

    it('never returns the tokens themselves', async () => {
      await fs.writeFile(
        credPath(),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'sk-ant-oat01-secret', refreshToken: 'sk-ant-ort01-x' },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(JSON.stringify(status)).not.toContain('secret')
      expect(JSON.stringify(status)).not.toContain('ort01')
    })
  })

  describe('agent settings', () => {
    it('returns {} when aiSettings.json is absent', async () => {
      const configDir = join(dir, 'editor-settings')
      svc = new ClaudeConfigMainService(settingsPath, undefined, configLocation(configDir))
      expect(await svc.readAgentSettings()).toEqual({})
    })

    it('drops legacy non-string fields when reading', async () => {
      const configDir = join(dir, 'editor-settings')
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(
        join(configDir, 'aiSettings.json'),
        JSON.stringify({ agentSettings: { claude: { authentication: 'gw', model: 42 } } }),
        'utf8',
      )
      svc = new ClaudeConfigMainService(settingsPath, undefined, configLocation(configDir))
      expect(await svc.readAgentSettings()).toEqual({ authentication: 'gw' })
    })

    it('persists model1m: true but drops subagentModel1m: false', async () => {
      const configDir = join(dir, 'editor-settings')
      svc = new ClaudeConfigMainService(settingsPath, undefined, configLocation(configDir))
      await svc.writeAgentSettings({
        authentication: 'gw',
        model: 'kimi-k3',
        model1m: true,
        subagentModel: 'mini',
        subagentModel1m: false,
      })

      expect(await svc.readAgentSettings()).toEqual({
        authentication: 'gw',
        model: 'kimi-k3',
        model1m: true,
        subagentModel: 'mini',
      })
      const stored = JSON.parse(await fs.readFile(join(configDir, 'aiSettings.json'), 'utf8'))
      expect(stored.agentSettings.claude).toEqual({
        authentication: 'gw',
        model: 'kimi-k3',
        model1m: true,
        subagentModel: 'mini',
      })
      expect('subagentModel1m' in stored.agentSettings.claude).toBe(false)
    })

    it('replaces the whole agent block while preserving other top-level keys and agents', async () => {
      const configDir = join(dir, 'editor-settings')
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(
        join(configDir, 'aiSettings.json'),
        JSON.stringify({
          providers: [{ id: 'gw' }],
          agentSettings: {
            claude: { authentication: 'gw', model: 'opus' },
            codex: { model: 'gpt-5' },
          },
        }),
        'utf8',
      )
      svc = new ClaudeConfigMainService(settingsPath, undefined, configLocation(configDir))

      await svc.writeAgentSettings({ authentication: 'gw' })
      expect(await svc.readAgentSettings()).toEqual({ authentication: 'gw' })

      const stored = JSON.parse(await fs.readFile(join(configDir, 'aiSettings.json'), 'utf8'))
      expect(stored.providers).toEqual([{ id: 'gw' }])
      expect(stored.agentSettings.codex).toEqual({ model: 'gpt-5' })
      expect(stored.agentSettings.claude).toEqual({ authentication: 'gw' })
    })
  })
})

describe('ClaudeConfigMainService — remote checkGatewayConnectivity', () => {
  const dirs: string[] = []
  const svcs: ClaudeConfigMainService[] = []

  afterEach(async () => {
    for (const s of svcs) s.dispose()
    svcs.length = 0
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

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
    probeResult = true
    probeCalls = 0

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
      this.probeCalls++
      return Promise.resolve(this.probeResult)
    }
    codexMatchActiveApiKey(): Promise<number> {
      return Promise.resolve(-1)
    }
  }

  function makeRemoteService(remote: FakeRemoteAgentConfigService): {
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

  it('routes the probe through the remote AgentConfig channel when an authority is given', async () => {
    const remote = new FakeRemoteAgentConfigService()
    remote.probeResult = false
    const dir = await fs.mkdtemp(join(tmpdir(), 'claude-config-remote-'))
    dirs.push(dir)
    const { connService, proxyCalls } = makeRemoteService(remote)
    const svc = new ClaudeConfigMainService(
      join(dir, 'settings.json'),
      undefined,
      undefined,
      connService,
    )
    svcs.push(svc)

    expect(await svc.checkGatewayConnectivity('http://10.0.0.1:9080', 'host')).toBe(false)
    expect(remote.probeCalls).toBe(1)
    expect(proxyCalls).toEqual([{ authority: 'host', channel: RemoteChannels.AgentConfig }])
  })

  it('routes repeated remote reads through getServiceProxy with the AgentConfig channel', async () => {
    const remote = new FakeRemoteAgentConfigService()
    const dir = await fs.mkdtemp(join(tmpdir(), 'claude-config-remote-'))
    dirs.push(dir)
    const { connService, proxyCalls } = makeRemoteService(remote)
    const svc = new ClaudeConfigMainService(
      join(dir, 'settings.json'),
      undefined,
      undefined,
      connService,
    )
    svcs.push(svc)

    await svc.read('host')
    await svc.read('host')
    expect(proxyCalls).toEqual([
      { authority: 'host', channel: RemoteChannels.AgentConfig },
      { authority: 'host', channel: RemoteChannels.AgentConfig },
    ])
  })
})
