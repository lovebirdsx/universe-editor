import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import {
  ExtensionManagementMainService,
  type IManagementGallery,
} from '../extensionManagementService.js'

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

/** Write a VSIX file with the given manifest + an entry file, return its path. */
async function makeVsix(dir: string, name: string, m: Record<string, unknown>): Promise<string> {
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(m)))
  zip.addFile('extension/dist/extension.js', Buffer.from('module.exports={}'))
  const p = path.join(dir, name)
  await writeFile(p, zip.toBuffer())
  return p
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('ExtensionManagementMainService', () => {
  let root: string
  let extDir: string
  let svc: ExtensionManagementMainService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ext-mgmt-'))
    extDir = path.join(root, 'extensions')
    svc = new ExtensionManagementMainService(() => extDir, HOST_API)
  })
  afterEach(async () => {
    svc.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('installs a VSIX and lists it', async () => {
    const vsix = await makeVsix(root, 'sample.vsix', manifest())
    const local = await svc.installVSIX(vsix)

    expect(local.identifier).toBe('acme.sample')
    expect(local.version).toBe('1.0.0')
    expect(local.source).toBe('vsix')

    // On disk: <extDir>/acme.sample-1.0.0/package.json + dist/extension.js
    const installedDir = path.join(extDir, 'acme.sample-1.0.0')
    expect(await exists(path.join(installedDir, 'package.json'))).toBe(true)
    expect(await exists(path.join(installedDir, 'dist', 'extension.js'))).toBe(true)

    const list = await svc.getInstalled()
    expect(list).toHaveLength(1)
    expect(list[0]?.identifier).toBe('acme.sample')
  })

  it('fires onDidChangeExtensions on install and uninstall', async () => {
    let changes = 0
    svc.onDidChangeExtensions(() => changes++)

    const vsix = await makeVsix(root, 'sample.vsix', manifest())
    await svc.installVSIX(vsix)
    expect(changes).toBe(1)

    await svc.uninstall('acme.sample')
    expect(changes).toBe(2)
    expect(await svc.getInstalled()).toHaveLength(0)
    expect(await exists(path.join(extDir, 'acme.sample-1.0.0'))).toBe(false)
  })

  it('is idempotent when reinstalling the same id+version', async () => {
    const vsix = await makeVsix(root, 'sample.vsix', manifest())
    await svc.installVSIX(vsix)
    const again = await svc.installVSIX(vsix)
    expect(again.identifier).toBe('acme.sample')
    expect(await svc.getInstalled()).toHaveLength(1)
  })

  it('rejects an extension incompatible with the host API version', async () => {
    const vsix = await makeVsix(root, 'bad.vsix', manifest({ engines: { universe: '^9.0.0' } }))
    await expect(svc.installVSIX(vsix)).rejects.toThrow(/host API is/)
    expect(await svc.getInstalled()).toHaveLength(0)
  })

  it('supports a publisher-less extension (id = name)', async () => {
    const m = manifest()
    delete m.publisher
    const vsix = await makeVsix(root, 'nopub.vsix', m)
    const local = await svc.installVSIX(vsix)
    expect(local.identifier).toBe('sample')
    expect(await exists(path.join(extDir, 'sample-1.0.0'))).toBe(true)
  })

  it('keeps two versions of the same extension side by side', async () => {
    const v1 = await makeVsix(root, 'v1.vsix', manifest({ version: '1.0.0' }))
    const v2 = await makeVsix(root, 'v2.vsix', manifest({ version: '2.0.0' }))
    await svc.installVSIX(v1)
    await svc.installVSIX(v2)
    const list = await svc.getInstalled()
    expect(list.map((l) => l.version).sort()).toEqual(['1.0.0', '2.0.0'])
  })

  it('sweeps obsolete-marked folders on startup', async () => {
    // Simulate a prior uninstall that could not delete the folder (Windows lock):
    // the folder + an .obsolete mark are present.
    const stale = path.join(extDir, 'acme.sample-1.0.0')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'package.json'), '{}')
    await writeFile(path.join(extDir, '.obsolete'), JSON.stringify({ 'acme.sample-1.0.0': true }))

    const svc2 = new ExtensionManagementMainService(() => extDir, HOST_API)
    // Give the fire-and-forget sweep in the ctor a tick to run.
    await new Promise((r) => setTimeout(r, 50))
    expect(await exists(stale)).toBe(false)
    expect(await exists(path.join(extDir, '.obsolete'))).toBe(false)
    svc2.dispose()
  })
})

describe('ExtensionManagementMainService — gallery install', () => {
  let root: string
  let extDir: string

  function galleryExtension(
    overrides: Record<string, unknown> = {},
  ): Parameters<ExtensionManagementMainService['installFromGallery']>[0] {
    return {
      identifier: 'acme.sample',
      name: 'sample',
      publisher: 'acme',
      displayName: 'Sample',
      description: '',
      version: '1.0.0',
      vsixUrl: 'https://host/sample.vsix',
      publisherDisplayName: 'ACME Inc',
      installCount: 42,
      ...overrides,
    } as Parameters<ExtensionManagementMainService['installFromGallery']>[0]
  }

  /** A stub gallery whose download() returns a VSIX built from the given manifest. */
  function stubGallery(
    manifestForDownload: Record<string, unknown>,
    malicious: string[] = [],
  ): IManagementGallery {
    return {
      download: async () => makeVsix(root, `download-${Date.now()}.vsix`, manifestForDownload),
      getControlManifest: async () => ({ malicious }),
      getExtensions: async () => [],
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ext-mgmt-gal-'))
    extDir = path.join(root, 'extensions')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('installs from the gallery and records gallery metadata', async () => {
    const svc = new ExtensionManagementMainService(() => extDir, HOST_API, stubGallery(manifest()))
    const local = await svc.installFromGallery(galleryExtension())
    expect(local.source).toBe('gallery')
    expect(local.galleryMetadata?.publisherDisplayName).toBe('ACME Inc')
    expect(local.galleryMetadata?.installCount).toBe(42)
    expect(local.galleryMetadata?.vsixUrl).toBe('https://host/sample.vsix')

    const list = await svc.getInstalled()
    expect(list[0]?.source).toBe('gallery')
    svc.dispose()
  })

  it('refuses a downloaded package that does not match the gallery entry', async () => {
    // Gallery claims 1.0.0 but the downloaded VSIX is 2.0.0 — poisoning guard.
    const svc = new ExtensionManagementMainService(
      () => extDir,
      HOST_API,
      stubGallery(manifest({ version: '2.0.0' })),
    )
    await expect(svc.installFromGallery(galleryExtension({ version: '1.0.0' }))).rejects.toThrow(
      /does not match the marketplace entry/,
    )
    expect(await svc.getInstalled()).toHaveLength(0)
    svc.dispose()
  })

  it('refuses to install an extension marked malicious', async () => {
    const svc = new ExtensionManagementMainService(
      () => extDir,
      HOST_API,
      stubGallery(manifest(), ['acme.sample']),
    )
    await expect(svc.installFromGallery(galleryExtension())).rejects.toThrow(/malicious/)
    expect(await svc.getInstalled()).toHaveLength(0)
    svc.dispose()
  })

  it('also blocks a local VSIX whose id is marked malicious', async () => {
    const svc = new ExtensionManagementMainService(
      () => extDir,
      HOST_API,
      stubGallery(manifest(), ['acme.sample']),
    )
    const vsix = await makeVsix(root, 'evil.vsix', manifest())
    await expect(svc.installVSIX(vsix)).rejects.toThrow(/malicious/)
    svc.dispose()
  })
})

describe('ExtensionManagementMainService — enablement, quarantine, updates', () => {
  let root: string
  let extDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ext-mgmt-en-'))
    extDir = path.join(root, 'extensions')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('persists disabled state and reports disabled ids', async () => {
    const svc = new ExtensionManagementMainService(() => extDir, HOST_API)
    const vsix = await makeVsix(root, 'sample.vsix', manifest())
    await svc.installVSIX(vsix)

    await svc.setEnablement('acme.sample', false)
    expect(await svc.getDisabledIds()).toEqual(['acme.sample'])

    await svc.setEnablement('acme.sample', true)
    expect(await svc.getDisabledIds()).toEqual([])
    svc.dispose()
  })

  it('preserves disabled state across an unrelated install (writeInstalledRecords keeps enablement)', async () => {
    const svc = new ExtensionManagementMainService(() => extDir, HOST_API)
    await svc.installVSIX(await makeVsix(root, 'a.vsix', manifest({ name: 'a' })))
    await svc.setEnablement('acme.a', false)
    await svc.installVSIX(await makeVsix(root, 'b.vsix', manifest({ name: 'b' })))
    expect(await svc.getDisabledIds()).toEqual(['acme.a'])
    svc.dispose()
  })

  it('quarantines an installed extension that became malicious', async () => {
    let malicious: string[] = []
    const gallery = {
      download: async () => '',
      getControlManifest: async () => ({ malicious }),
      getExtensions: async () => [],
    }
    const svc = new ExtensionManagementMainService(() => extDir, HOST_API, gallery)
    // Install while clean, then the control manifest later flags it malicious.
    await svc.installVSIX(await makeVsix(root, 'sample.vsix', manifest()))
    malicious = ['acme.sample']

    const disabled = await svc.quarantineMalicious()
    expect(disabled).toEqual(['acme.sample'])
    expect(await svc.getDisabledIds()).toEqual(['acme.sample'])
    svc.dispose()
  })

  it('reports available updates for gallery-sourced extensions', async () => {
    const galleryEntry = {
      identifier: 'acme.sample',
      name: 'sample',
      publisher: 'acme',
      displayName: 'Sample',
      description: '',
      version: '2.0.0',
      vsixUrl: 'https://host/sample.vsix',
    }
    const gallery = {
      download: async () => makeVsix(root, `dl-${Date.now()}.vsix`, manifest()),
      getControlManifest: async () => ({ malicious: [] as string[] }),
      getExtensions: async () => [galleryEntry],
    }
    const svc = new ExtensionManagementMainService(() => extDir, HOST_API, gallery)
    // Install a v1 gallery extension first.
    await svc.installFromGallery({ ...galleryEntry, version: '1.0.0' })

    const updates = await svc.checkForUpdates()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      identifier: 'acme.sample',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    })
    svc.dispose()
  })

  it('lists built-in extensions from the built-in dir with source=builtin', async () => {
    const builtinDir = path.join(root, 'builtins')
    const gitDir = path.join(builtinDir, 'git')
    await mkdir(gitDir, { recursive: true })
    await writeFile(
      path.join(gitDir, 'package.json'),
      JSON.stringify(manifest({ name: 'git', publisher: 'universe', displayName: 'Git' })),
    )
    const svc2 = new ExtensionManagementMainService(
      () => extDir,
      HOST_API,
      undefined,
      undefined,
      () => builtinDir,
    )
    const builtins = await svc2.listBuiltinExtensions()
    expect(builtins).toHaveLength(1)
    expect(builtins[0]).toMatchObject({ identifier: 'universe.git', source: 'builtin' })
    svc2.dispose()
  })

  it('returns [] when the built-in dir is absent', async () => {
    const svc2 = new ExtensionManagementMainService(
      () => extDir,
      HOST_API,
      undefined,
      undefined,
      () => path.join(root, 'nonexistent'),
    )
    expect(await svc2.listBuiltinExtensions()).toEqual([])
    svc2.dispose()
  })
})
