/*---------------------------------------------------------------------------------------------
 *  Tests for AgentBinaryStore's download semantics without touching the network:
 *  the allowDownload fast-fail, the zero-network activation of an on-disk version,
 *  per-version download de-duplication, the download-state channel, and the
 *  cleanupStaleVersions keep-set. The codex flavor is used because its bundled
 *  version is a constant (no claude-binary.json fixture).
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBinaryStore, type AgentBinaryDownloadState } from '../agentBinaryStore.js'
import { CODEX_VERSION, codexFlavor } from '../flavors.js'
import { mkTempDir } from '@universe-editor/temp-root'

const LATEST = '9.9.9'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = mkTempDir('universe-editor-agent-store-')
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

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Answers `/latest` and the package metadata (via `metadata`), tarballs throw. */
function stubRegistry(metadata: () => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown) => {
    const url = String(input)
    if (url.endsWith('/latest')) return Promise.resolve(jsonResponse({ version: LATEST }))
    if (url.endsWith('.tgz')) return Promise.reject(new Error('tarball fetch not stubbed'))
    return metadata()
  }) as unknown as typeof fetch)
}

/**
 * For the cases that assert "the network was never touched": rejecting every call
 * keeps the suite offline, so a regression fails loudly instead of really reaching
 * the registry (and hanging until the 10s abort).
 */
function offlineFetch() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'))
}

/** Writes `<baseDir>/<version>/<bin>` so the store sees a complete on-disk version. */
async function writeVersion(baseDir: string, version: string): Promise<string> {
  const platform = codexFlavor.detectPlatform()
  const binary = codexFlavor.binaryIn(path.join(baseDir, version), platform)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, 'MZ')
  return binary
}

async function listVersionDirs(baseDir: string): Promise<string[]> {
  return (await readdir(baseDir)).filter((e) => !e.startsWith('.')).sort()
}

function state(
  version: string,
  received: number,
  total: number,
  background = false,
): AgentBinaryDownloadState {
  return { version, received, total, background }
}

describe('AgentBinaryStore', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it('fails fast on a cache miss when allowDownload is false, without touching the network', async () => {
    const dir = await makeTempDir()
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const fetchSpy = offlineFetch()
    try {
      await expect(store.resolveDownload(false)).rejects.toThrow(/not downloaded yet/)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('returns the `.active` version dir binary on a cache hit, without touching the network', async () => {
    const dir = await makeTempDir()
    const binary = await writeVersion(dir, '0.9.9')
    await writeFile(path.join(dir, '.active'), '0.9.9', 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const fetchSpy = offlineFetch()
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
      await expect(download).rejects.toThrow(/offline/)
      expect(fetchSpy).toHaveBeenCalled()

      // Settled promises are dropped: once the binary appears on disk the next
      // call re-runs and takes the cache-hit path instead of the stale rejection.
      const binary = await writeVersion(dir, '0.9.9')
      await writeFile(path.join(dir, '.active'), '0.9.9', 'utf8')
      await expect(store.resolveDownload(false)).resolves.toBe(binary)
    } finally {
      store.dispose()
    }
  })

  it('forceDownload activates an on-disk version with zero network and flips .active', async () => {
    const dir = await makeTempDir()
    const binary = await writeVersion(dir, '0.9.9')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const fetchSpy = offlineFetch()
    try {
      await expect(store.forceDownload('0.9.9')).resolves.toBe(binary)
      expect((await readFile(path.join(dir, '.active'), 'utf8')).trim()).toBe('0.9.9')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('adopts a legacy `.prefetch` staged version without a network fetch', async () => {
    const dir = await makeTempDir()
    const platform = codexFlavor.detectPlatform()
    const staged = codexFlavor.binaryIn(path.join(dir, '.prefetch', '0.9.9'), platform)
    await mkdir(path.dirname(staged), { recursive: true })
    await writeFile(staged, 'MZ')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const fetchSpy = offlineFetch()
    try {
      const binary = await store.forceDownload('0.9.9')
      const expected = codexFlavor.binaryIn(path.join(dir, '0.9.9'), platform)
      expect(binary).toBe(expected)
      expect(await exists(binary)).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('de-dupes concurrent downloads of one version into a single request', async () => {
    const dir = await makeTempDir()
    const gate = deferred<Response>()
    const fetchSpy = stubRegistry(() => gate.promise)
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    const events: (readonly AgentBinaryDownloadState[])[] = []
    store.onDidChangeDownload((d) => events.push(d))
    try {
      const first = store.forceDownload(LATEST)
      const second = store.forceDownload(LATEST)
      await waitFor(() => fetchSpy.mock.calls.length >= 1)

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(events).toEqual([[state(LATEST, 0, 0)]])

      gate.resolve(jsonResponse({ dist: { tarball: 'https://example.com/pkg.tgz' } }))
      await expect(first).rejects.toThrow()
      await expect(second).rejects.toThrow()
      // A failed download must clear its state, or the UI would sit on it forever.
      expect(events[events.length - 1]).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('joins an in-flight background prefetch instead of fetching the version twice', async () => {
    const dir = await makeTempDir()
    const gate = deferred<Response>()
    const fetchSpy = stubRegistry(() => gate.promise)
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      // prefetch() queries /latest first (call 1), then starts the download (call 2).
      void store.prefetch()
      await waitFor(() => fetchSpy.mock.calls.length >= 2)

      // The user clicks "upgrade to latest" while the prefetch is still running:
      // it must ride the same download, not start a second one. Asserted after both
      // settle (not on a timer): a second download would ask the registry for the
      // package metadata a second time, so that count would be 2 here.
      const metadataCalls = (): number =>
        fetchSpy.mock.calls.filter((call) => {
          const url = String(call[0])
          return !url.endsWith('.tgz') && !url.endsWith('/latest')
        }).length
      const forced = store.forceDownload(LATEST)
      gate.resolve(jsonResponse({ dist: { tarball: 'https://example.com/pkg.tgz' } }))
      await expect(forced).rejects.toThrow(/tarball fetch not stubbed/)
      expect(metadataCalls()).toBe(1)
    } finally {
      store.dispose()
    }
  })

  it('resolves without downloading when the pinned version cannot be read', async () => {
    const dir = await makeTempDir()
    const flavor = {
      ...codexFlavor,
      bundledVersion: async () => {
        throw new Error('meta file missing')
      },
    }
    const store = new AgentBinaryStore({ baseDir: dir, flavor })
    const fetchSpy = offlineFetch()
    try {
      // The contract the background contribution relies on: a broken install must
      // not turn into an unhandled rejection on the idle path.
      await expect(store.prefetch()).resolves.toBeUndefined()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('reports in-flight downloads through getVersionInfo and clears them on failure', async () => {
    const dir = await makeTempDir()
    const gate = deferred<Response>()
    const fetchSpy = stubRegistry(() => gate.promise)
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      const attempt = store.forceDownload(LATEST)
      await waitFor(() => fetchSpy.mock.calls.length >= 1)

      const inFlight = await store.getVersionInfo()
      expect(inFlight.downloads).toEqual([state(LATEST, 0, 0)])

      gate.resolve(jsonResponse({ dist: { tarball: 'https://example.com/pkg.tgz' } }))
      await expect(attempt).rejects.toThrow()
      expect((await store.getVersionInfo()).downloads).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('records the registry latest so a later cleanup can keep that version', async () => {
    const dir = await makeTempDir()
    stubRegistry(() => Promise.reject(new Error('unused')))
    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      expect((await store.getVersionInfo()).latestVersion).toBe(LATEST)
      expect((await readFile(path.join(dir, '.latest'), 'utf8')).trim()).toBe(LATEST)
    } finally {
      store.dispose()
    }
  })

  it('lists the versions extracted on disk', async () => {
    const dir = await makeTempDir()
    await writeVersion(dir, '0.9.9')
    await writeVersion(dir, '0.8.0')
    // A dir without the binary inside is not a usable version.
    await mkdir(path.join(dir, '0.7.0'), { recursive: true })
    stubRegistry(() => Promise.reject(new Error('unused')))

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      expect((await store.getVersionInfo()).downloadedVersions).toEqual(['0.8.0', '0.9.9'])
    } finally {
      store.dispose()
    }
  })

  it('cleanupStaleVersions keeps the active, pinned and last-known-latest dirs', async () => {
    const dir = await makeTempDir()
    for (const version of ['0.1.0', '0.2.0', CODEX_VERSION, '0.4.0', '0.5.0']) {
      await mkdir(path.join(dir, version), { recursive: true })
    }
    await writeFile(path.join(dir, '.active'), '0.2.0', 'utf8')
    await writeFile(path.join(dir, '.latest'), '0.4.0', 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      await store.cleanupStaleVersions()
      expect(await listVersionDirs(dir)).toEqual(['0.2.0', '0.4.0', CODEX_VERSION].sort())
    } finally {
      store.dispose()
    }
  })

  it('cleanupStaleVersions keeps dotfiles and in-flight extracts, and reclaims the legacy staging dir', async () => {
    const dir = await makeTempDir()
    for (const entry of ['0.2.0', '0.3.0.extract.1234', '0.1.0', '.prefetch']) {
      await mkdir(path.join(dir, entry), { recursive: true })
    }
    await writeFile(path.join(dir, '.active'), '0.2.0', 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      await store.cleanupStaleVersions()

      expect((await readdir(dir)).sort()).toEqual(['.active', '0.2.0', '0.3.0.extract.1234'])
      expect(await exists(path.join(dir, '0.1.0'))).toBe(false)
      // `.prefetch` is a dotfile, so the skip rule above would keep it forever.
      expect(await exists(path.join(dir, '.prefetch'))).toBe(false)
    } finally {
      store.dispose()
    }
  })

  it('cleanupStaleVersions adopts a staged legacy version instead of reclaiming it', async () => {
    const dir = await makeTempDir()
    const platform = codexFlavor.detectPlatform()
    const staged = codexFlavor.binaryIn(path.join(dir, '.prefetch', '0.9.9'), platform)
    await mkdir(path.dirname(staged), { recursive: true })
    await writeFile(staged, 'MZ')
    await mkdir(path.join(dir, '0.1.0'), { recursive: true })
    await writeFile(path.join(dir, '.active'), CODEX_VERSION, 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      await store.cleanupStaleVersions()

      // Cleanup runs at idle, i.e. before the user's next click: reclaiming the
      // staging dir blindly would throw away a download they already paid for.
      expect(await listVersionDirs(dir)).toEqual(['0.9.9'])
      expect(await exists(path.join(dir, '.prefetch'))).toBe(false)
    } finally {
      store.dispose()
    }
  })

  it('cleanupStaleVersions keeps a version whose download is still in flight', async () => {
    const dir = await makeTempDir()
    const gate = deferred<Response>()
    const fetchSpy = stubRegistry(() => gate.promise)
    await writeFile(path.join(dir, '.active'), CODEX_VERSION, 'utf8')

    const store = new AgentBinaryStore({ baseDir: dir, flavor: codexFlavor })
    try {
      const attempt = store.forceDownload(LATEST)
      await waitFor(() => fetchSpy.mock.calls.length >= 1)

      // The version has no dir yet, and `.latest` hasn't been rewritten either, so
      // only the in-flight set keeps it out of the sweep.
      await store.cleanupStaleVersions()
      expect((await store.getVersionInfo()).downloads.map((d) => d.version)).toEqual([LATEST])

      gate.resolve(jsonResponse({ dist: { tarball: 'https://example.com/pkg.tgz' } }))
      await expect(attempt).rejects.toThrow()
    } finally {
      store.dispose()
    }
  })
})
