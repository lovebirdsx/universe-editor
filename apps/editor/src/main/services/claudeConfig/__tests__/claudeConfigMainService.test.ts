/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ClaudeConfigMainService — read fallbacks, deep-merge patch
 *  semantics, env key-by-key merge + delete, and preservation of unmanaged keys.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeConfigMainService } from '../claudeConfigMainService.js'

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

    it('flags an expired token', async () => {
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
          label: 'Work gateway',
          kind: 'gateway' as const,
          authToken: 'tok',
          baseUrl: 'https://gw',
        },
      ]
      await svc.writeProfiles(profiles)
      expect(await svc.readProfiles()).toEqual(profiles)
    })

    it('writes the library atomically (no leftover temp file)', async () => {
      await svc.writeProfiles([{ id: 'a', label: 'x', kind: 'apiKey', apiKey: 'sk-1' }])
      const entries = await fs.readdir(join(dir, '.universe-editor'))
      expect(entries).toEqual(['credential-profiles.json'])
    })

    it('keeps the library separate from settings.json', async () => {
      await svc.writeProfiles([{ id: 'a', label: 'x', kind: 'apiKey', apiKey: 'sk-1' }])
      expect(await svc.read()).toEqual({})
    })
  })
})
