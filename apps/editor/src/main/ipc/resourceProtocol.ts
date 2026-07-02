/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Private `universe-app://` protocol — our equivalent of VSCode's `vscode-file`.
 *
 *  A single custom scheme serves BOTH the app shell and local resources under ONE
 *  origin (authority `root`), split by a path prefix — because a page cannot
 *  fetch/embed a *different* custom scheme or a different authority of a secure
 *  scheme (Chromium blocks the request before it reaches the handler), so both the
 *  shell and its resources must share the exact same origin:
 *
 *    universe-app://root/<path>               → out/renderer/<path>   (shell + assets)
 *    universe-app://root/_resource_/<abs-path> → an arbitrary local file, IF it lives
 *                                            under a directory the renderer has
 *                                            allow-listed (workspace root + the
 *                                            markdown document's own dir). Mirrors
 *                                            VSCode's localResourceRoots.
 *
 *  In dev the shell is served by the Vite dev server over http://localhost; the
 *  _resource_ requests still hit this handler (dev windows relax webSecurity so a
 *  cross-origin request to this scheme is allowed through).
 *--------------------------------------------------------------------------------------------*/

import { protocol } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { normalizePlatform, relativePathUnder } from '@universe-editor/platform'
import { isPathAllowed } from './resourceRoots.js'

const platform = normalizePlatform(process.platform)

export const APP_PROTOCOL_SCHEME = 'universe-app'
/** Origin of the app shell (prod). Points the BrowserWindow at the packaged index.html. */
export const APP_SHELL_URL = `${APP_PROTOCOL_SCHEME}://root/index.html`
/** Path prefix (under the shell origin) that addresses an arbitrary local resource. */
export const RESOURCE_PATH_PREFIX = '_resource_'

export { allowResourceRoots } from './resourceRoots.js'

// Directory that holds the packaged renderer (out/renderer). Set once at install.
let rendererRoot = ''

// Content types for the shell assets + the media a markdown preview embeds.
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
}

function contentTypeFor(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Privileged-scheme descriptor for `universe-app:`. Electron only accepts
 * `registerSchemesAsPrivileged` ONCE, so this is collected with the image scheme
 * into a single call in index.ts (not registered here).
 *
 * `standard` gives it hierarchical URLs (needed so relative asset URLs in
 * index.html resolve), `secure` avoids mixed-content downgrades,
 * `supportFetchAPI`/`stream` allow fetch + streamed bodies, `corsEnabled` lets
 * same-scheme requests through.
 */
export const APP_SCHEME_PRIVILEGE: Electron.CustomScheme = {
  scheme: APP_PROTOCOL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}

/** Decode the `resource` authority's target path (percent-encoded abs path). */
function decodeResourcePath(pathname: string): string {
  let p = decodeURIComponent(pathname)
  // pathname starts with '/', e.g. "/D:/a/b.png" (win) or "/home/x.png" (posix).
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}

/** Resolve a `root`-authority path to a file under the renderer dir, guarding traversal. */
function resolveShellPath(pathname: string): string | undefined {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const abs = normalize(join(rendererRoot, rel))
  // Refuse anything that escapes the renderer directory.
  if (relativePathUnder(rendererRoot, abs, platform) === null) return undefined
  return abs
}

async function serveFile(filePath: string): Promise<Response> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return new Response('Not Found', { status: 404 })
    const bytes = await readFile(filePath)
    const body = new Uint8Array(bytes.byteLength)
    body.set(bytes)
    return new Response(body, {
      status: 200,
      headers: { 'content-type': contentTypeFor(filePath) },
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

/**
 * Install the request handler. MUST run after app.whenReady(). {@link packagedRendererDir}
 * is the directory containing the packaged index.html (out/renderer).
 */
export function installAppProtocolHandler(packagedRendererDir: string): void {
  rendererRoot = normalize(packagedRendererDir)
  protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    // Resources and the shell share ONE origin (universe-app://root): a secure
    // standard scheme treats a different authority as a cross-origin request, and
    // an <img> to a cross-origin custom scheme is blocked before it reaches this
    // handler. So local resources are addressed by a path prefix, not an
    // authority.
    if (url.hostname === 'root') {
      if (url.pathname.startsWith(`/${RESOURCE_PATH_PREFIX}/`)) {
        // Arbitrary local resource — only inside an allow-listed root.
        const encoded = url.pathname.slice(RESOURCE_PATH_PREFIX.length + 2)
        const target = decodeResourcePath('/' + encoded)
        if (!target) return new Response('Bad Request', { status: 400 })
        if (!isPathAllowed(target)) return new Response('Forbidden', { status: 403 })
        return serveFile(target)
      }
      // Shell + assets: everything under the packaged renderer dir.
      const target = resolveShellPath(url.pathname)
      if (!target) return new Response('Forbidden', { status: 403 })
      return serveFile(target)
    }
    return new Response('Not Found', { status: 404 })
  })
}
