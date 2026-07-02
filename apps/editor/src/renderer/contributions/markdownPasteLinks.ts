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

/** Whether a path's extension is a known image type (drives the `!` embed prefix). */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/** Wrap a link target in `<...>` when it carries characters markdown can't take bare. */
export function encodeLinkTarget(target: string): string {
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

function escapeSnippet(text: string): string {
  return text.replace(/\$|}|\\/g, '\\$&')
}

/**
 * A single markdown link/image as a snippet string whose link text is a selected
 * placeholder — `[${index:text}](target)` for links, `![${index:alt text}](target)`
 * for images — matching VSCode's drop/paste-to-link (copyFiles/shared.ts). The
 * path is angle-wrapped when it needs it (`encodeLinkTarget`) and then
 * snippet-escaped so a `$`/`}`/`\` in the path can't break the snippet. The
 * placeholder text (`text` / `alt text`) is a constant with no snippet metachars.
 */
export function markdownLinkSnippet(relPath: string, isImage: boolean, index: number): string {
  const target = escapeSnippet(encodeLinkTarget(relPath))
  const placeholder = isImage ? 'alt text' : 'text'
  return `${isImage ? '!' : ''}[\${${index}:${placeholder}}](${target})`
}

/**
 * A pasted `text/uri-list` (files dragged from Explorer / OS) → one markdown
 * image (`![${n:alt text}](path)`) or link (`[${n:text}](path)`) snippet per file
 * uri, space-joined with an incrementing placeholder index so each link text can
 * be tab-edited in turn. Paths are made relative to `rootFsPath` when they resolve
 * under it. Returns undefined when nothing parsed (caller falls through to the
 * default paste).
 */
export function markdownLinksFromUriList(
  raw: string,
  rootFsPath: string | undefined,
  platform: HostPlatform,
): string | undefined {
  const parts: string[] = []
  let index = 1
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry || entry.startsWith('#')) continue
    const fsPath = tryParseFileUri(entry)
    if (!fsPath) continue
    const rel = rootFsPath ? relativePathUnder(rootFsPath, fsPath, platform) : null
    const rawPath = rel ?? fsPath.replace(/\\/g, '/')
    parts.push(markdownLinkSnippet(rawPath, isImagePath(fsPath), index++))
  }
  return parts.length ? parts.join(' ') : undefined
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
