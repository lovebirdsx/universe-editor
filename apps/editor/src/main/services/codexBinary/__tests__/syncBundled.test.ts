/*---------------------------------------------------------------------------------------------
 *  Regression tests for CodexBinaryMainService.syncBundled — the idle alignment
 *  that moves the managed binary onto the newly pinned codex version after an
 *  editor upgrade. Guards the resolve() cache trap: `_inflight` caches a resolved
 *  path until it fails, so an alignment that flips `.active` must also evict it or
 *  the session keeps spawning the previous version's binary.
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_VERSION } from '@universe-editor/node-services'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

let userData = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/fake/app',
    getPath: () => userData,
  },
}))

const { CodexBinaryMainService } = await import('../codexBinaryMainService.js')

/** A previously pinned version, still on disk. */
const OLD_PIN = '0.100.0'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function codexBinDir(): string {
  return path.join(userData, 'codex-bin')
}

function binDir(version: string): string {
  return path.join(codexBinDir(), version)
}

function binName(): string {
  return process.platform === 'win32' ? 'codex.exe' : 'codex'
}

/** Mirrors codexFlavor.binaryIn: the executable lives under `bin/`. */
async function writeBinary(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'bin'), { recursive: true })
  await writeFile(path.join(dir, 'bin', binName()), 'MZ')
}

function binaryIn(dir: string): string {
  return path.join(dir, 'bin', binName())
}

async function writeActive(version: string): Promise<void> {
  await writeFile(path.join(codexBinDir(), '.active'), version, 'utf8')
}

async function readActive(): Promise<string> {
  return (await readFile(path.join(codexBinDir(), '.active'), 'utf8')).trim()
}

async function readBundled(): Promise<string> {
  return (await readFile(path.join(codexBinDir(), '.bundled'), 'utf8')).trim()
}

describe('CodexBinaryMainService.syncBundled', () => {
  beforeEach(() => {
    userData = mkTempDir('universe-editor-codex-sync-')
  })

  afterEach(() => {
    removeDirWithRetry(userData)
    vi.restoreAllMocks()
  })

  it('aligns to the pinned version offline and evicts the cached resolve() path', async () => {
    const svc = new CodexBinaryMainService()
    await writeBinary(binDir(OLD_PIN))
    await writeBinary(binDir(CODEX_VERSION))
    await writeActive(OLD_PIN)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const before = await svc.resolve({ source: 'download' })
    expect(before.path).toBe(binaryIn(binDir(OLD_PIN)))

    await expect(svc.syncBundled()).resolves.toBe(CODEX_VERSION)

    expect(await readActive()).toBe(CODEX_VERSION)
    expect(await readBundled()).toBe(CODEX_VERSION)
    expect(fetchSpy).not.toHaveBeenCalled()
    const after = await svc.resolve({ source: 'download' })
    expect(after.path).toBe(binaryIn(binDir(CODEX_VERSION)))
  })

  it('leaves a version the user picked by hand alone while the pin is unchanged', async () => {
    const svc = new CodexBinaryMainService()
    await writeBinary(binDir(CODEX_VERSION))
    await writeBinary(binDir('9.9.9'))
    await writeFile(path.join(codexBinDir(), '.active'), '9.9.9', 'utf8')
    await writeFile(path.join(codexBinDir(), '.bundled'), CODEX_VERSION, 'utf8')

    await expect(svc.syncBundled()).resolves.toBeNull()
    expect(await readActive()).toBe('9.9.9')
  })

  it('returns null without throwing when the alignment download fails, and retries next call', async () => {
    const svc = new CodexBinaryMainService()
    await writeBinary(binDir(OLD_PIN))
    await writeActive(OLD_PIN)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))

    await expect(svc.syncBundled()).resolves.toBeNull()

    expect(await exists(path.join(codexBinDir(), '.bundled'))).toBe(false)
    expect(await readActive()).toBe(OLD_PIN)
    expect(fetchSpy).toHaveBeenCalled()

    fetchSpy.mockClear()
    await expect(svc.syncBundled()).resolves.toBeNull()
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('records the pin without downloading anything when no version was ever installed', async () => {
    const svc = new CodexBinaryMainService()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(svc.syncBundled()).resolves.toBeNull()

    expect(await readBundled()).toBe(CODEX_VERSION)
    expect(await exists(path.join(codexBinDir(), '.active'))).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps the replaced version dir until the next launch, then reclaims it', async () => {
    const svc = new CodexBinaryMainService()
    await writeBinary(binDir(OLD_PIN))
    await writeBinary(binDir(CODEX_VERSION))
    await writeActive(OLD_PIN)

    await expect(svc.syncBundled()).resolves.toBe(CODEX_VERSION)

    // A second window opened later in the session sweeps after `.active` has moved
    // on, so the dir the running session may still use — and an offline revert needs
    // — has to survive this process. The predecessor is not deleted here either: the
    // running agent still holds it (Windows).
    await svc.cleanupStaleVersions()
    expect(await exists(binaryIn(binDir(OLD_PIN)))).toBe(true)
    expect(await exists(binaryIn(binDir(CODEX_VERSION)))).toBe(true)

    // Next launch: a fresh service (and store) no longer retains it.
    const next = new CodexBinaryMainService()
    await next.cleanupStaleVersions()
    expect(await exists(binaryIn(binDir(OLD_PIN)))).toBe(false)
    expect(await exists(binaryIn(binDir(CODEX_VERSION)))).toBe(true)
  })
})
