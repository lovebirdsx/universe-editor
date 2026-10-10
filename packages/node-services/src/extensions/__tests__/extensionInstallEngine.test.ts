/*---------------------------------------------------------------------------------------------
 *  Electron-free install engine tests. Covers the seven-step install, the
 *  vsix/gallery idempotency split, the uninstall obsolete fallback + sweep, the
 *  enablement-preservation red line, and manifest NLS localization. VSIX fixtures
 *  are built with extension-packaging's createVsix (no adm-zip dependency here).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { writeFile, mkdir, stat, readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { createVsix } from '@universe-editor/extension-packaging'
import {
  installVsix,
  listInstalledExtensions,
  reconcileInstalledRecords,
  sweepObsolete,
  uninstallExtension,
} from '../extensionInstallEngine.js'
import {
  readEnablement,
  readInstalledRecords,
  readObsolete,
  writeEnablement,
  writeInstalledRecords,
} from '../installedExtensionsManifest.js'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

const HOST_API = '0.1.0'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sample',
    publisher: 'acme',
    version: '1.0.0',
    engines: { universe: '^0.1.0' },
    main: 'dist/extension.js',
    contributes: { commands: [{ command: 'sample.hello', title: 'Sample: Hello' }] },
    ...overrides,
  }
}

/** Write an extension dir (package.json + entry) and pack it into a VSIX. */
async function makeVsix(
  root: string,
  name: string,
  m: Record<string, unknown>,
  entrySource = 'module.exports={}',
): Promise<string> {
  const extDir = path.join(root, name)
  await mkdir(path.join(extDir, 'dist'), { recursive: true })
  await writeFile(path.join(extDir, 'package.json'), JSON.stringify(m))
  await writeFile(path.join(extDir, 'dist', 'extension.js'), entrySource)
  const vsixPath = path.join(root, `${name}.vsix`)
  await createVsix(extDir, vsixPath)
  return vsixPath
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function erroring(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation not permitted, rename`) as NodeJS.ErrnoException
  err.code = code
  return err
}

/** Legacy state: two versions of one id recorded with both folders on disk. */
async function seedDuplicateVersions(extDir: string): Promise<void> {
  await mkdir(path.join(extDir, 'acme.sample-1.0.0'), { recursive: true })
  await mkdir(path.join(extDir, 'acme.sample-2.0.0'), { recursive: true })
  await writeInstalledRecords(extDir, [
    {
      identifier: 'acme.sample',
      version: '1.0.0',
      location: 'acme.sample-1.0.0',
      source: 'gallery',
      installedAt: 1,
    },
    {
      identifier: 'acme.sample',
      version: '2.0.0',
      location: 'acme.sample-2.0.0',
      source: 'gallery',
      installedAt: 2,
    },
  ])
}

/** Extension folders among directory entries, ignoring the manifest + markers. */
function installedFolders(entries: readonly string[]): string[] {
  return entries.filter((name) => name.startsWith('acme.sample-')).sort()
}

describe('extensionInstallEngine', () => {
  let root: string
  let extDir: string

  beforeEach(async () => {
    root = mkTempDir('ext-engine-')
    extDir = path.join(root, 'extensions')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    removeDirWithRetry(root)
  })

  it('installs a VSIX through the seven-step flow and lists it', async () => {
    const vsix = await makeVsix(root, 'sample', manifest())
    const installed = await installVsix(extDir, vsix, { source: 'vsix', hostApiVersion: HOST_API })

    expect(installed.record.identifier).toBe('acme.sample')
    expect(installed.record.version).toBe('1.0.0')
    expect(installed.record.source).toBe('vsix')
    expect(installed.location).toBe(path.join(extDir, 'acme.sample-1.0.0'))

    expect(await exists(path.join(extDir, 'acme.sample-1.0.0', 'package.json'))).toBe(true)
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0', 'dist', 'extension.js'))).toBe(true)

    const list = await listInstalledExtensions(extDir)
    expect(list).toHaveLength(1)
    expect(list[0]?.record.identifier).toBe('acme.sample')
    expect(list[0]?.manifest.version).toBe('1.0.0')
  })

  it('rejects an extension incompatible with the host API version', async () => {
    const vsix = await makeVsix(root, 'bad', manifest({ engines: { universe: '^9.0.0' } }))
    await expect(
      installVsix(extDir, vsix, { source: 'vsix', hostApiVersion: HOST_API }),
    ).rejects.toThrow(/host API is/)
    expect(await listInstalledExtensions(extDir)).toHaveLength(0)
  })

  it('skips the engine check when hostApiVersion is undefined (remote install)', async () => {
    const vsix = await makeVsix(root, 'bad', manifest({ engines: { universe: '^9.0.0' } }))
    const installed = await installVsix(extDir, vsix, { source: 'vsix' })
    expect(installed.record.identifier).toBe('acme.sample')
  })

  it('is idempotent for a local vsix reinstall of the same id+version', async () => {
    const vsix = await makeVsix(root, 'sample', manifest())
    await installVsix(extDir, vsix, { source: 'vsix', hostApiVersion: HOST_API })
    const again = await installVsix(extDir, vsix, { source: 'vsix', hostApiVersion: HOST_API })
    expect(again.record.identifier).toBe('acme.sample')
    expect(await listInstalledExtensions(extDir)).toHaveLength(1)
  })

  it('gallery source overwrites the on-disk contents on reinstall', async () => {
    await installVsix(extDir, await makeVsix(root, 'a', manifest(), 'OLD-BITS'), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    const entryPath = path.join(extDir, 'acme.sample-1.0.0', 'dist', 'extension.js')
    expect(await readFile(entryPath, 'utf8')).toBe('OLD-BITS')

    await installVsix(extDir, await makeVsix(root, 'b', manifest(), 'NEW-BITS'), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    expect(await readFile(entryPath, 'utf8')).toBe('NEW-BITS')
    expect(await listInstalledExtensions(extDir)).toHaveLength(1)
  })

  it('an upgrade replaces the superseded version record and folder', async () => {
    await installVsix(extDir, await makeVsix(root, 'v1', manifest()), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    await installVsix(extDir, await makeVsix(root, 'v2', manifest({ version: '2.0.0' })), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })

    expect((await readInstalledRecords(extDir)).map((r) => r.version)).toEqual(['2.0.0'])
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(false)
    expect(await exists(path.join(extDir, 'acme.sample-2.0.0'))).toBe(true)
    expect(await listInstalledExtensions(extDir)).toHaveLength(1)
  })

  it('an upgrade preserves the identifier disablement', async () => {
    await installVsix(extDir, await makeVsix(root, 'v1', manifest()), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    await writeEnablement(extDir, { 'acme.sample': false })
    await installVsix(extDir, await makeVsix(root, 'v2', manifest({ version: '2.0.0' })), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    expect(await readEnablement(extDir)).toEqual({ 'acme.sample': false })
  })

  it('a same-version reinstall reclaims a lingering older version', async () => {
    await seedDuplicateVersions(extDir)

    await installVsix(extDir, await makeVsix(root, 'v2', manifest({ version: '2.0.0' })), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })

    expect((await readInstalledRecords(extDir)).map((r) => r.version)).toEqual(['2.0.0'])
    expect(installedFolders(await readdir(extDir))).toEqual(['acme.sample-2.0.0'])
  })

  it('marks a locked superseded folder obsolete during an upgrade, then sweeps it', async () => {
    await installVsix(extDir, await makeVsix(root, 'v1', manifest()), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    const realRename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('.vsctmp')) throw erroring('EPERM')
      return realRename(from, to)
    })

    await installVsix(extDir, await makeVsix(root, 'v2', manifest({ version: '2.0.0' })), {
      source: 'gallery',
      hostApiVersion: HOST_API,
    })
    vi.restoreAllMocks()

    expect((await readInstalledRecords(extDir)).map((r) => r.version)).toEqual(['2.0.0'])
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(true)
    expect(await readObsolete(extDir)).toEqual({ 'acme.sample-1.0.0': true })

    await sweepObsolete(extDir)
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(false)
  })

  it('reconciles duplicate records down to the newest version', async () => {
    await seedDuplicateVersions(extDir)
    await writeEnablement(extDir, { 'acme.sample': false })

    await reconcileInstalledRecords(extDir)

    expect((await readInstalledRecords(extDir)).map((r) => r.version)).toEqual(['2.0.0'])
    expect(installedFolders(await readdir(extDir))).toEqual(['acme.sample-2.0.0'])
    expect(await readEnablement(extDir)).toEqual({ 'acme.sample': false })
  })

  it('leaves a single-version install untouched when reconciling', async () => {
    await installVsix(extDir, await makeVsix(root, 'v1', manifest()), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })
    await reconcileInstalledRecords(extDir)
    expect((await readInstalledRecords(extDir)).map((r) => r.version)).toEqual(['1.0.0'])
  })

  it('uninstall removes the record and folder, returning true', async () => {
    await installVsix(extDir, await makeVsix(root, 'sample', manifest()), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })
    expect(await uninstallExtension(extDir, 'acme.sample')).toBe(true)
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(false)
    expect(await readInstalledRecords(extDir)).toEqual([])
    const leftovers = (await readdir(extDir)).filter((n) => n.endsWith('.vsctmp'))
    expect(leftovers).toEqual([])
  })

  it('uninstall of a non-installed identifier returns false', async () => {
    expect(await uninstallExtension(extDir, 'not.installed')).toBe(false)
  })

  it('uninstall removes every folder of a duplicated identifier', async () => {
    await seedDuplicateVersions(extDir)

    expect(await uninstallExtension(extDir, 'acme.sample')).toBe(true)
    expect(await readInstalledRecords(extDir)).toEqual([])
    expect(installedFolders(await readdir(extDir))).toEqual([])
  })

  it('falls back to an obsolete mark when the folder rename fails, then sweeps it', async () => {
    await installVsix(extDir, await makeVsix(root, 'sample', manifest()), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })
    const realRename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('.vsctmp')) throw erroring('EPERM')
      return realRename(from, to)
    })

    expect(await uninstallExtension(extDir, 'acme.sample')).toBe(true)
    vi.restoreAllMocks()

    // Record gone, folder still present (locked), obsolete mark written.
    expect(await readInstalledRecords(extDir)).toEqual([])
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(true)
    expect(await readObsolete(extDir)).toEqual({ 'acme.sample-1.0.0': true })

    // Startup sweep removes the folder + clears the mark.
    await sweepObsolete(extDir)
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(false)
    expect(await readObsolete(extDir)).toEqual({})
  })

  it('installing another extension preserves an unrelated disable (writeInstalledRecords round-trip)', async () => {
    await installVsix(extDir, await makeVsix(root, 'a', manifest({ name: 'a' })), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })
    await writeEnablement(extDir, { 'acme.a': false })
    await installVsix(extDir, await makeVsix(root, 'b', manifest({ name: 'b' })), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })
    expect(await readEnablement(extDir)).toEqual({ 'acme.a': false })
  })

  it('sweeps leftover .vsctmp folders', async () => {
    await mkdir(path.join(extDir, 'stale-1.0.0.abc.vsctmp'), { recursive: true })
    await mkdir(path.join(extDir, 'keep-1.0.0'), { recursive: true })
    await sweepObsolete(extDir)
    expect((await readdir(extDir)).sort()).toEqual(['keep-1.0.0'])
  })

  it('localizes %key% manifest placeholders against package.nls.json', async () => {
    const loc = 'universe.theme-x-1.0.0'
    const folder = path.join(extDir, loc)
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, 'package.json'),
      JSON.stringify(
        manifest({
          name: 'theme-x',
          publisher: 'universe',
          displayName: '%displayName%',
          description: '%description%',
          main: undefined,
        }),
      ),
    )
    await writeFile(
      path.join(folder, 'package.nls.json'),
      JSON.stringify({ displayName: 'X Theme', description: 'The X theme' }),
    )
    await writeInstalledRecords(extDir, [
      {
        identifier: 'universe.theme-x',
        version: '1.0.0',
        location: loc,
        source: 'vsix',
        installedAt: 0,
      },
    ])

    const list = await listInstalledExtensions(extDir)
    expect(list).toHaveLength(1)
    expect(list[0]?.manifest.displayName).toBe('X Theme')
    expect(list[0]?.manifest.description).toBe('The X theme')
  })

  it('uninstall succeeds when the folder is already gone (ENOENT)', async () => {
    await installVsix(extDir, await makeVsix(root, 'sample', manifest()), {
      source: 'vsix',
      hostApiVersion: HOST_API,
    })
    removeDirWithRetry(path.join(extDir, 'acme.sample-1.0.0'))

    expect(await uninstallExtension(extDir, 'acme.sample')).toBe(true)
    expect(await readInstalledRecords(extDir)).toEqual([])
    expect(await exists(path.join(extDir, '.obsolete'))).toBe(false)
  })

  it('rejects a manifest whose id/version is not a valid folder name', async () => {
    const vsix = await makeVsix(root, 'evil', manifest({ name: 'a/../b' }))
    await expect(installVsix(extDir, vsix, { source: 'vsix' })).rejects.toThrow(
      /not a valid folder name/,
    )
    expect(await listInstalledExtensions(extDir)).toHaveLength(0)
  })
})
