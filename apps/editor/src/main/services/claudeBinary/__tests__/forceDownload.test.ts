/*---------------------------------------------------------------------------------------------
 *  Regression tests for ClaudeBinaryMainService.forceDownload — verifies the
 *  per-version-dir + `.active` pointer scheme so an upgrade never touches the
 *  running binary's (Windows-locked) files, and that a version already on disk
 *  (the pinned one, or the latest after a previous download) is re-activated
 *  with zero network. See commit history for the original EPERM-on-rename bug
 *  this guards against.
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'

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

const SDK_VERSION = '0.3.186'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function claudeBinDir(): string {
  return path.join(userData, 'claude-bin')
}

function binDir(version: string): string {
  return path.join(claudeBinDir(), version)
}

/** The platform binary name forceDownload writes; mirrors detectPlatformBinary. */
function binName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

async function writeBinary(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, binName()), 'MZ')
}

/** `bundledVersion()` reads this file; it defines the pinned version under test. */
function metaPath(): string {
  return path.join(resourcesPath, 'claude-agent-acp', 'dist', 'claude-binary.json')
}

async function writeActive(version: string): Promise<void> {
  await writeFile(path.join(claudeBinDir(), '.active'), version, 'utf8')
}

async function readActive(): Promise<string> {
  return (await readFile(path.join(claudeBinDir(), '.active'), 'utf8')).trim()
}

describe('ClaudeBinaryMainService.forceDownload', () => {
  beforeEach(async () => {
    userData = mkTempDir('universe-editor-claude-fd-')
    resourcesPath = mkTempDir('universe-editor-claude-res-')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    })
    await mkdir(path.dirname(metaPath()), { recursive: true })
    await writeFile(metaPath(), JSON.stringify({ sdkVersion: SDK_VERSION }), 'utf8')
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
    await rm(resourcesPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('activates an already-downloaded version from its own dir and flips .active', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.195'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await svc.forceDownload('0.3.195')

    expect(result.path).toBe(path.join(binDir('0.3.195'), binName()))
    expect(await exists(result.path)).toBe(true)
    expect(await readActive()).toBe('0.3.195')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reverts to the pinned version without touching the network when its dir is on disk', async () => {
    const svc = new ClaudeBinaryMainService()
    // Upgraded to a newer version earlier; the pinned dir was kept around.
    await writeBinary(binDir(SDK_VERSION))
    await writeBinary(binDir('0.3.195'))
    await writeActive('0.3.195')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await svc.forceDownload(SDK_VERSION)

    expect(result.path).toBe(path.join(binDir(SDK_VERSION), binName()))
    expect(await readActive()).toBe(SDK_VERSION)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not delete or overwrite the previous active version dir during upgrade', async () => {
    const svc = new ClaudeBinaryMainService()

    // Simulate the currently-running version sitting in its own dir.
    await writeBinary(binDir(SDK_VERSION))
    await writeActive(SDK_VERSION)

    // The upgrade target already has its dir, so activation must stay offline; a
    // re-download would reject here instead of silently succeeding on a real network.
    await writeBinary(binDir('0.3.195'))
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network call'))

    await svc.forceDownload('0.3.195')

    expect(fetchSpy).not.toHaveBeenCalled()
    // The new version is active and present; the old dir is untouched (and would be
    // locked in production), so activation never had to delete an in-use binary.
    expect(await readActive()).toBe('0.3.195')
    expect(await exists(path.join(binDir('0.3.195'), binName()))).toBe(true)
    expect(await exists(path.join(binDir(SDK_VERSION), binName()))).toBe(true)
  })

  it('keeps the previous version dir during upgrade (cleanup is deferred to startup)', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.100'))
    await writeBinary(binDir(SDK_VERSION))
    await writeBinary(binDir('0.3.195'))
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network call'))

    await svc.forceDownload('0.3.195')

    const dirs = (await readdir(claudeBinDir())).filter((e) => !e.startsWith('.')).sort()
    // Old dirs are left locked-but-present; only the next-launch sweep removes them.
    expect(dirs).toEqual(['0.3.100', '0.3.186', '0.3.195'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('cleanupStaleVersions keeps the active, pinned and last-known-latest dirs', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.100'))
    await writeBinary(binDir(SDK_VERSION))
    await writeBinary(binDir('0.3.195'))
    await writeBinary(binDir('0.3.200'))
    await writeActive('0.3.195')
    // What getVersionInfo()/prefetch() last saw on the registry.
    await writeFile(path.join(claudeBinDir(), '.latest'), '0.3.200', 'utf8')

    await svc.cleanupStaleVersions()

    const dirs = (await readdir(claudeBinDir())).filter((e) => !e.startsWith('.')).sort()
    // 0.3.100 is neither active, pinned nor the known latest → the only casualty.
    expect(dirs).toEqual(['0.3.186', '0.3.195', '0.3.200'])
  })

  it('cleanupStaleVersions leaves the tree alone when no version can be pinned down', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.100'))
    // No `.active` pointer and no readable bundled version ⇒ an empty keep-set
    // would wipe every downloaded version, so the sweep must bail out instead.
    await rm(metaPath(), { force: true })

    await svc.cleanupStaleVersions()

    expect(await exists(path.join(binDir('0.3.100'), binName()))).toBe(true)
  })

  it('adopts a legacy .prefetch staged version without a network fetch', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(path.join(claudeBinDir(), '.prefetch', '0.3.195'))
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network call'))

    const result = await svc.forceDownload('0.3.195')

    expect(result.path).toBe(path.join(binDir('0.3.195'), binName()))
    expect(await readActive()).toBe('0.3.195')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('re-activates an already-active version without downloading it again', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.195'))
    await writeActive('0.3.195')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network call'))

    const result = await svc.forceDownload('0.3.195')

    expect(result.path).toBe(path.join(binDir('0.3.195'), binName()))
    expect(await readActive()).toBe('0.3.195')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
