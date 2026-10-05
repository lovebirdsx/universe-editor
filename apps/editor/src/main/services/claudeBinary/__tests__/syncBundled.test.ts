/*---------------------------------------------------------------------------------------------
 *  Regression tests for ClaudeBinaryMainService.syncBundled — the idle alignment
 *  that moves the managed binary onto the editor's new pinned SDK version after an
 *  upgrade. Guards the resolve() cache trap: `_inflight` caches a resolved path
 *  until it fails, so an alignment that flips `.active` must also evict it or the
 *  session keeps spawning the previous version's binary.
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
/** A previously pinned version, still on disk. */
const OLD_PIN = '0.3.100'
/**
 * A version newer than the pin, i.e. one the user picked by hand. The runtime
 * floor only replaces an `.active` *below* the pin, so this is what a session can
 * hold when an editor upgrade moves the pin under it.
 */
const PICKED_VERSION = '0.3.200'

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

function binName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

async function writeBinary(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, binName()), 'MZ')
}

function metaPath(): string {
  return path.join(resourcesPath, 'claude-agent-acp', 'dist', 'claude-binary.json')
}

async function writeActive(version: string): Promise<void> {
  await writeFile(path.join(claudeBinDir(), '.active'), version, 'utf8')
}

async function readActive(): Promise<string> {
  return (await readFile(path.join(claudeBinDir(), '.active'), 'utf8')).trim()
}

async function readBundled(): Promise<string> {
  return (await readFile(path.join(claudeBinDir(), '.bundled'), 'utf8')).trim()
}

describe('ClaudeBinaryMainService.syncBundled', () => {
  beforeEach(async () => {
    userData = mkTempDir('universe-editor-claude-sync-')
    resourcesPath = mkTempDir('universe-editor-claude-sync-res-')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    })
    await mkdir(path.dirname(metaPath()), { recursive: true })
    await writeFile(metaPath(), JSON.stringify({ sdkVersion: SDK_VERSION }), 'utf8')
  })

  afterEach(async () => {
    removeDirWithRetry(userData)
    removeDirWithRetry(resourcesPath)
    vi.restoreAllMocks()
  })

  it('aligns to a changed pin offline and evicts the resolve() path cached for the old one', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir(PICKED_VERSION))
    await writeBinary(binDir(SDK_VERSION))
    await writeActive(PICKED_VERSION)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // The session resolved (and cached) the version that was active before the pin
    // moved — a hand-picked newer one, which the runtime floor leaves alone.
    const before = await svc.resolve({ source: 'download', policy: 'manual' })
    expect(before.path).toBe(path.join(binDir(PICKED_VERSION), binName()))

    await expect(svc.syncBundled()).resolves.toBe(SDK_VERSION)

    expect(await readActive()).toBe(SDK_VERSION)
    expect(await readBundled()).toBe(SDK_VERSION)
    expect(fetchSpy).not.toHaveBeenCalled()
    // The trap this guards: a still-cached resolve would keep handing out the old
    // dir — and thus the old binary — for the rest of the session.
    const after = await svc.resolve({ source: 'download', policy: 'manual' })
    expect(after.path).toBe(path.join(binDir(SDK_VERSION), binName()))
  })

  it('observes the flipped .active on a background resolve', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir(PICKED_VERSION))
    await writeBinary(binDir(SDK_VERSION))
    await writeActive(PICKED_VERSION)

    // The `allowDownload:false` key is dropped by the same `.active` flip — a
    // background resolve must re-read the pointer, not hand out the pre-alignment
    // binary (which the store may even answer from a below-pin fallback).
    const before = await svc.resolve({ source: 'download', allowDownload: false, policy: 'manual' })
    expect(before.path).toBe(path.join(binDir(PICKED_VERSION), binName()))

    await expect(svc.syncBundled()).resolves.toBe(SDK_VERSION)

    const after = await svc.resolve({ source: 'download', allowDownload: false, policy: 'manual' })
    expect(after.path).toBe(path.join(binDir(SDK_VERSION), binName()))
  })

  it('does nothing once the pin has been aligned', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir(SDK_VERSION))
    await writeActive(SDK_VERSION)

    await expect(svc.syncBundled()).resolves.toBeNull()
    expect(await readBundled()).toBe(SDK_VERSION)
    // A second pass has nothing left to detect.
    await expect(svc.syncBundled()).resolves.toBeNull()
  })

  it('returns null without throwing when the alignment download fails, and retries next call', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir(OLD_PIN))
    await writeActive(OLD_PIN)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))

    await expect(svc.syncBundled()).resolves.toBeNull()

    // Nothing was recorded, so the next session retries rather than staying on
    // the previous pin forever.
    expect(await exists(path.join(claudeBinDir(), '.bundled'))).toBe(false)
    expect(await readActive()).toBe(OLD_PIN)
    expect(fetchSpy).toHaveBeenCalled()

    fetchSpy.mockClear()
    await expect(svc.syncBundled()).resolves.toBeNull()
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('returns null when the pinned version cannot even be read', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir(OLD_PIN))
    await writeActive(OLD_PIN)
    await rm(metaPath(), { force: true })

    await expect(svc.syncBundled()).resolves.toBeNull()
    expect(await exists(path.join(claudeBinDir(), '.bundled'))).toBe(false)
  })
})
