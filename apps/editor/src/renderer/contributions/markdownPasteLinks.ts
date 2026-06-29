/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure link-generation helpers for the markdown paste enhancement. Kept free of
 *  monaco / DI so the markdown shaping (image vs link, relative path, snippet
 *  escaping) is unit-testable in isolation (see MarkdownPasteContribution).
 *--------------------------------------------------------------------------------------------*/

import { relativePathUnder, type HostPlatform } from '@universe-editor/platform'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
  '.avif',
])

const URL_RE = /^(https?|ftp|mailto):/i

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/** Wrap a link target in `<...>` when it carries characters markdown can't take bare. */
function encodeLinkTarget(target: string): string {
  return /[\s()]/.test(target) ? `<${target}>` : target
}

function tryParseFileUri(entry: string): string | undefined {
  if (!entry.startsWith('file:')) return undefined
  try {
    const decoded = decodeURIComponent(new URL(entry).pathname)
    // file:///C:/... → strip the leading slash before the drive letter on win32.
    return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return undefined
  }
}

/**
 * A pasted `text/uri-list` (files dragged from Explorer / OS) → one markdown
 * image (`![](path)`) or link (`[](path)`) per file uri, space-joined. Paths are
 * made relative to `rootFsPath` when they resolve under it. Returns undefined
 * when nothing parsed (so the caller falls through to the default paste).
 */
export function markdownLinksFromUriList(
  raw: string,
  rootFsPath: string | undefined,
  platform: HostPlatform,
): string | undefined {
  const parts: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry || entry.startsWith('#')) continue
    const fsPath = tryParseFileUri(entry)
    if (!fsPath) continue
    const rel = rootFsPath ? relativePathUnder(rootFsPath, fsPath, platform) : null
    const target = encodeLinkTarget(rel ?? fsPath.replace(/\\/g, '/'))
    parts.push(isImagePath(fsPath) ? `![](${target})` : `[](${target})`)
  }
  return parts.length ? parts.join(' ') : undefined
}

function escapeSnippet(text: string): string {
  return text.replace(/\$|}|\\/g, '\\$&')
}

/**
 * A pasted http(s)/ftp/mailto URL dropped over a non-empty `selected` text →
 * `[selected](url)` as a snippet (escaped). Returns undefined when `text` is not
 * a single bare URL or nothing is selected (the default paste then applies).
 */
export function markdownLinkFromUrl(
  selected: string,
  text: string,
): { snippet: string } | undefined {
  if (!selected) return undefined
  if (!URL_RE.test(text) || /\s/.test(text)) return undefined
  return { snippet: `[${escapeSnippet(selected)}](${escapeSnippet(text)})` }
}
