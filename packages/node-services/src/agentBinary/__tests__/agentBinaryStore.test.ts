/*---------------------------------------------------------------------------------------------
 *  Tests for AgentBinaryStore's download semantics without touching the network:
 *  the allowDownload fast-fail, the `.active` pointer cache hit, and the
 *  cleanupStaleVersions dotfile/.extract. skip rules. The codex flavor is used
 *  because its bundled version is a constant (no claude-binary.json fixture).
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBinaryStore } from '../agentBinaryStore.js'
import { codexFlavor } from '../flavors.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'universe-editor-agent-store-'))
  tempDirs.push(dir)
  return dir
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('AgentBinaryStore', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it('fails fast on a cache miss when allowDownload is false, without touching the network', async () => {
    const dir = await makeTempDir()
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(store.resolveDownload(false)).rejects.toThrow(/not downloaded yet/)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('returns the `.active` version dir binary on a cache hit, without touching the network', async () => {
    const dir = await makeTempDir()
    const platform = codexFlavor.detectPlatform()
    const versionDir = path.join(dir, '0.9.9')
    const binary = codexFlavor.binaryIn(versionDir, platform)
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, 'MZ')
    await writeFile(path.join(dir, '.active'), '0.9.9', 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(store.resolveDownload(true)).resolves.toBe(binary)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('de-dupes concurrent resolveDownload calls while in flight, then drops the settled promise', async () => {
    const dir = await makeTempDir()
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      // Both cache-miss fast-fails run concurrently and must share one promise
      // (same underlying work), proven by object identity.
      const first = store.resolveDownload(false)
      const second = store.resolveDownload(false)
      expect(second).toBe(first)
      await expect(first).rejects.toThrow(/not downloaded yet/)

      // A download-allowed caller never shares the fast-fail promise.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
      const download = store.resolveDownload(true)
      expect(download).not.toBe(first)
      await expect(download).rejects.toThrow()
      expect(fetchSpy).toHaveBeenCalled()

      // Settled promises are dropped: once the binary appears on disk the next
      // call re-runs and takes the cache-hit path instead of the stale rejection.
      const platform = codexFlavor.detectPlatform()
      const versionDir = path.join(dir, '0.9.9')
      const binary = codexFlavor.binaryIn(versionDir, platform)
      await mkdir(path.dirname(binary), { recursive: true })
      await writeFile(binary, 'MZ')
      await writeFile(path.join(dir, '.active'), '0.9.9', 'utf8')
      await expect(store.resolveDownload(false)).resolves.toBe(binary)
    } finally {
      store.dispose()
    }
  })

  it('cleanupStaleVersions removes stale version dirs but keeps dotfiles and in-flight extracts', async () => {
    const dir = await makeTempDir()
    const kept = ['0.2.0', '0.3.0.extract.1234']
    for (const entry of [...kept, '0.1.0', '.prefetch']) {
      await mkdir(path.join(dir, entry), { recursive: true })
    }
    await writeFile(path.join(dir, '.active'), '0.2.0', 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      await store.cleanupStaleVersions()

      const entries = (await readdir(dir)).sort()
      expect(entries).toEqual(['.active', '.prefetch', '0.2.0', '0.3.0.extract.1234'])
      expect(await exists(path.join(dir, '0.1.0'))).toBe(false)
    } finally {
      store.dispose()
    }
  })
})
