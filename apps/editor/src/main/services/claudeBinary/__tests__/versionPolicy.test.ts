/*---------------------------------------------------------------------------------------------
 *  Tests for the version-policy plumbing in claudeBinaryMainService: the resolve
 *  cache in `_inflight` is keyed by policy (so unlocking version selection
 *  mid-session can never reuse the path resolved under the lock), and the
 *  eviction a version switch performs covers both policies' entries.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

let userData = ''
let resourcesPath = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: true, // skip the dev vendored-binary shortcut
    getAppPath: () => '/fake/app',
    getPath: () => userData,
  },
}))

const { ClaudeBinaryMainService } = await import('../claudeBinaryMainService.js')

/** The pinned version under test — claude reads it from claude-binary.json. */
const SDK_VERSION = '0.3.186'
/**
 * A version a user picked by hand, on disk and named by `.active`. It sits *above*
 * the pin on purpose: the runtime floor replaces anything below it, so only a
 * newer pick is what a manual resolve can actually hand out.
 */
const PICKED = '0.3.200'

function claudeBinDir(): string {
  return path.join(userData, 'claude-bin')
}

function binDir(version: string): string {
  return path.join(claudeBinDir(), version)
}

function binName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

async function writeBinary(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, binName()), 'MZ')
}

async function writeActive(version: string): Promise<void> {
  await writeFile(path.join(claudeBinDir(), '.active'), version, 'utf8')
}

function metaPath(): string {
  return path.join(resourcesPath, 'claude-agent-acp', 'dist', 'claude-binary.json')
}

describe('ClaudeBinaryMainService — version policy', () => {
  beforeEach(async () => {
    userData = mkTempDir('universe-editor-claude-policy-')
    resourcesPath = mkTempDir('universe-editor-claude-policy-res-')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    })
    await mkdir(path.dirname(metaPath()), { recursive: true })
    await writeFile(metaPath(), JSON.stringify({ sdkVersion: SDK_VERSION }), 'utf8')
  })

  afterEach(() => {
    removeDirWithRetry(userData)
    removeDirWithRetry(resourcesPath)
    vi.restoreAllMocks()
  })

  it('keeps the resolve cache per policy instead of per options', async () => {
    const svc = new ClaudeBinaryMainService()
    try {
      await writeBinary(binDir(SDK_VERSION))
      await writeBinary(binDir(PICKED))
      await writeActive(PICKED)

      // The pick wins under the manual policy ...
      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(PICKED), binName()),
      })
      // ... and the locked resolve right after must not be handed its cached path.
      await expect(svc.resolve({ source: 'download', policy: 'pinned' })).resolves.toEqual({
        path: path.join(binDir(SDK_VERSION), binName()),
      })
    } finally {
      svc.dispose()
    }
  })

  it('drops the cached paths on a policy flip, so unlocking cannot serve the pre-lock pick', async () => {
    const svc = new ClaudeBinaryMainService()
    try {
      await writeBinary(binDir(SDK_VERSION))
      await writeBinary(binDir(PICKED))
      await writeActive(PICKED)

      // Manual first: the pick is cached and `.active` names it.
      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(PICKED), binName()),
      })
      // Locking resolves the pin and reconciles `.active` to it.
      await expect(svc.resolve({ source: 'download', policy: 'pinned' })).resolves.toEqual({
        path: path.join(binDir(SDK_VERSION), binName()),
      })
      // Unlocking must therefore resume the pin: serving the stale manual entry
      // would run a binary the panel (which reads `.active`) no longer reports.
      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(SDK_VERSION), binName()),
      })
    } finally {
      svc.dispose()
    }
  })

  it('evicts the manual cache entry when a version switch moves `.active`', async () => {
    const svc = new ClaudeBinaryMainService()
    try {
      await writeBinary(binDir(SDK_VERSION))
      await writeBinary(binDir(PICKED))
      await writeActive(PICKED)

      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(PICKED), binName()),
      })

      await svc.forceDownload(SDK_VERSION)

      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(SDK_VERSION), binName()),
      })
    } finally {
      svc.dispose()
    }
  })

  it('drops a resolve cached inside the switch window once the switch lands', async () => {
    const svc = new ClaudeBinaryMainService()
    let failFetch!: (err: Error) => void
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((_, reject) => (failFetch = reject)))
    try {
      await writeBinary(binDir(PICKED))
      await writeActive(PICKED)
      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(PICKED), binName()),
      })

      // A switch to a pin that isn't on disk yet hangs on the registry fetch, keeping
      // the window open while the next resolve re-caches the outgoing version.
      const switching = svc.forceDownload(SDK_VERSION)
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(PICKED), binName()),
      })

      // The download fails, then lands on the retry: the version dir is on disk and
      // the store moves `.active` through `_setActiveVersion` — the announcement that
      // tells the resolve cache the path it holds from the window is stale.
      failFetch(new Error('registry closed'))
      await expect(switching).rejects.toThrow(/registry closed/)
      await writeBinary(binDir(SDK_VERSION))
      await svc.forceDownload(SDK_VERSION)

      await expect(svc.resolve({ source: 'download', policy: 'manual' })).resolves.toEqual({
        path: path.join(binDir(SDK_VERSION), binName()),
      })
    } finally {
      svc.dispose()
    }
  })
})
