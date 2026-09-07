/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for ClaudeMcpConfigStore — merged read of `~/.claude.json` +
 *  `~/.claude/settings.json` (claude.json wins by name), tolerant reads, and
 *  the directory-level config watch (same atomic-write rationale as
 *  claudeConfigStore.test.ts).
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeMcpConfigStore } from '../claudeMcpConfigStore.js'

const tempRoots: string[] = []
const stores: ClaudeMcpConfigStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

async function makeStore(): Promise<{
  store: ClaudeMcpConfigStore
  dir: string
  claudeJson: string
  settingsJson: string
  fired: () => number
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ue-claude-mcp-'))
  tempRoots.push(dir)
  const claudeJson = join(dir, '.claude.json')
  const settingsJson = join(dir, 'settings.json')
  const store = new ClaudeMcpConfigStore({ claudeJsonPath: claudeJson, settingsPath: settingsJson })
  stores.push(store)
  let count = 0
  store.onDidChange(() => {
    count++
  })
  await vi.waitFor(() => expect(store.watching).toBe(true))
  return { store, dir, claudeJson, settingsJson, fired: () => count }
}

/** Write like production does: temp file, then rename over the target. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.tmp`
  await writeFile(temp, contents, 'utf8')
  await rename(temp, path)
}

describe('ClaudeMcpConfigStore reads', () => {
  it('returns {} when both files are absent', async () => {
    const { store } = await makeStore()
    await expect(store.readMcpServers()).resolves.toEqual({})
  })

  it('reads mcpServers from ~/.claude.json', async () => {
    const { store, claudeJson } = await makeStore()
    await writeAtomic(
      claudeJson,
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'srv'] } } }),
    )
    await expect(store.readMcpServers()).resolves.toEqual({
      fs: { command: 'npx', args: ['-y', 'srv'] },
    })
  })

  it('reads mcpServers from settings.json', async () => {
    const { store, settingsJson } = await makeStore()
    await writeAtomic(
      settingsJson,
      JSON.stringify({ mcpServers: { docs: { url: 'http://192.0.2.10/mcp' } } }),
    )
    await expect(store.readMcpServers()).resolves.toEqual({
      docs: { url: 'http://192.0.2.10/mcp' },
    })
  })

  it('merges both files with ~/.claude.json winning by name', async () => {
    const { store, claudeJson, settingsJson } = await makeStore()
    await writeAtomic(
      settingsJson,
      JSON.stringify({
        mcpServers: { a: { command: 'from-settings' }, b: { command: 'only-settings' } },
      }),
    )
    await writeAtomic(
      claudeJson,
      JSON.stringify({ mcpServers: { a: { command: 'from-claude-json' } } }),
    )
    await expect(store.readMcpServers()).resolves.toEqual({
      a: { command: 'from-claude-json' },
      b: { command: 'only-settings' },
    })
  })

  it('ignores files without an object mcpServers key', async () => {
    const { store, claudeJson } = await makeStore()
    await writeAtomic(claudeJson, JSON.stringify({ mcpServers: ['not', 'an', 'object'] }))
    await expect(store.readMcpServers()).resolves.toEqual({})
  })

  it('returns {} for malformed JSON instead of throwing', async () => {
    const { store, claudeJson } = await makeStore()
    await writeAtomic(claudeJson, '{ not json')
    await expect(store.readMcpServers()).resolves.toEqual({})
  })
})

describe('ClaudeMcpConfigStore config watch', () => {
  it('sees an atomic write of ~/.claude.json', async () => {
    const { claudeJson, fired } = await makeStore()
    await writeAtomic(claudeJson, JSON.stringify({ mcpServers: {} }))
    await vi.waitFor(() => expect(fired()).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('sees an atomic write of settings.json', async () => {
    const { settingsJson, fired } = await makeStore()
    await writeAtomic(settingsJson, JSON.stringify({ mcpServers: {} }))
    await vi.waitFor(() => expect(fired()).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('coalesces a burst of writes into one event', async () => {
    const { claudeJson, fired } = await makeStore()
    for (let i = 0; i < 5; i++) await writeAtomic(claudeJson, JSON.stringify({ v: i }))
    await vi.waitFor(() => expect(fired()).toBe(1), { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fired()).toBe(1)
  })

  it('ignores files it does not manage', async () => {
    const { dir, fired } = await makeStore()
    await writeAtomic(join(dir, 'unrelated.json'), 'noise')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fired()).toBe(0)
  })

  it('stops firing after dispose', async () => {
    const { store, claudeJson, fired } = await makeStore()
    store.dispose()
    await writeAtomic(claudeJson, JSON.stringify({ mcpServers: {} }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fired()).toBe(0)
  })
})
