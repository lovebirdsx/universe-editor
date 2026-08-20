/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for apps/editor/src/main/services/extensionManagement/extensionManagementService.ts
 *  remote-authority routing: an `authority` on the management methods routes through
 *  the ExtensionManagement channel of the remote connection (chunked upload + remote
 *  install), keeping download/signature/anti-poisoning verification local.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { Event, RemoteChannels } from '@universe-editor/platform'
import { hashVsixFile } from '@universe-editor/extension-packaging'
import type {
  IRemoteExtensionManagementService,
  IRemoteInstalledExtension,
  IRemoteInstallOptions,
} from '@universe-editor/node-services'
import type {
  IGalleryExtension,
  IGalleryExtensionVersion,
} from '@universe-editor/extension-gallery'
import {
  ExtensionManagementMainService,
  type IManagementGallery,
} from '../extensionManagementService.js'
import type { IRemoteConnectionService } from '../../remote/remoteConnectionMainService.js'

const HOST_API = '0.1.0'
const CHUNK = 1024 * 1024

const TEST_KEY_ID = 'market-test'
const TEST_KEY_PAIR = generateKeyPairSync('ed25519')
const TEST_PUBLIC_KEYS = {
  [TEST_KEY_ID]: TEST_KEY_PAIR.publicKey.export({ format: 'jwk' }).x as string,
}

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

async function makeVsix(dir: string, name: string, m: Record<string, unknown>): Promise<string> {
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(m)))
  zip.addFile('extension/dist/extension.js', Buffer.from('module.exports={}'))
  const p = path.join(dir, name)
  await writeFile(p, zip.toBuffer())
  return p
}

/** A VSIX whose zip payload is incompressible, so the file is larger than `size` bytes. */
async function makeLargeVsix(dir: string, name: string, size: number): Promise<string> {
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest())))
  zip.addFile('extension/dist/extension.js', Buffer.from('module.exports={}'))
  zip.addFile('extension/dist/large.bin', randomBytes(size))
  const p = path.join(dir, name)
  await writeFile(p, zip.toBuffer())
  return p
}

async function signedByTestKey(vsixPath: string): Promise<{
  vsixHash: string
  vsixSignature: { algorithm: string; keyId: string; value: string }
}> {
  const bytes = await readFile(vsixPath)
  return {
    vsixHash: await hashVsixFile(vsixPath),
    vsixSignature: {
      algorithm: 'ed25519',
      keyId: TEST_KEY_ID,
      value: sign(null, bytes, TEST_KEY_PAIR.privateKey).toString('base64'),
    },
  }
}

function galleryExt(overrides: Record<string, unknown> = {}): IGalleryExtension {
  const base: Record<string, unknown> = {
    identifier: 'acme.sample',
    name: 'sample',
    publisher: 'acme',
    displayName: 'Sample',
    description: '',
    version: '1.0.0',
    vsixUrl: 'https://host/sample.vsix',
    ...overrides,
  }
  return {
    ...base,
    versions: [
      {
        version: base.version,
        vsixUrl: base.vsixUrl,
        ...(base.vsixHash !== undefined ? { vsixHash: base.vsixHash } : {}),
        ...(base.vsixSignature !== undefined ? { vsixSignature: base.vsixSignature } : {}),
        ...(base.engineConstraint !== undefined ? { engineConstraint: base.engineConstraint } : {}),
      } as IGalleryExtensionVersion,
    ],
  } as IGalleryExtension
}

function remoteExt(
  identifier: string,
  version: string,
  source: 'vsix' | 'gallery' = 'vsix',
): IRemoteInstalledExtension {
  return {
    identifier,
    version,
    manifest: { name: 'x', version } as IRemoteInstalledExtension['manifest'],
    source,
    installedAt: 123,
  }
}

interface UploadedChunk {
  uploadId: string
  chunk: Uint8Array
}

class FakeRemoteExtensionManagementService implements IRemoteExtensionManagementService {
  declare readonly _serviceBrand: undefined
  installed: IRemoteInstalledExtension[] = []
  disabledIds: string[] = []
  iconById = new Map<string, string>()
  failInstall = false

  listInstalledCalls = 0
  uploadBegins: string[] = []
  uploadChunks: UploadedChunk[] = []
  aborted: string[] = []
  installUploadedCalls: Array<{
    uploadId: string
    expected: { identifier: string; version: string }
    options: IRemoteInstallOptions
  }> = []
  uninstallCalls: string[] = []
  setEnablementCalls: Array<{ identifier: string; enabled: boolean }> = []
  private _seq = 0

  async listInstalled(): Promise<IRemoteInstalledExtension[]> {
    this.listInstalledCalls++
    return this.installed
  }

  async uploadBegin(): Promise<string> {
    const id = `up-${this._seq++}`
    this.uploadBegins.push(id)
    return id
  }

  async uploadChunk(uploadId: string, chunk: Uint8Array): Promise<void> {
    this.uploadChunks.push({ uploadId, chunk })
  }

  async uploadAbort(uploadId: string): Promise<void> {
    this.aborted.push(uploadId)
  }

  async installUploaded(
    uploadId: string,
    expected: { identifier: string; version: string },
    options: IRemoteInstallOptions,
  ): Promise<IRemoteInstalledExtension> {
    this.installUploadedCalls.push({ uploadId, expected, options })
    if (this.failInstall) throw new Error('remote install boom')
    return {
      identifier: expected.identifier,
      version: expected.version,
      manifest: { name: 'x', version: expected.version } as IRemoteInstalledExtension['manifest'],
      source: options.source,
      installedAt: 123,
      ...(options.galleryMetadata ? { galleryMetadata: options.galleryMetadata } : {}),
    }
  }

  async uninstall(identifier: string): Promise<boolean> {
    this.uninstallCalls.push(identifier)
    return true
  }

  async getDisabledIds(): Promise<string[]> {
    return this.disabledIds
  }

  async setEnablement(identifier: string, enabled: boolean): Promise<void> {
    this.setEnablementCalls.push({ identifier, enabled })
  }

  async getIcon(identifier: string): Promise<string> {
    return this.iconById.get(identifier) ?? ''
  }
}

interface Fixture {
  svc: ExtensionManagementMainService
  remote: FakeRemoteExtensionManagementService
  proxyCalls: Array<{ authority: string; channel: string }>
}

let root: string
let services: ExtensionManagementMainService[]

function makeFixture(opts: { gallery?: IManagementGallery } = {}): Fixture {
  const remote = new FakeRemoteExtensionManagementService()
  const proxyCalls: Array<{ authority: string; channel: string }> = []
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getConnection: async () => {
      throw new Error('not used')
    },
    connect: async () => {
      throw new Error('not used')
    },
    openExtensionHostConnection: async () => {
      throw new Error('not used')
    },
    onDidChangeState: Event.None,
    retryConnection: () => undefined,
    stopServer: async () => undefined,
    closeConnection: async () => undefined,
    dropSocketForTesting: () => undefined,
    dropExtensionHostSocketForTesting: () => undefined,
    dispose: () => undefined,
    getServiceProxy: ((authority: string, channelName: string) => {
      proxyCalls.push({ authority, channel: channelName })
      return remote
    }) as IRemoteConnectionService['getServiceProxy'],
  }
  const svc = new ExtensionManagementMainService(
    () => path.join(root, 'extensions'),
    HOST_API,
    opts.gallery,
    undefined,
    undefined,
    undefined,
    TEST_PUBLIC_KEYS,
    connService,
  )
  services.push(svc)
  return { svc, remote, proxyCalls }
}

describe('ExtensionManagementMainService — remote routing', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ext-mgmt-remote-'))
    services = []
  })
  afterEach(async () => {
    for (const svc of services) svc.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('routes getInstalled/getDisabledIds/getLocalIcon through the remote channel, and the local dir without authority', async () => {
    const fixture = makeFixture()
    fixture.remote.installed = [remoteExt('acme.sample', '1.0.0')]
    fixture.remote.disabledIds = ['acme.sample']
    fixture.remote.iconById.set('acme.sample', 'data:image/png;base64,AAAA')

    const remoteList = await fixture.svc.getInstalled('host')
    expect(fixture.remote.listInstalledCalls).toBe(1)
    expect(remoteList).toHaveLength(1)
    expect(remoteList[0]?.identifier).toBe('acme.sample')
    expect(remoteList[0]?.location).toBe('')

    await expect(fixture.svc.getDisabledIds('host')).resolves.toEqual(['acme.sample'])
    await expect(fixture.svc.getLocalIcon('acme.sample', 'host')).resolves.toBe(
      'data:image/png;base64,AAAA',
    )

    // No authority → the (empty) local dir, never the proxy.
    await expect(fixture.svc.getInstalled()).resolves.toEqual([])
    await expect(fixture.svc.getDisabledIds()).resolves.toEqual([])
    expect(fixture.remote.listInstalledCalls).toBe(1)

    expect(fixture.proxyCalls).toEqual([
      { authority: 'host', channel: RemoteChannels.ExtensionManagement },
      { authority: 'host', channel: RemoteChannels.ExtensionManagement },
      { authority: 'host', channel: RemoteChannels.ExtensionManagement },
    ])
  })

  it('splits a >1MiB VSIX into sequential ≤1MiB chunks and installs with the right expected id/version', async () => {
    const fixture = makeFixture()
    const vsixPath = await makeLargeVsix(root, 'large.vsix', 2 * CHUNK + 123)

    const local = await fixture.svc.installVSIX(vsixPath, 'host')
    expect(local.identifier).toBe('acme.sample')
    expect(local.version).toBe('1.0.0')
    expect(local.source).toBe('vsix')

    expect(fixture.remote.uploadBegins).toHaveLength(1)
    const uploadId = fixture.remote.uploadBegins[0]!
    const chunks = fixture.remote.uploadChunks
      .filter((c) => c.uploadId === uploadId)
      .map((c) => c.chunk)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.byteLength <= CHUNK)).toBe(true)

    const original = await readFile(vsixPath)
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c))).equals(original)).toBe(true)

    expect(fixture.remote.installUploadedCalls).toHaveLength(1)
    const call = fixture.remote.installUploadedCalls[0]!
    expect(call.uploadId).toBe(uploadId)
    expect(call.expected).toEqual({ identifier: 'acme.sample', version: '1.0.0' })
    expect(call.options.source).toBe('vsix')
    expect(fixture.remote.aborted).toEqual([])
  })

  it('aborts the upload when the remote install fails', async () => {
    const fixture = makeFixture()
    fixture.remote.failInstall = true
    const vsixPath = await makeLargeVsix(root, 'fail.vsix', CHUNK + 1)

    await expect(fixture.svc.installVSIX(vsixPath, 'host')).rejects.toThrow(
      /Extension operation on host failed/,
    )
    expect(fixture.remote.aborted).toEqual(fixture.remote.uploadBegins)
  })

  it('uploads a verified gallery package and passes gallery metadata', async () => {
    const vsixPath = await makeVsix(root, 'download.vsix', manifest())
    const signing = await signedByTestKey(vsixPath)
    const gallery: IManagementGallery = {
      download: async () => vsixPath,
      getControlManifest: async () => ({ malicious: [] }),
      getExtensions: async () => [],
    }
    const fixture = makeFixture({ gallery })

    const local = await fixture.svc.installFromGallery(galleryExt(signing), 'host')
    expect(local.source).toBe('gallery')
    expect(fixture.remote.installUploadedCalls).toHaveLength(1)
    const call = fixture.remote.installUploadedCalls[0]!
    expect(call.options.source).toBe('gallery')
    expect(call.options.galleryMetadata?.vsixHash).toBe(signing.vsixHash)
    expect(fixture.remote.aborted).toEqual([])
  })

  it('verifies the signature locally and never uploads when it does not match', async () => {
    const vsixPath = await makeVsix(root, 'download.vsix', manifest())
    const gallery: IManagementGallery = {
      download: async () => vsixPath,
      getControlManifest: async () => ({ malicious: [] }),
      getExtensions: async () => [],
    }
    const fixture = makeFixture({ gallery })

    // Advertise signing metadata for a different package's bytes → hash mismatch.
    const other = await makeVsix(root, 'other.vsix', manifest({ name: 'other' }))
    const wrongSigning = await signedByTestKey(other)

    await expect(
      fixture.svc.installFromGallery(galleryExt({ ...wrongSigning, version: '1.0.0' }), 'host'),
    ).rejects.toThrow(/hash mismatch/)
    expect(fixture.remote.uploadBegins).toEqual([])
    expect(fixture.remote.installUploadedCalls).toEqual([])
  })

  it('fires onDidChangeExtensions on remote install/uninstall but not setEnablement', async () => {
    const fixture = makeFixture()
    let changes = 0
    fixture.svc.onDidChangeExtensions(() => changes++)

    const vsixPath = await makeLargeVsix(root, 'sample.vsix', CHUNK + 1)
    await fixture.svc.installVSIX(vsixPath, 'host')
    expect(changes).toBe(1)

    await fixture.svc.uninstall('acme.sample', 'host')
    expect(changes).toBe(2)
    expect(fixture.remote.uninstallCalls).toEqual(['acme.sample'])

    await fixture.svc.setEnablement('acme.sample', false, 'host')
    expect(changes).toBe(2)
    expect(fixture.remote.setEnablementCalls).toEqual([
      { identifier: 'acme.sample', enabled: false },
    ])
  })

  it('checks updates against the remote installed set', async () => {
    const gallery: IManagementGallery = {
      download: async () => {
        throw new Error('not used')
      },
      getControlManifest: async () => ({ malicious: [] }),
      getExtensions: async () => [galleryExt({ version: '2.0.0' })],
    }
    const fixture = makeFixture({ gallery })
    fixture.remote.installed = [remoteExt('acme.sample', '1.0.0', 'gallery')]

    const updates = await fixture.svc.checkForUpdates('host')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      identifier: 'acme.sample',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    })
  })

  it('rejects an authority operation when no connection service is injected', async () => {
    const svc = new ExtensionManagementMainService(
      () => path.join(root, 'extensions'),
      HOST_API,
      undefined,
      undefined,
      undefined,
      undefined,
      TEST_PUBLIC_KEYS,
    )
    services.push(svc)
    await expect(svc.getInstalled('host')).rejects.toThrow(
      /Remote extension management is unavailable for host/,
    )
  })

  it('rejects an engines-incompatible remote install before any upload begins', async () => {
    const fixture = makeFixture()
    const vsixPath = await makeVsix(root, 'bad.vsix', manifest({ engines: { universe: '^9.0.0' } }))

    await expect(fixture.svc.installVSIX(vsixPath, 'host')).rejects.toThrow(/host API is/)
    expect(fixture.remote.uploadBegins).toEqual([])
    expect(fixture.remote.installUploadedCalls).toEqual([])
  })
})
