/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for ClaudeConfigStore's config watch.
 *
 *  The load-bearing rule: the watch must be directory-level. Both the editor and
 *  the Claude CLI write settings.json atomically (temp file + rename), which
 *  replaces the inode — a file-level watch stops seeing the file it was given and
 *  goes silent forever. These tests write the way production writes (rename) so a
 *  regression to a file-level watch fails here rather than in the field.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeConfigStore } from '../claudeConfigStore.js'

const tempRoots: string[] = []
const stores: ClaudeConfigStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

async function makeStore(): Promise<{
  store: ClaudeConfigStore
  dir: string
  fired: () => number
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ue-claude-config-'))
  tempRoots.push(dir)
  const store = new ClaudeConfigStore({ settingsPath: join(dir, 'settings.json') })
  stores.push(store)
  let count = 0
  store.onDidChangeConfig(() => {
    count++
  })
  // The watch is armed after an async mkdir; give it a turn to attach.
  await vi.waitFor(() => expect(store.watching).toBe(true))
  return { store, dir, fired: () => count }
}

/** Write like production does: temp file, then rename over the target. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.tmp`
  await writeFile(temp, contents, 'utf8')
  await rename(temp, path)
}

describe('ClaudeConfigStore config watch', () => {
  it('sees an atomic (temp + rename) write of settings.json', async () => {
    const { dir, fired } = await makeStore()
    await writeAtomic(join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }))
    await vi.waitFor(() => expect(fired()).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('sees a change to .credentials.json', async () => {
    const { dir, fired } = await makeStore()
    await writeAtomic(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }))
    await vi.waitFor(() => expect(fired()).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('coalesces a burst of writes into one event', async () => {
    const { dir, fired } = await makeStore()
    const path = join(dir, 'settings.json')
    for (let i = 0; i < 5; i++) await writeAtomic(path, JSON.stringify({ model: `m${i}` }))
    await vi.waitFor(() => expect(fired()).toBe(1), { timeout: 3000 })
    // Hold past the debounce window to prove nothing trails in late.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fired()).toBe(1)
  })

  it('ignores files it does not manage', async () => {
    const { dir, fired } = await makeStore()
    await writeAtomic(join(dir, 'history.jsonl'), 'noise')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fired()).toBe(0)
  })

  it('stops firing after dispose', async () => {
    const { store, dir, fired } = await makeStore()
    store.dispose()
    await writeAtomic(join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fired()).toBe(0)
  })

  it('degrades silently when the directory cannot be watched', async () => {
    // A path under a file (not a directory) can never be watched.
    const dir = await mkdtemp(join(tmpdir(), 'ue-claude-config-'))
    tempRoots.push(dir)
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    const store = new ClaudeConfigStore({ settingsPath: join(blocker, 'nested', 'settings.json') })
    stores.push(store)
    await expect(store.read()).resolves.toEqual({})
    expect(store.watching).toBe(false)
  })
})
