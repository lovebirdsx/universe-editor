/**
 * HTTP client for the marketplace publish API (Phase D contract). Thin wrapper
 * over global fetch — the server receives the raw VSIX stream plus a Bearer
 * token, never any client-claimed metadata (it re-reads the manifest itself).
 */
import { UexError } from '../errors.js'
import { GALLERY_API, registerPageUrl } from './galleryApi.js'

export interface GalleryClient {
  publish(vsix: Buffer): Promise<{ id: string; version: string }>
  unpublish(id: string, version: string | null): Promise<void>
  whoami(): Promise<{ publisher: string; status?: string }>
}

export interface GalleryClientOptions {
  readonly baseUrl: string
  readonly token: string
  readonly fetchImpl?: typeof fetch
}

async function request(
  opts: GalleryClientOptions,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${opts.baseUrl}/${path}`
  const fetchImpl = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${opts.token}`, ...init.headers },
    })
  } catch (err) {
    throw new UexError(`could not reach ${opts.baseUrl} (${(err as Error).message})`, [
      'check the registry URL (--registry / UNIVERSE_GALLERY_URL / ~/.uex/config.json)',
      'and that the marketplace server is running',
    ])
  }
  if (!res.ok) {
    throw await toUexError(res, opts.baseUrl)
  }
  return res
}

async function toUexError(res: Response, baseUrl: string): Promise<UexError> {
  const body = await res.text().catch(() => '')
  const detail = body.trim() !== '' ? `: ${body.trim().slice(0, 200)}` : ''
  switch (res.status) {
    case 401:
      return new UexError(`the marketplace rejected the token (401)${detail}`, [
        'run `uex login <publisher>` with a fresh token',
        `no token yet? register a publisher at ${registerPageUrl(baseUrl)}`,
      ])
    case 403: {
      // 审批制：pending 的 403 不是 publisher 拼错，单独给等待审批的指引
      if (/pending approval/.test(body)) {
        return new UexError(`publisher pending approval (403)${detail}`, [
          'your registration is awaiting admin approval — publishing unlocks once approved',
          'check the status anytime with `uex whoami`',
        ])
      }
      return new UexError(`publisher mismatch (403)${detail}`, [
        'the VSIX manifest publisher must equal the publisher your token belongs to',
      ])
    }
    case 409:
      return new UexError(`version already exists (409)${detail}`, [
        'versions are immutable — bump "version" in package.json and publish again',
      ])
    case 413:
      return new UexError(`the VSIX exceeds the server size limit (413)${detail}`, [
        'shrink the extension payload (the whitelist in "files" controls what ships)',
      ])
    default:
      return new UexError(`publish request failed (${res.status})${detail}`)
  }
}

export function createGalleryClient(opts: GalleryClientOptions): GalleryClient {
  return {
    async publish(vsix) {
      const res = await request(opts, GALLERY_API.publish, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(vsix.byteLength),
        },
        body: new Uint8Array(vsix),
      })
      return (await res.json()) as { id: string; version: string }
    },
    async unpublish(id, version) {
      await request(opts, GALLERY_API.unpublish, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, version }),
      })
    },
    async whoami() {
      const res = await request(opts, GALLERY_API.whoami, { method: 'GET' })
      return (await res.json()) as { publisher: string; status?: string }
    },
  }
}
