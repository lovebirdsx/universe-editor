/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Static asset path resolution for the phone PWA. A request path is decoded
 *  exactly once, then split into segments; any `..`, backslash, NUL, drive
 *  prefix, doubled leading slash, or resolved path outside the asset root is
 *  rejected instead of falling back to index.html. SPA fallback applies only to
 *  ordinary missing paths.
 *--------------------------------------------------------------------------------------------*/

import { basename, extname, resolve, sep } from 'node:path'

export type StaticPathResolution =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'forbidden'; readonly reason: string }

export function resolveStaticPath(
  rootDir: string,
  requestUrl: string | undefined,
): StaticPathResolution {
  const pathname = extractPathname(requestUrl)
  if (pathname === undefined) return { kind: 'forbidden', reason: 'malformed request URL' }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { kind: 'forbidden', reason: 'invalid percent encoding' }
  }

  if (decoded.includes('\0')) return { kind: 'forbidden', reason: 'NUL byte' }
  if (decoded.includes('\\')) return { kind: 'forbidden', reason: 'backslash separator' }
  if (decoded.startsWith('//')) return { kind: 'forbidden', reason: 'absolute path' }
  if (/^[a-zA-Z]:/.test(decoded)) return { kind: 'forbidden', reason: 'drive-letter path' }

  const segments: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { kind: 'forbidden', reason: 'path traversal' }
    if (segment.length > 255) return { kind: 'forbidden', reason: 'path segment too long' }
    segments.push(segment)
  }
  if (segments.length === 0) return { kind: 'fallback' }
  // Windows URL forms such as `/C:/Windows/...` put the drive in the first
  // segment; treat them as absolute paths rather than a directory named `C:`.
  if (/^[a-zA-Z]:$/.test(segments[0] ?? '')) {
    return { kind: 'forbidden', reason: 'drive-letter path' }
  }

  const root = resolve(rootDir)
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + sep)) {
    return { kind: 'forbidden', reason: 'path leaves the asset root' }
  }
  return { kind: 'file', path: target }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** The shell and the service worker must never be served from a stale cache. */
export function isNoCacheAsset(filePath: string): boolean {
  const name = basename(filePath).toLowerCase()
  return name === 'index.html' || name === 'sw.js'
}

export const NOT_BUILT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机端资源未构建</title></head>
<body style="font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem">
<h1>手机端资源未构建</h1>
<p>本机没有找到手机端静态资源。请在仓库中运行 <code>pnpm --filter mobile build</code>，
或设置环境变量 <code>UNIVERSE_MOBILE_ASSETS_DIR</code> 指向构建产物目录。</p>
</body></html>
`

/**
 * Extract the path without going through `URL`, which normalizes `..` away and
 * would turn a traversal attempt into a harmless-looking path. Absolute-form
 * URLs (proxy requests) still need the URL parser.
 */
function extractPathname(rawUrl: string | undefined): string | undefined {
  const raw = rawUrl ?? '/'
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname
    } catch {
      return undefined
    }
  }
  if (!raw.startsWith('/')) return undefined
  const queryStart = raw.search(/[?#]/)
  return queryStart === -1 ? raw : raw.slice(0, queryStart)
}
