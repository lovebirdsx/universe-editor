/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for CodexMcpConfigStore — `[mcp_servers]` TOML reads (user file
 *  watched, project file read per cwd), tolerant degradation, and the
 *  directory-level config watch.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexMcpConfigStore,
  codexMcpProjectConfigPath,
  translateCodexMcpServers,
} from '../codexMcpConfigStore.js'
import { mkTempDir } from '@universe-editor/temp-root'

const tempRoots: string[] = []
const stores: CodexMcpConfigStore[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of stores.splice(0)) store.dispose()
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

async function makeStore(): Promise<{
  store: CodexMcpConfigStore
  dir: string
  userConfig: string
  fired: () => number
}> {
  const dir = mkTempDir('ue-codex-mcp-')
  tempRoots.push(dir)
  const userConfig = join(dir, 'config.toml')
  const store = new CodexMcpConfigStore({ userConfigPath: userConfig })
  stores.push(store)
  let count = 0
  store.onDidChange(() => {
    count++
  })
  await vi.waitFor(() => expect(store.watching).toBe(true))
  return { store, dir, userConfig, fired: () => count }
}

/** Write like production does: temp file, then rename over the target. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.tmp`
  await writeFile(temp, contents, 'utf8')
  await rename(temp, path)
}

const SAMPLE_TOML = [
  '[mcp_servers.fs]',
  'command = "npx"',
  'args = ["-y", "@acme/server-filesystem", "."]',
  '',
  '[mcp_servers.fs.env]',
  'FOO = "bar"',
  '',
  '[mcp_servers.docs]',
  'command = "docs-server"',
].join('\n')

describe('CodexMcpConfigStore reads', () => {
  it('returns {} when the user file is absent', async () => {
    const { store } = await makeStore()
    await expect(store.readUserMcpServers()).resolves.toEqual({})
  })

  it('parses [mcp_servers] from the user config.toml', async () => {
    const { store, userConfig } = await makeStore()
    await writeAtomic(userConfig, SAMPLE_TOML)
    await expect(store.readUserMcpServers()).resolves.toEqual({
      fs: { command: 'npx', args: ['-y', '@acme/server-filesystem', '.'], env: { FOO: 'bar' } },
      docs: { command: 'docs-server' },
    })
  })

  it('returns {} when the file has no [mcp_servers] table', async () => {
    const { store, userConfig } = await makeStore()
    await writeAtomic(userConfig, 'model = "acme-chat-pro"\n')
    await expect(store.readUserMcpServers()).resolves.toEqual({})
  })

  it('returns {} for malformed TOML instead of throwing', async () => {
    const { store, userConfig } = await makeStore()
    await writeAtomic(userConfig, '[mcp_servers\nbroken =')
    await expect(store.readUserMcpServers()).resolves.toEqual({})
  })

  it('reads the project-level file from <cwd>/.codex/config.toml', async () => {
    const { store } = await makeStore()
    const cwd = mkTempDir('ue-codex-mcp-proj-')
    tempRoots.push(cwd)
    await mkdir(join(cwd, '.codex'), { recursive: true })
    await writeAtomic(codexMcpProjectConfigPath(cwd), '[mcp_servers.proj]\ncommand = "proj-srv"\n')
    await expect(store.readProjectMcpServers(cwd)).resolves.toEqual({
      proj: { command: 'proj-srv' },
    })
    // The project read must not leak into the user read.
    await expect(store.readUserMcpServers()).resolves.toEqual({})
  })

  it('returns {} for a project read when the file is absent', async () => {
    const { store, dir } = await makeStore()
    await expect(store.readProjectMcpServers(dir)).resolves.toEqual({})
  })

  it('translates codex http entries into the editor shape on read', async () => {
    const { store, userConfig } = await makeStore()
    vi.stubEnv('TXD_TOKEN', 'secret-token')
    await writeAtomic(
      userConfig,
      [
        '[mcp_servers.txd]',
        'url = "http://192.0.2.10:18092/mcp"',
        'bearer_token_env_var = "TXD_TOKEN"',
        'http_headers = { "X-Example" = "value" }',
        '',
        '[mcp_servers.fs]',
        'command = "npx"',
        'args = ["-y", "@acme/server-filesystem", "."]',
      ].join('\n'),
    )
    await expect(store.readUserMcpServers()).resolves.toEqual({
      txd: {
        type: 'http',
        url: 'http://192.0.2.10:18092/mcp',
        headers: { 'X-Example': 'value', Authorization: 'Bearer secret-token' },
      },
      fs: { command: 'npx', args: ['-y', '@acme/server-filesystem', '.'] },
    })
  })

  it('translates codex http entries in the project file too', async () => {
    const { store } = await makeStore()
    const cwd = mkTempDir('ue-codex-mcp-proj-http-')
    tempRoots.push(cwd)
    await mkdir(join(cwd, '.codex'), { recursive: true })
    await writeAtomic(
      codexMcpProjectConfigPath(cwd),
      '[mcp_servers.proj]\nurl = "http://mcp.example.com/sse"\n',
    )
    await expect(store.readProjectMcpServers(cwd)).resolves.toEqual({
      proj: { type: 'http', url: 'http://mcp.example.com/sse', headers: {} },
    })
  })
})

describe('translateCodexMcpServers', () => {
  it('translates a codex http entry and drops codex-only fields', () => {
    expect(
      translateCodexMcpServers(
        {
          txd: {
            url: 'http://192.0.2.10:18092/mcp',
            bearer_token_env_var: 'TXD_TOKEN',
            http_headers: { 'X-Example': 'value' },
            enabled: false,
            oauth_client_id: 'client',
          },
        },
        { TXD_TOKEN: 'secret' },
      ),
    ).toEqual({
      txd: {
        type: 'http',
        url: 'http://192.0.2.10:18092/mcp',
        headers: { 'X-Example': 'value', Authorization: 'Bearer secret' },
      },
    })
  })

  it('adds no Authorization when the bearer env var is unset or empty', () => {
    const servers = { txd: { url: 'http://192.0.2.10:18092/mcp', bearer_token_env_var: 'MISSING' } }
    expect(translateCodexMcpServers(servers, {})).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: {} },
    })
    expect(translateCodexMcpServers(servers, { MISSING: '' })).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: {} },
    })
  })

  it('lets a static Authorization header win over the env-derived one', () => {
    const servers = {
      txd: {
        url: 'http://192.0.2.10:18092/mcp',
        bearer_token_env_var: 'TXD_TOKEN',
        http_headers: { authorization: 'Bearer static' },
      },
    }
    expect(translateCodexMcpServers(servers, { TXD_TOKEN: 'secret' })).toEqual({
      txd: {
        type: 'http',
        url: 'http://192.0.2.10:18092/mcp',
        headers: { authorization: 'Bearer static' },
      },
    })
  })

  it('keeps only string header values', () => {
    expect(
      translateCodexMcpServers({
        txd: { url: 'http://192.0.2.10:18092/mcp', http_headers: { 'X-Num': 5, 'X-Str': 'ok' } },
      }),
    ).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: { 'X-Str': 'ok' } },
    })
  })

  it('passes stdio entries through untouched', () => {
    const fs = { command: 'npx', args: ['-y', '@acme/server-filesystem'], env: { FOO: 'bar' } }
    expect(translateCodexMcpServers({ fs })).toEqual({ fs })
  })

  it('passes editor-shaped entries (with a type field) through untouched', () => {
    const docs = { type: 'http', url: 'http://mcp.example.com/sse', headers: { A: 'b' } }
    expect(translateCodexMcpServers({ docs })).toEqual({ docs })
  })

  it('lets command win over url when both are present', () => {
    const mixed = { command: 'npx', url: 'http://192.0.2.10:18092/mcp' }
    expect(translateCodexMcpServers({ mixed })).toEqual({ mixed })
  })

  it('passes non-string or empty urls through untouched', () => {
    const servers = { a: { url: 42 }, b: { url: '' } }
    expect(translateCodexMcpServers(servers)).toEqual(servers)
  })

  it('passes scalar entries through untouched', () => {
    const servers = { foo: 'bar' }
    expect(translateCodexMcpServers(servers)).toEqual(servers)
  })

  it('resolves env_http_headers values from env and skips unset vars', () => {
    const servers = {
      txd: {
        url: 'http://192.0.2.10:18092/mcp',
        env_http_headers: { 'X-Api-Key': 'API_KEY', 'X-Missing': 'MISSING' },
      },
    }
    expect(translateCodexMcpServers(servers, { API_KEY: 'k-1' })).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: { 'X-Api-Key': 'k-1' } },
    })
  })

  it('lets http_headers win over the editor-style headers field', () => {
    const servers = {
      txd: {
        url: 'http://192.0.2.10:18092/mcp',
        headers: { X: 'editor' },
        http_headers: { X: 'static' },
      },
    }
    expect(translateCodexMcpServers(servers)).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: { X: 'static' } },
    })
  })

  it('ignores http_headers when it is an array', () => {
    expect(
      translateCodexMcpServers({
        txd: { url: 'http://192.0.2.10:18092/mcp', http_headers: [{ X: 'y' }] },
      }),
    ).toEqual({ txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: {} } })
  })

  it('ignores a non-string bearer_token_env_var', () => {
    const servers = { txd: { url: 'http://192.0.2.10:18092/mcp', bearer_token_env_var: 5 } }
    expect(translateCodexMcpServers(servers)).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: {} },
    })
  })

  it('lets an uppercase static AUTHORIZATION header win too', () => {
    const servers = {
      txd: {
        url: 'http://192.0.2.10:18092/mcp',
        bearer_token_env_var: 'TXD_TOKEN',
        http_headers: { AUTHORIZATION: 'Bearer static' },
      },
    }
    expect(translateCodexMcpServers(servers, { TXD_TOKEN: 'secret' })).toEqual({
      txd: {
        type: 'http',
        url: 'http://192.0.2.10:18092/mcp',
        headers: { AUTHORIZATION: 'Bearer static' },
      },
    })
  })

  it('translates a url entry with an empty command', () => {
    const servers = { txd: { command: '', url: 'http://192.0.2.10:18092/mcp' } }
    expect(translateCodexMcpServers(servers)).toEqual({
      txd: { type: 'http', url: 'http://192.0.2.10:18092/mcp', headers: {} },
    })
  })

  it('passes array and null entries through untouched', () => {
    const servers = { arr: [{ command: 'npx' }], nul: null }
    expect(translateCodexMcpServers(servers)).toEqual(servers)
  })

  it('does not mutate the input', () => {
    const input = {
      txd: {
        url: 'http://192.0.2.10:18092/mcp',
        bearer_token_env_var: 'TXD_TOKEN',
        http_headers: { 'X-Example': 'value' },
      },
    }
    const snapshot = structuredClone(input)
    translateCodexMcpServers(input, { TXD_TOKEN: 'secret' })
    expect(input).toEqual(snapshot)
  })
})

describe('CodexMcpConfigStore config watch', () => {
  it('sees an atomic write of the user config.toml', async () => {
    const { userConfig, fired } = await makeStore()
    await writeAtomic(userConfig, SAMPLE_TOML)
    await vi.waitFor(() => expect(fired()).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('coalesces a burst of writes into one event', async () => {
    const { userConfig, fired } = await makeStore()
    for (let i = 0; i < 5; i++) await writeAtomic(userConfig, `model = "m${i}"\n`)
    await vi.waitFor(() => expect(fired()).toBe(1), { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fired()).toBe(1)
  })

  it('ignores files it does not manage', async () => {
    const { dir, fired } = await makeStore()
    await writeAtomic(join(dir, 'auth.json'), '{}')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fired()).toBe(0)
  })

  it('stops firing after dispose', async () => {
    const { store, userConfig, fired } = await makeStore()
    store.dispose()
    await writeAtomic(userConfig, SAMPLE_TOML)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fired()).toBe(0)
  })
})
