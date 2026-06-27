/*---------------------------------------------------------------------------------------------
 *  Regression tests for ClaudeBinaryMainService.forceDownload — verifies the
 *  per-version-dir + `.active` pointer scheme so an upgrade never touches the
 *  running binary's (Windows-locked) files. See commit history for the original
 *  EPERM-on-rename bug this guards against.
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

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

function binDir(version: string): string {
  return path.join(userData, 'claude-bin', version)
}

/** The platform binary name forceDownload writes; mirrors detectPlatformBinary. */
function binName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

async function writeBinary(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, binName()), 'MZ')
}

/** Stage a prefetched version so forceDownload takes the no-network fast path. */
async function stagePrefetch(version: string): Promise<void> {
  await writeBinary(path.join(userData, 'claude-bin', '.prefetch', version))
}

describe('ClaudeBinaryMainService.forceDownload', () => {
  beforeEach(async () => {
    userData = await mkdtemp(path.join(tmpdir(), 'universe-editor-claude-fd-'))
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('activates a prefetched version into its own dir and flips .active', async () => {
    const svc = new ClaudeBinaryMainService()
    await stagePrefetch('0.3.195')

    const result = await svc.forceDownload('0.3.195')

    expect(result.path).toBe(path.join(binDir('0.3.195'), binName()))
    expect(await exists(result.path)).toBe(true)
    expect((await readFile(path.join(userData, 'claude-bin', '.active'), 'utf8')).trim()).toBe(
      '0.3.195',
    )
  })

  it('does not delete or overwrite the previous active version dir during upgrade', async () => {
    const svc = new ClaudeBinaryMainService()

    // Simulate the currently-running version sitting in its own dir.
    await writeBinary(binDir(SDK_VERSION))
    await writeFile(path.join(userData, 'claude-bin', '.active'), SDK_VERSION, 'utf8')

    await stagePrefetch('0.3.195')

    // The upgrade target differs from the running version, so its dir is brand new —
    // the rename target never overlaps the (potentially locked) running dir.
    await svc.forceDownload('0.3.195')

    // The new version is active and present; the old dir is untouched (and would be
    // locked in production), so activation never had to delete an in-use binary.
    expect((await readFile(path.join(userData, 'claude-bin', '.active'), 'utf8')).trim()).toBe(
      '0.3.195',
    )
    expect(await exists(path.join(binDir('0.3.195'), binName()))).toBe(true)
    expect(await exists(path.join(binDir(SDK_VERSION), binName()))).toBe(true)
  })

  it('keeps the previous version dir during upgrade (cleanup is deferred to startup)', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.100'))
    await writeBinary(binDir(SDK_VERSION))
    await stagePrefetch('0.3.195')

    await svc.forceDownload('0.3.195')

    const dirs = (await readdir(path.join(userData, 'claude-bin')))
      .filter((e) => !e.startsWith('.'))
      .sort()
    // Old dirs are left locked-but-present; only the next-launch sweep removes them.
    expect(dirs).toEqual(['0.3.100', '0.3.186', '0.3.195'])
  })

  it('cleanupStaleVersions removes every dir except the active one', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.100'))
    await writeBinary(binDir(SDK_VERSION))
    await writeBinary(binDir('0.3.195'))
    await writeFile(path.join(userData, 'claude-bin', '.active'), '0.3.195', 'utf8')

    await svc.cleanupStaleVersions()

    const dirs = (await readdir(path.join(userData, 'claude-bin'))).filter(
      (e) => !e.startsWith('.'),
    )
    expect(dirs).toEqual(['0.3.195'])
  })

  it('is a no-op when the requested version is already active', async () => {
    const svc = new ClaudeBinaryMainService()
    await writeBinary(binDir('0.3.195'))
    await writeFile(path.join(userData, 'claude-bin', '.active'), '0.3.195', 'utf8')

    const result = await svc.forceDownload('0.3.195')

    expect(result.path).toBe(path.join(binDir('0.3.195'), binName()))
    // No prefetch staged and no network call needed — the early return handled it.
    expect(await exists(path.join(userData, 'claude-bin', '.prefetch'))).toBe(false)
  })
})
