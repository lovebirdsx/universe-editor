import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { AssetType } from '@universe-editor/extension-gallery'
import type { IGalleryExtension } from '@universe-editor/extension-gallery'
import { ExtensionGalleryMainService } from '../extensionGalleryService.js'

const realFetch = globalThis.fetch

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers(),
  } as unknown as Response
}

function galleryExtension(overrides: Partial<IGalleryExtension> = {}): IGalleryExtension {
  return {
    identifier: 'acme.demo',
    name: 'demo',
    publisher: 'acme',
    displayName: 'Demo',
    description: '',
    version: '1.0.0',
    vsixUrl: 'https://host/demo.vsix',
    ...overrides,
  }
}

describe('ExtensionGalleryMainService', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'ext-gallery-'))
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('is disabled when no gallery url is configured', async () => {
    const svc = new ExtensionGalleryMainService({ galleryUrl: undefined }, cacheDir)
    expect(await svc.isEnabled()).toBe(false)
    expect(await svc.query({ text: 'x' })).toEqual({ extensions: [], total: 0 })
    expect(await svc.getExtensions(['a.b'])).toEqual([])
    expect(await svc.getControlManifest()).toEqual({ malicious: [], deprecated: {} })
  })

  it('posts /extensionquery and parses the result when enabled', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        results: [
          {
            extensions: [
              {
                extensionName: 'demo',
                displayName: 'Demo',
                publisher: { publisherName: 'acme' },
                versions: [
                  {
                    version: '1.2.3',
                    files: [{ assetType: AssetType.Vsix, source: 'https://host/demo.vsix' }],
                  },
                ],
              },
            ],
            resultMetadata: [
              { metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: 7 }] },
            ],
          },
        ],
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const svc = new ExtensionGalleryMainService(
      { galleryUrl: 'https://market.example.com/' },
      cacheDir,
    )
    expect(await svc.isEnabled()).toBe(true)

    const result = await svc.query({ text: 'demo' })
    expect(result.total).toBe(7)
    expect(result.extensions[0]?.identifier).toBe('acme.demo')

    const call = fetchMock.mock.calls[0]!
    // Trailing slash is trimmed; no double slash.
    expect(call[0]).toBe('https://market.example.com/extensionquery')
    expect(call[1]?.method).toBe('POST')
  })

  it('returns empty on a network failure instead of throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const svc = new ExtensionGalleryMainService({ galleryUrl: 'https://x' }, cacheDir)
    expect(await svc.query({ text: 'demo' })).toEqual({ extensions: [], total: 0 })
  })

  it('downloads a vsix into the cache and reuses it on a second call', async () => {
    const fetchMock = vi.fn(async () => {
      const res = jsonResponse('')
      ;(res as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () =>
        new Uint8Array([1, 2, 3]).buffer
      return res
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const svc = new ExtensionGalleryMainService({ galleryUrl: 'https://x' }, cacheDir)
    const ext = galleryExtension()
    const file = await svc.download(ext)
    expect(path.basename(file)).toBe('acme.demo-1.0.0.vsix')
    expect(Array.from(await readFile(file))).toEqual([1, 2, 3])

    const file2 = await svc.download(ext)
    expect(file2).toBe(file)
    expect(fetchMock).toHaveBeenCalledTimes(1) // second call was a cache hit
  })

  it('normalizes an untrusted control.json', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        malicious: ['evil.ext', 123],
        deprecated: { 'old.ext': { reason: 'stale', migrateTo: 'new.ext' }, 'bare.ext': null },
      }),
    ) as unknown as typeof fetch

    const svc = new ExtensionGalleryMainService({ galleryUrl: 'https://x' }, cacheDir)
    const control = await svc.getControlManifest()
    expect(control.malicious).toEqual(['evil.ext'])
    expect(control.deprecated['old.ext']).toEqual({ reason: 'stale', migrateTo: 'new.ext' })
    expect(control.deprecated['bare.ext']).toEqual({})
  })
})
