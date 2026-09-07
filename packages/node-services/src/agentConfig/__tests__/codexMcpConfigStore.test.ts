/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for CodexMcpConfigStore — `[mcp_servers]` TOML reads (user file
 *  watched, project file read per cwd), tolerant degradation, and the
 *  directory-level config watch.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexMcpConfigStore, codexMcpProjectConfigPath } from '../codexMcpConfigStore.js'

const tempRoots: string[] = []
const stores: CodexMcpConfigStore[] = []

afterEach(async () => {
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
  const dir = await mkdtemp(join(tmpdir(), 'ue-codex-mcp-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'ue-codex-mcp-proj-'))
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
