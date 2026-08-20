/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared icon reader for an installed extension's own icon (the manifest `icon`
 *  path, relative to its folder) as a `data:` URL — the renderer CSP blocks
 *  remote files. Used by the editor's main process and the remote server. Mirrors
 *  VSCode resolving `manifest.icon` against the extension location.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** Icon file extension → MIME type for the `data:` URL. */
const ICON_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Read an extension's own icon (manifest `icon`, relative to `location`) as a
 * `data:` URL. Rejects path escapes (the resolved path must stay inside
 * `location`) and returns '' when the file is absent or unreadable.
 */
export async function readExtensionIconDataUrl(
  location: string,
  iconRelPath: string,
): Promise<string> {
  try {
    const resolved = path.resolve(location, iconRelPath)
    const root = path.resolve(location)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return ''
    const bytes = await fs.readFile(resolved)
    const mime = ICON_MIME_BY_EXT[path.extname(resolved).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}
