/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for CodexConfigMainService — TOML read fallbacks, merge/delete patch
 *  semantics, preservation of unmanaged keys, auth.json status derivation
 *  (ChatGPT vs API key, expiry, plan), and the separate credential library.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexConfigMainService } from '../codexConfigMainService.js'

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
      const idToken = makeJwt({
        exp,
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      })
      await fs.writeFile(
        authPath(),
        JSON.stringify({ tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt' } }),
        'utf8',
      )
      const status = await svc.readAuthStatus()
      expect(status.active).toBe('chatgpt')
      expect(status.hasApiKey).toBe(false)
      expect(status.chatgpt).toEqual({ expired: false, planType: 'plus', expiresAt: exp * 1000 })
    })

    it('flags an expired ChatGPT token', async () => {
      const exp = Math.floor(Date.now() / 1000) - 3600
      const idToken = makeJwt({ exp })
      await fs.writeFile(
        authPath(),
        JSON.stringify({ tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt' } }),
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
      const idToken = makeJwt({ exp, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'apikey',
          OPENAI_API_KEY: 'sk-test',
          tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt' },
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

  describe('setApiKey', () => {
    const authPath = () => join(dir, 'auth.json')
    const readAuth = async () =>
      JSON.parse(await fs.readFile(authPath(), 'utf8')) as Record<string, unknown>

    it('writes OPENAI_API_KEY into a fresh auth.json', async () => {
      await svc.setApiKey('sk-new')
      const auth = await readAuth()
      expect(auth['OPENAI_API_KEY']).toBe('sk-new')
      expect(auth['auth_mode']).toBe('apikey')
    })

    it('preserves an existing ChatGPT token block when setting a key', async () => {
      await fs.writeFile(authPath(), JSON.stringify({ tokens: { access_token: 'at' } }), 'utf8')
      await svc.setApiKey('sk-new')
      const auth = await readAuth()
      expect(auth['OPENAI_API_KEY']).toBe('sk-new')
      expect(auth['tokens']).toEqual({ access_token: 'at' })
      // Pin the mode so codex uses the key despite the leftover token block.
      expect(auth['auth_mode']).toBe('apikey')
    })

    it('removes OPENAI_API_KEY when cleared with null', async () => {
      await fs.writeFile(authPath(), JSON.stringify({ OPENAI_API_KEY: 'sk-old' }), 'utf8')
      await svc.setApiKey(null)
      const auth = await readAuth()
      expect('OPENAI_API_KEY' in auth).toBe(false)
      // No tokens remain, so there is no active credential to tag.
      expect('auth_mode' in auth).toBe(false)
    })

    it('hands control back to ChatGPT (auth_mode chatgpt) when clearing a key over tokens', async () => {
      await fs.writeFile(
        authPath(),
        JSON.stringify({
          auth_mode: 'apikey',
          OPENAI_API_KEY: 'sk-old',
          tokens: { access_token: 'at' },
        }),
        'utf8',
      )
      await svc.setApiKey(null)
      const auth = await readAuth()
      expect('OPENAI_API_KEY' in auth).toBe(false)
      expect(auth['auth_mode']).toBe('chatgpt')
      expect(auth['tokens']).toEqual({ access_token: 'at' })
    })
  })

  describe('credential profiles', () => {
    const profilesPath = () => join(dir, '.universe-editor', 'credential-profiles.json')

    it('returns [] when the library file is absent', async () => {
      expect(await svc.readProfiles()).toEqual([])
    })

    it('returns [] when the library file is malformed JSON', async () => {
      await fs.mkdir(join(dir, '.universe-editor'), { recursive: true })
      await fs.writeFile(profilesPath(), '{ not json', 'utf8')
      expect(await svc.readProfiles()).toEqual([])
    })

    it('writes and reads back profiles (creating the dir)', async () => {
      const profiles = [
        { id: 'a', label: 'Personal', kind: 'apiKey' as const, apiKey: 'sk-1' },
        {
          id: 'b',
          label: 'Compatible gateway',
          kind: 'gateway' as const,
          apiKey: 'sk-2',
          baseUrl: 'https://gw/v1',
        },
      ]
      await svc.writeProfiles(profiles)
      expect(await svc.readProfiles()).toEqual(profiles)
    })

    it('keeps the library separate from config.toml', async () => {
      await svc.writeProfiles([{ id: 'a', label: 'x', kind: 'apiKey', apiKey: 'sk-1' }])
      expect(await svc.read()).toEqual({})
    })
  })
})
