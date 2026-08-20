/*---------------------------------------------------------------------------------------------
 *  Tests for packages/remote-server/src/extensionManagementService.ts
 *  Drives the service directly (not through a channel): temp dataDir, vsix
 *  fixtures built with extension-packaging's createVsix. Covers the chunked
 *  upload buffer, install/uninstall/enablement/icon against the shared engine,
 *  and the upload-temp cleanup paths.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVsix } from '@universe-editor/extension-packaging'
import { LogLevel, NullLogger, type ILoggerService } from '@universe-editor/platform'
import { RemoteExtensionManagementService } from '../extensionManagementService.js'
import { resolveExtensionGlobalStorageDir, resolveUserExtensionsDir } from '../serverPaths.js'

const loggerService: ILoggerService = {
  _serviceBrand: undefined,
  createLogger: () => new NullLogger(),
  setLevel: () => {},
  getLevel: () => LogLevel.Info,
}

let root: string
let dataDir: string
let svc: RemoteExtensionManagementService

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ue-extmgmt-'))
  dataDir = path.join(root, 'data')
  svc = new RemoteExtensionManagementService({ dataDir, loggerService })
})

afterEach(async () => {
  svc.dispose()
  await rm(root, { recursive: true, force: true })
})

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sample',
    publisher: 'acme',
    version: '1.0.0',
    engines: { universe: '^0.1.0' },
    main: 'dist/extension.js',
    ...overrides,
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Write an extension dir (package.json + entry [+ icon]) and pack it into a VSIX. */
async function makeVsix(
  name: string,
  m: Record<string, unknown>,
  iconBytes?: Buffer,
): Promise<string> {
  const extDir = path.join(root, name)
  await mkdir(path.join(extDir, 'dist'), { recursive: true })
  await writeFile(path.join(extDir, 'package.json'), JSON.stringify(m))
  await writeFile(path.join(extDir, 'dist', 'extension.js'), 'module.exports={}')
  if (iconBytes) {
    await mkdir(path.join(extDir, 'media'), { recursive: true })
    await writeFile(path.join(extDir, 'media', 'icon.png'), iconBytes)
  }
  const vsixPath = path.join(root, `${name}.vsix`)
  await createVsix(extDir, vsixPath)
  return vsixPath
}

/** Upload a vsix file in two chunks and install it. */
async function installVsixFile(
  vsixPath: string,
  expected: { identifier: string; version: string },
): Promise<void> {
  const bytes = await readFile(vsixPath)
  const half = Math.floor(bytes.length / 2)
  const uploadId = await svc.uploadBegin()
  await svc.uploadChunk(uploadId, bytes.subarray(0, half))
  await svc.uploadChunk(uploadId, bytes.subarray(half))
  await svc.installUploaded(uploadId, expected, { source: 'vsix' })
}

describe('RemoteExtensionManagementService', () => {
  it('round-trips upload → install → list → enablement → uninstall', async () => {
    expect(await svc.listInstalled()).toEqual([])

    const vsix = await makeVsix('sample', manifest())
    await installVsixFile(vsix, { identifier: 'acme.sample', version: '1.0.0' })

    const installed = await svc.listInstalled()
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({
      identifier: 'acme.sample',
      version: '1.0.0',
      source: 'vsix',
    })
    // DTO must not leak the server-side location.
    expect(JSON.stringify(installed[0])).not.toContain('user-extensions')
    // Installed into the shared single-source-of-truth dir.
    expect(
      await exists(
        path.join(resolveUserExtensionsDir(dataDir), 'acme.sample-1.0.0', 'package.json'),
      ),
    ).toBe(true)

    // Enablement round-trip: default enabled → disable → disabled ids → re-enable.
    expect(await svc.getDisabledIds()).toEqual([])
    await svc.setEnablement('acme.sample', false)
    expect(await svc.getDisabledIds()).toEqual(['acme.sample'])
    await svc.setEnablement('acme.sample', true)
    expect(await svc.getDisabledIds()).toEqual([])

    // Icon: no manifest icon → ''.
    expect(await svc.getIcon('acme.sample')).toBe('')

    expect(await svc.uninstall('acme.sample')).toBe(true)
    expect(await svc.listInstalled()).toEqual([])
    expect(await svc.uninstall('acme.sample')).toBe(false)
  })

  it('rejects an upload whose manifest does not match expected and cleans the temp file', async () => {
    const vsix = await makeVsix('sample', manifest())
    const bytes = await readFile(vsix)
    const uploadId = await svc.uploadBegin()
    const tmpVsix = path.join(dataDir, 'tmp', `${uploadId}.vsix`)
    await svc.uploadChunk(uploadId, bytes)

    await expect(
      svc.installUploaded(
        uploadId,
        { identifier: 'other.id', version: '9.9.9' },
        { source: 'vsix' },
      ),
    ).rejects.toThrow(/does not match expected/)

    expect(await exists(tmpVsix)).toBe(false)
    expect(await svc.listInstalled()).toEqual([])
  })

  it('uploadAbort drops the in-flight temp file', async () => {
    const uploadId = await svc.uploadBegin()
    const tmpVsix = path.join(dataDir, 'tmp', `${uploadId}.vsix`)
    await svc.uploadChunk(uploadId, new Uint8Array([1, 2, 3]))
    expect(await exists(tmpVsix)).toBe(true)

    await svc.uploadAbort(uploadId)
    expect(await exists(tmpVsix)).toBe(false)
    await expect(svc.uploadChunk(uploadId, new Uint8Array([4]))).rejects.toThrow(/unknown upload/)
  })

  it('dispose cleans in-flight upload temp files', async () => {
    const uploadId = await svc.uploadBegin()
    const tmpVsix = path.join(dataDir, 'tmp', `${uploadId}.vsix`)
    await svc.uploadChunk(uploadId, new Uint8Array([1, 2, 3]))
    expect(await exists(tmpVsix)).toBe(true)

    svc.dispose()
    expect(await exists(tmpVsix)).toBe(false)
  })

  it('serves the extension icon as a data URL', async () => {
    const vsix = await makeVsix(
      'iconed',
      manifest({ files: ['dist', 'media/icon.png'], icon: 'media/icon.png' }),
      Buffer.from('fakepng'),
    )
    await installVsixFile(vsix, { identifier: 'acme.sample', version: '1.0.0' })

    const icon = await svc.getIcon('acme.sample')
    expect(icon).toBe(`data:image/png;base64,${Buffer.from('fakepng').toString('base64')}`)
  })

  it('leaves no temp files after a successful install', async () => {
    const vsix = await makeVsix('sample', manifest())
    await installVsixFile(vsix, { identifier: 'acme.sample', version: '1.0.0' })
    expect(await readdir(path.join(dataDir, 'tmp'))).toEqual([])
  })

  it('rejects an oversized upload chunk', async () => {
    const uploadId = await svc.uploadBegin()
    const big = new Uint8Array(4 * 1024 * 1024 + 1)
    await expect(svc.uploadChunk(uploadId, big)).rejects.toThrow(/too large/)
  })

  it('rejects an invalid install source', async () => {
    const vsix = await makeVsix('sample', manifest())
    const bytes = await readFile(vsix)
    const uploadId = await svc.uploadBegin()
    await svc.uploadChunk(uploadId, bytes)

    await expect(
      svc.installUploaded(
        uploadId,
        { identifier: 'acme.sample', version: '1.0.0' },
        { source: 'bogus' as 'vsix' },
      ),
    ).rejects.toThrow(/invalid install source/)
    expect(await svc.listInstalled()).toEqual([])
  })

  it('rejects an invalid locale', async () => {
    const vsix = await makeVsix('sample', manifest())
    const bytes = await readFile(vsix)
    const uploadId = await svc.uploadBegin()
    await svc.uploadChunk(uploadId, bytes)

    await expect(
      svc.installUploaded(
        uploadId,
        { identifier: 'acme.sample', version: '1.0.0' },
        { source: 'vsix', locale: '../etc/passwd' },
      ),
    ).rejects.toThrow(/invalid locale/)
    expect(await svc.listInstalled()).toEqual([])
  })

  it('serializes writes across two connections sharing a dataDir', async () => {
    await installVsixFile(await makeVsix('sample', manifest()), {
      identifier: 'acme.sample',
      version: '1.0.0',
    })
    const svc2 = new RemoteExtensionManagementService({ dataDir, loggerService })
    try {
      const ids = Array.from({ length: 8 }, (_, i) => `ext.${i}`)
      await Promise.all([
        ...ids.slice(0, 4).map((id) => svc.setEnablement(id, false)),
        ...ids.slice(4).map((id) => svc2.setEnablement(id, false)),
      ])

      expect(new Set(await svc.getDisabledIds())).toEqual(new Set(ids))
      // The installed record survived the concurrent enablement writes.
      expect(await svc.listInstalled()).toHaveLength(1)
    } finally {
      svc2.dispose()
    }
  })

  it('sweeps .obsolete marks and stale temp vsix on startup, keeping fresh uploads', async () => {
    const extDir = resolveUserExtensionsDir(dataDir)
    const stale = path.join(extDir, 'gone-1.0.0')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(extDir, '.obsolete'), JSON.stringify({ 'gone-1.0.0': true }))

    const tmpDir = path.join(dataDir, 'tmp')
    await mkdir(tmpDir, { recursive: true })
    const oldVsix = path.join(tmpDir, 'old.vsix')
    await writeFile(oldVsix, 'x')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(oldVsix, old, old)
    const freshVsix = path.join(tmpDir, 'fresh.vsix')
    await writeFile(freshVsix, 'y')

    const svc2 = new RemoteExtensionManagementService({ dataDir, loggerService })
    try {
      await svc2.whenStartupSweepSettled
      expect(await exists(stale)).toBe(false)
      expect(await exists(path.join(extDir, '.obsolete'))).toBe(false)
      expect(await exists(oldVsix)).toBe(false)
      expect(await exists(freshVsix)).toBe(true)
    } finally {
      svc2.dispose()
    }
  })
})

describe('serverPaths', () => {
  it('resolves the user-extensions and global-storage dirs under the data dir', () => {
    expect(resolveUserExtensionsDir(dataDir)).toBe(path.join(dataDir, 'user-extensions'))
    expect(resolveExtensionGlobalStorageDir(dataDir)).toBe(
      path.join(dataDir, 'data', 'extensionGlobalStorage'),
    )
  })
})
