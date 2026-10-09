/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Convert a markdown image `src` into a URL the renderer can actually load. Our
 *  equivalent of VSCode's `asWebviewUri`: local files can't be loaded via a plain
 *  `file://` <img> across the renderer's origin (http in dev, file in prod, both
 *  under webSecurity), so a local path is rewritten to the privileged
 *  `universe-app://root/_resource_/<abs-path>` scheme served by the main process.
 *
 *  Rules (mirroring VSCode):
 *    - http(s): and data:image  → returned unchanged (loaded directly)
 *    - file:, absolute, relative → resolved to an absolute fs path, then to a
 *      universe-app URL (relative paths resolve against the document dir,
 *      then the workspace root — same order as clicked file links)
 *    - anything else (javascript:, etc.) → undefined (not rendered)
 *
 *  The URL codec itself (and its inverse) lives in `shared/appResourceUrl.ts`.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { toResourceUrl } from '../../../shared/appResourceUrl.js'
import { isAbsolutePath } from './markdownLinkResolve.js'

function isHttpOrData(src: string): boolean {
  return /^(?:https?:|data:image\/)/i.test(src)
}

/**
 * Resolve {@link src} to a loadable URL, or `undefined` if it should not render.
 * {@link baseUri} is the markdown document's directory; {@link workspaceRoot} the
 * workspace folder — both used to resolve relative paths.
 */
export function asPreviewResourceUri(
  src: string,
  baseUri: URI | undefined,
  workspaceRoot: URI | undefined,
): string | undefined {
  const trimmed = src.trim()
  if (trimmed.length === 0) return undefined
  if (isHttpOrData(trimmed)) return trimmed

  // 本机路径，不随远端工作区变化：universe-app 协议只服务本机文件（图片）。
  let fsPath: string | undefined
  if (/^file:/i.test(trimmed)) {
    try {
      fsPath = URI.parse(trimmed).fsPath
    } catch {
      return undefined
    }
  } else if (isAbsolutePath(trimmed)) {
    fsPath = URI.file(trimmed).fsPath
  } else if (/^[a-z][a-z0-9.+-]*:/i.test(trimmed)) {
    // Some other scheme (javascript:, vbscript:, …) — refuse.
    return undefined
  } else {
    const rel = trimmed.replace(/\\/g, '/')
    const base = baseUri ?? workspaceRoot
    if (!base) return undefined
    fsPath = URI.joinPath(base, rel).fsPath
  }

  if (!fsPath) return undefined
  return toResourceUrl(fsPath)
}
