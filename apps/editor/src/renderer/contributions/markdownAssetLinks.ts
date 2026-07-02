/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for dropped/pasted image assets: mapping an image mime to a file
 *  extension, minting a timestamped `assets/` file name, and shaping the markdown
 *  link. Kept free of monaco / DI / fs so the naming + shaping is unit-testable
 *  in isolation (the actual disk write lives in ./markdownAssetDropper).
 *--------------------------------------------------------------------------------------------*/

import { markdownLinkSnippet } from './markdownPasteLinks.js'

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

/**
 * The file extension (no dot) for an image mime type, or undefined when the mime
 * is not a recognised image. Tolerates a `;charset=...` suffix and casing.
 */
export function imageExtensionForMime(mime: string): string | undefined {
  const base = mime.toLowerCase().split(';')[0]?.trim() ?? ''
  return MIME_TO_EXT[base]
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Format a timestamp as `yyyyMMdd-HHmmss` (local time) for asset file names. */
export function formatAssetStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * Build the asset file name for a dropped/pasted image. `index` disambiguates
 * multiple images sharing the same second-resolution stamp (0 → no suffix).
 */
export function assetFileName(ext: string, stamp: string, index: number): string {
  return index === 0 ? `image-${stamp}.${ext}` : `image-${stamp}-${index}.${ext}`
}

/**
 * A workspace-relative path → markdown snippet: an image embed
 * (`![${1:alt text}]`) or a link (`[${1:text}]`) with the link text as a selected
 * placeholder. A single dropped/pasted asset always uses placeholder index 1.
 */
export function markdownLinkForPath(relPath: string, isImage: boolean): string {
  return markdownLinkSnippet(relPath, isImage, 1)
}
