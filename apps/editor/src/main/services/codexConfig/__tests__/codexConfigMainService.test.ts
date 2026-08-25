/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for CodexConfigMainService — TOML read fallbacks, merge/delete patch
 *  semantics, preservation of unmanaged keys, auth.json status derivation
 *  (ChatGPT vs API key, expiry, plan), the separate credential library, and
 *  `resolveActiveAuth` reverse-lookup against the configured provider entries.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
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
import { CodexConfigMainService } from '../codexConfigMainService.js'
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

/** Build an unsigned JWT whose payload carries the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

describe('CodexConfigMainService', () => {
  let dir: string
  let configPath: string
  let svc: CodexConfigMainService

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'codex-config-'))
    configPath = join(dir, 'config.toml')
    svc = new CodexConfigMainService(configPath)
  })

  afterEach(async () => {
    svc.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeToml(text: string): Promise<void> {
    await fs.writeFile(configPath, text, 'utf8')
  }

  async function readToml(): Promise<Record<string, unknown>> {
    return parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
  }

  it('returns {} when the file is absent', async () => {
    expect(await svc.read()).toEqual({})
  })

  it('returns {} when the file is malformed TOML', async () => {
    await writeToml('this = = = not toml')
    expect(await svc.read()).toEqual({})
  })

  it('reads back an existing file', async () => {
    await writeToml('model = "gpt-5.5"\nsandbox_mode = "workspace-write"\n')
    expect(await svc.read()).toEqual({ model: 'gpt-5.5', sandbox_mode: 'workspace-write' })
  })

  it('creates the file (and dir) on first patch', async () => {
    const nested = new CodexConfigMainService(join(dir, 'sub', 'config.toml'))
    await nested.patch({ model: 'gpt-5.5' })
    expect(await nested.read()).toEqual({ model: 'gpt-5.5' })
  })

  it('merges top-level keys and preserves unmanaged keys', async () => {
    await writeToml('model = "gpt-5.5"\ncustom_key = "keep"\n')
    await svc.patch({ approval_policy: 'on-request' })
    expect(await readToml()).toEqual({
      model: 'gpt-5.5',
      approval_policy: 'on-request',
      custom_key: 'keep',
    })
  })

  it('deletes a top-level key when patched with null', async () => {
    await writeToml('model = "gpt-5.5"\nopenai_base_url = "https://x"\n')
    await svc.patch({ openai_base_url: null })
    expect(await readToml()).toEqual({ model: 'gpt-5.5' })
  })

  it('writes atomically (no leftover temp file)', async () => {
    await svc.patch({ model: 'gpt-5.5' })
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['config.toml'])
  })

  describe('applyCredential', () => {
    const authPath = () => join(dir, 'auth.json')
    const readAuth = async () =>
      JSON.parse(await fs.readFile(authPath(), 'utf8')) as Record<string, unknown>
    const writeChatgptTokens = () => {
      const idToken = makeJwt({})
      const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      return fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'rt' },
        }),
      )
    }

    it('writes a self-contained gateway provider carrying its own bearer token', async () => {
      await writeToml('model = "gpt-5.4"\n')
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'sk-gw',
        providerName: 'My Gateway',
      })
      const cfg = await readToml()
      expect(cfg['model_provider']).toBe('codex-gateway')
      expect(cfg['model']).toBe('gpt-5.4')
      // Never sets the global redirect that would also hijack the built-in openai.
      expect(cfg['openai_base_url']).toBeUndefined()
      const providers = cfg['model_providers'] as Record<string, Record<string, unknown>>
      expect(providers['codex-gateway']).toEqual({
        name: 'My Gateway',
        base_url: 'https://gw.example.com',
        wire_api: 'responses',
        supports_websockets: false,
        experimental_bearer_token: 'sk-gw',
      })
    })

    it('does not touch a ChatGPT token block when applying a gateway', async () => {
      await writeChatgptTokens()
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'sk-gw',
      })
      const auth = await readAuth()
      // ChatGPT tokens survive (just unused); no OPENAI_API_KEY is written.
      expect(auth['tokens']).toBeDefined()
      expect('OPENAI_API_KEY' in auth).toBe(false)
    })

    it('updates the gateway base_url + token when the profile changes', async () => {
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://old.example.com',
        apiKey: 'sk-1',
      })
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://new.example.com',
        apiKey: 'sk-2',
      })
      const providers = (await readToml())['model_providers'] as Record<
        string,
        Record<string, unknown>
      >
      expect(providers['codex-gateway']!['base_url']).toBe('https://new.example.com')
      expect(providers['codex-gateway']!['experimental_bearer_token']).toBe('sk-2')
    })

    it('is a no-op (no rewrite) when the gateway is already in sync', async () => {
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'sk-gw',
      })
      const before = await fs.stat(configPath)
      await new Promise((r) => setTimeout(r, 10))
      // Re-running reconcile alone (no auth change) must not rewrite config.toml.
      const current = await svc.read()
      const next = await svc.read()
      expect(next).toEqual(current)
      const after = await fs.stat(configPath)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    })

    it('writes the API key into auth.json and tears the gateway down for apiKey intent', async () => {
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'sk-gw',
      })
      await svc.applyCredential({ kind: 'apiKey', apiKey: 'sk-official' })
      const auth = await readAuth()
      expect(auth['OPENAI_API_KEY']).toBe('sk-official')
      expect(auth['auth_mode']).toBe('apikey')
      const cfg = await readToml()
      expect(cfg['model_provider']).toBeUndefined()
      expect(cfg['model_providers']).toBeUndefined()
    })

    it('hands control back to ChatGPT: clears key + gateway, keeps tokens', async () => {
      await writeChatgptTokens()
      await svc.applyCredential({ kind: 'apiKey', apiKey: 'sk-official' })
      await svc.applyCredential({ kind: 'chatgpt' })
      const auth = await readAuth()
      expect('OPENAI_API_KEY' in auth).toBe(false)
      expect(auth['auth_mode']).toBe('chatgpt')
      expect(auth['tokens']).toBeDefined()
    })

    it('clears a stale top-level openai_base_url left by an older version', async () => {
      // Reproduces the reported bug: a lingering openai_base_url would redirect
      // the built-in openai provider, breaking a ChatGPT login.
      await writeChatgptTokens()
      await writeToml('openai_base_url = "https://gw.example.com"\nmodel = "gpt-5.5"\n')
      await svc.applyCredential({ kind: 'chatgpt' })
      const cfg = await readToml()
      expect(cfg['openai_base_url']).toBeUndefined()
      expect(cfg['model']).toBe('gpt-5.5')
    })

    it('preserves a user-defined custom provider while tearing down', async () => {
      await writeToml(
        '[model_providers.mine]\nname = "mine"\nbase_url = "https://mine.example.com"\n',
      )
      await svc.applyCredential({
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'sk-gw',
      })
      await svc.applyCredential({ kind: 'chatgpt' })
      const providers = (await readToml())['model_providers'] as Record<string, unknown>
      expect(providers['mine']).toBeDefined()
      expect(providers['codex-gateway']).toBeUndefined()
    })
  })

  describe('readAuthStatus', () => {
    const authPath = () => join(dir, 'auth.json')

    it('returns logged-out when auth.json is absent', async () => {
      expect(await svc.readAuthStatus()).toEqual({ active: 'none', hasApiKey: false })
    })

    it('returns logged-out when auth.json is malformed JSON', async () => {
      await fs.writeFile(authPath(), '{ not json', 'utf8')
      expect(await svc.readAuthStatus()).toEqual({ active: 'none', hasApiKey: false })
    })

    it('reports API-key auth (no ChatGPT block)', async () => {
      await fs.writeFile(authPath(), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }), 'utf8')
      expect(await svc.readAuthStatus()).toEqual({ active: 'apiKey', hasApiKey: true })
    })

    it('reports a valid ChatGPT login with plan and expiry', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600
      const idToken = makeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })
      const accessToken = makeJwt({ exp })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'rt' },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.active).toBe('chatgpt')
      expect(status.hasApiKey).toBe(false)
      expect(status.chatgpt).toEqual({ expired: false, planType: 'plus', expiresAt: exp * 1000 })
    })

    it('stays signed in when only the short-lived id_token is expired', async () => {
      // Regression: the id_token lives ≈1h and expires constantly; the session is
      // governed by the access token. Judging expiry by id_token falsely reported
      // "Login expired" while `codex /status` showed a live login.
      const idToken = makeJwt({
        exp: Math.floor(Date.now() / 1000) - 1800,
        'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
      })
      const accessExp = Math.floor(Date.now() / 1000) + 86400
      const accessToken = makeJwt({ exp: accessExp })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'rt' },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.active).toBe('chatgpt')
      expect(status.chatgpt).toEqual({
        expired: false,
        planType: 'pro',
        expiresAt: accessExp * 1000,
      })
    })

    it('is not expired when the access token is stale but a refresh token exists', async () => {
      // codex transparently refreshes on a 401, so a past-exp access token with a
      // refresh token is still a usable login.
      const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 })
      await fs.writeFile(
        authPath(),
        JSON.stringify({ tokens: { access_token: accessToken, refresh_token: 'rt' } }),
        'utf8',
      )
      expect((await svc.readAuthStatus()).chatgpt?.expired).toBe(false)
    })

    it('flags an expired ChatGPT token', async () => {
      // Access token past exp AND no refresh token → genuinely expired.
      const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 })
      await fs.writeFile(
        authPath(),
        JSON.stringify({ tokens: { id_token: makeJwt({}), access_token: accessToken } }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.active).toBe('chatgpt')
      expect(status.chatgpt?.expired).toBe(true)
    })

    it('never returns the credentials themselves', async () => {
      const idToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          OPENAI_API_KEY: 'sk-secret',
          tokens: { id_token: idToken, access_token: 'at-secret', refresh_token: 'rt-secret' },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      const serialized = JSON.stringify(status)
      expect(serialized).not.toContain('secret')
      expect(serialized).not.toContain(idToken)
    })

    it('keeps ChatGPT login visible while an API key takes precedence', async () => {
      // Problem 2: applying an API key must NOT look like a logout. The ChatGPT
      // block is still reported (so the panel shows "Signed in"), but `active`
      // reflects the API key codex actually uses.
      const exp = Math.floor(Date.now() / 1000) + 3600
      const idToken = makeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })
      const accessToken = makeJwt({ exp })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'apikey',
          OPENAI_API_KEY: 'sk-test',
          tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'rt' },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.active).toBe('apiKey')
      expect(status.hasApiKey).toBe(true)
      expect(status.chatgpt).toEqual({ expired: false, planType: 'pro', expiresAt: exp * 1000 })
    })

    it('honours an explicit auth_mode "chatgpt" over field presence', async () => {
      // codex login writes BOTH an OPENAI_API_KEY and a tokens block, tagged
      // auth_mode "chatgpt". active must be chatgpt, mirroring resolved_mode().
      const idToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: 'sk-from-token-exchange',
          tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt' },
        }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.active).toBe('chatgpt')
      expect(status.hasApiKey).toBe(true)
    })

    it('prefers OPENAI_API_KEY over a tokens block when auth_mode is absent', async () => {
      // Mirrors resolved_mode(): without an explicit mode, the API key wins.
      const idToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          OPENAI_API_KEY: 'sk-test',
          tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt' },
        }),
        'utf8',
      )
      expect((await svc.readAuthStatus()).active).toBe('apiKey')
    })
  })

  describe('onDidChangeAuth', () => {
    const authPath = () => join(dir, 'auth.json')

    it('fires when auth.json is written', async () => {
      const fired = new Promise<void>((resolve) => {
        const sub = svc.onDidChangeAuth(() => {
          sub.dispose()
          resolve()
        })
      })
      // Give the directory watcher a beat to attach, then touch auth.json.
      await new Promise((r) => setTimeout(r, 50))
      await fs.writeFile(authPath(), JSON.stringify({ OPENAI_API_KEY: 'sk-1' }), 'utf8')
      await expect(
        Promise.race([
          fired,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]),
      ).resolves.toBeUndefined()
    })
  })

  describe('resolveActiveAuth', () => {
    const authPath = () => join(dir, 'auth.json')

    async function writeChatgpt(): Promise<void> {
      const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { id_token: makeJwt({}), access_token: accessToken, refresh_token: 'rt' },
        }),
        'utf8',
      )
    }

    /** Swap `svc` for a configLocation-backed instance whose aiSettings.json holds the given providers. */
    async function useAiSettings(providers: unknown[]): Promise<void> {
      const configDir = join(dir, 'editor-settings')
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(join(configDir, 'aiSettings.json'), JSON.stringify({ providers }), 'utf8')
      svc.dispose()
      svc = new CodexConfigMainService(configPath, undefined, configLocation(configDir))
    }

    const gatewayProviders = [
      {
        id: 'kuro-a',
        apiKey: 'kuro-b2',
        baseUrl: 'http://gw:9080/',
        protocolMap: { 'openai-responses': [] },
      },
      {
        id: 'kuro-b',
        apiKey: 'kuro-5a',
        baseUrl: 'http://gw:9080/',
        protocolMap: { 'openai-responses': [] },
      },
    ]

    it('reports the matching provider when a gateway is in effect', async () => {
      await useAiSettings(gatewayProviders)
      await writeToml(
        'model_provider = "codex-gateway"\n[model_providers.codex-gateway]\nbase_url = "http://gw:9080/"\nexperimental_bearer_token = "kuro-5a"\n',
      )
      expect(await svc.resolveActiveAuth()).toEqual({ kind: 'provider', providerId: 'kuro-b' })
    })

    it('distinguishes same-URL providers by their bearer token', async () => {
      await useAiSettings(gatewayProviders)
      await writeToml(
        'model_provider = "codex-gateway"\n[model_providers.codex-gateway]\nbase_url = "http://gw:9080/"\nexperimental_bearer_token = "kuro-5a"\n',
      )
      expect((await svc.resolveActiveAuth()).providerId).toBe('kuro-b')
    })

    it('resolves a hand-written model_provider name to its matching provider', async () => {
      await useAiSettings(gatewayProviders)
      await writeToml(
        'model_provider = "kuro"\n[model_providers.kuro]\nbase_url = "http://gw:9080/"\nexperimental_bearer_token = "kuro-5a"\n',
      )
      expect(await svc.resolveActiveAuth()).toEqual({ kind: 'provider', providerId: 'kuro-b' })
    })

    it('leaves a hand-written gateway that matches no entry unattributed', async () => {
      await useAiSettings([])
      await writeToml(
        'model_provider = "codex-gateway"\n[model_providers.codex-gateway]\nbase_url = "http://gw:9080/"\nexperimental_bearer_token = "kuro-5a"\n',
      )
      expect(await svc.resolveActiveAuth()).toEqual({ kind: 'provider' })
    })

    it('reports the ChatGPT subscription when it is in effect', async () => {
      await useAiSettings([])
      await writeChatgpt()
      expect(await svc.resolveActiveAuth()).toEqual({ kind: 'subscription' })
    })

    it('reports none when the ChatGPT login is not active', async () => {
      await useAiSettings([])
      await writeToml('model = "gpt-5.5"\n')
      expect(await svc.resolveActiveAuth()).toEqual({ kind: 'none' })
    })
  })
})

describe('CodexConfigMainService — remote resolveActiveAuth', () => {
  const dirs: string[] = []
  const svcs: CodexConfigMainService[] = []

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
    private readonly _authEmitter = new Emitter<void>()
    authSubscriptions = 0
    onDidChangeCodexAuth: Event<void> = (listener, thisArgs?, disposables?) => {
      this.authSubscriptions++
      return this._authEmitter.event(listener, thisArgs, disposables)
    }
    readonly onDidChangeClaudeConfig: Event<void> = Event.None
    codexSettings: CodexSettings = {}
    codexAuthStatus: CodexAuthStatus = { active: 'none', hasApiKey: false }

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
      return Promise.resolve(this.codexSettings)
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
      return Promise.resolve(this.codexAuthStatus)
    }
    checkGatewayConnectivity(): Promise<boolean> {
      return Promise.resolve(true)
    }
    codexMatchActiveApiKey(): Promise<number> {
      return Promise.resolve(-1)
    }
  }

  async function makeRemoteService(remote: FakeRemoteAgentConfigService): Promise<{
    svc: CodexConfigMainService
    proxyCalls: Array<{ authority: string; channel: string }>
    configDir: string
  }> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'codex-config-remote-'))
    dirs.push(dir)
    const proxyCalls: Array<{ authority: string; channel: string }> = []
    const configDir = join(dir, 'editor-settings')
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
    const svc = new CodexConfigMainService(
      join(dir, 'config.toml'),
      undefined,
      configLocation(configDir),
      connService,
    )
    svcs.push(svc)
    return { svc, proxyCalls, configDir }
  }

  async function writeLocalProviders(configDir: string, providers: unknown[]): Promise<void> {
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(join(configDir, 'aiSettings.json'), JSON.stringify({ providers }), 'utf8')
  }

  const gatewayProviders = [
    {
      id: 'kuro-a',
      apiKey: 'kuro-b2',
      baseUrl: 'http://gw:9080/',
      protocolMap: { 'openai-responses': [] },
    },
    {
      id: 'kuro-b',
      apiKey: 'kuro-5a',
      baseUrl: 'http://gw:9080/',
      protocolMap: { 'openai-responses': [] },
    },
  ]

  it('resolves a remote gateway to its provider id by baseUrl + bearer token', async () => {
    const remote = new FakeRemoteAgentConfigService()
    remote.codexSettings = {
      model_provider: 'codex-gateway',
      model_providers: {
        'codex-gateway': {
          base_url: 'http://gw:9080/',
          experimental_bearer_token: 'kuro-5a',
        },
      },
    }
    const { svc, configDir } = await makeRemoteService(remote)
    await writeLocalProviders(configDir, gatewayProviders)
    expect(await svc.resolveActiveAuth('host')).toEqual({ kind: 'provider', providerId: 'kuro-b' })
  })

  it('resolves a remote ChatGPT login to the subscription kind', async () => {
    const remote = new FakeRemoteAgentConfigService()
    remote.codexSettings = {}
    remote.codexAuthStatus = { active: 'chatgpt', hasApiKey: false }
    const { svc, configDir } = await makeRemoteService(remote)
    await writeLocalProviders(configDir, [])
    expect(await svc.resolveActiveAuth('host')).toEqual({ kind: 'subscription' })
  })

  it('subscribes to remote codex auth changes exactly once per authority', async () => {
    const remote = new FakeRemoteAgentConfigService()
    const { svc, proxyCalls } = await makeRemoteService(remote)
    await svc.read('host')
    await svc.read('host')
    expect(proxyCalls).toEqual([
      { authority: 'host', channel: RemoteChannels.AgentConfig },
      { authority: 'host', channel: RemoteChannels.AgentConfig },
    ])
    expect(remote.authSubscriptions).toBe(1)
  })
})
