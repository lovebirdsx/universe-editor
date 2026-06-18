import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}))

const { RemoteSchemaMainService } = await import('../remoteSchemaMainService.js')

let cacheDir: string
const URL = 'https://json.schemastore.org/claude-code-settings.json'

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(join(tmpdir(), 'ue-schema-cache-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(cacheDir, { recursive: true, force: true })
})

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers()
  if (init.etag) headers.set('etag', init.etag)
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

describe('RemoteSchemaMainService', () => {
  it('downloads, caches, and returns a 200 schema', async () => {
    stubFetch(async () => jsonResponse({ type: 'object' }, { etag: '"v1"' }))
    const svc = new RemoteSchemaMainService(cacheDir)

    const res = await svc.fetchSchema(URL)
    expect(res).toEqual({ ok: true, content: JSON.stringify({ type: 'object' }) })

    const files = await fs.readdir(cacheDir)
    expect(files).toHaveLength(1)
  })

  it('serves the cache without hitting the network inside the TTL window', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ type: 'object' }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new RemoteSchemaMainService(cacheDir)

    await svc.fetchSchema(URL)
    await svc.fetchSchema(URL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns the cached copy on a 304 revalidation', async () => {
    let call = 0
    stubFetch(async (_url, init) => {
      call++
      if (call === 1) return jsonResponse({ type: 'object', v: 1 }, { etag: '"v1"' })
      expect((init?.headers as Record<string, string>)['If-None-Match']).toBe('"v1"')
      return new Response(null, { status: 304 })
    })
    await new RemoteSchemaMainService(cacheDir).fetchSchema(URL)

    // A fresh instance reads the cache from disk; age it so the TTL forces revalidation.
    await ageCache(cacheDir)
    const res = await new RemoteSchemaMainService(cacheDir).fetchSchema(URL)
    expect(res).toEqual({ ok: true, content: JSON.stringify({ type: 'object', v: 1 }) })
  })

  it('falls back to the stale cache when the network fails', async () => {
    let call = 0
    stubFetch(async () => {
      call++
      if (call === 1) return jsonResponse({ type: 'object', v: 1 })
      throw new Error('offline')
    })
    await new RemoteSchemaMainService(cacheDir).fetchSchema(URL)

    await ageCache(cacheDir)
    const res = await new RemoteSchemaMainService(cacheDir).fetchSchema(URL)
    expect(res).toEqual({ ok: true, content: JSON.stringify({ type: 'object', v: 1 }) })
  })

  it('errors when the response is not valid JSON and no cache exists', async () => {
    stubFetch(async () => new Response('<html>captive portal</html>', { status: 200 }))
    const svc = new RemoteSchemaMainService(cacheDir)

    const res = await svc.fetchSchema(URL)
    expect(res.ok).toBe(false)
  })

  it('errors when the network fails and no cache exists', async () => {
    stubFetch(async () => {
      throw new Error('offline')
    })
    const svc = new RemoteSchemaMainService(cacheDir)

    const res = await svc.fetchSchema(URL)
    expect(res).toEqual({ ok: false, error: 'offline' })
  })
})

/** Age every cache file past the TTL so the next fetch revalidates. */
async function ageCache(dir: string): Promise<void> {
  for (const file of await fs.readdir(dir)) {
    const path = join(dir, file)
    const entry = JSON.parse(await fs.readFile(path, 'utf8')) as { fetchedAt: number }
    entry.fetchedAt = 0
    await fs.writeFile(path, JSON.stringify(entry), 'utf8')
  }
}
