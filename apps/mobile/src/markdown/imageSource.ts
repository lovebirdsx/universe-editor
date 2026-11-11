import { isPreviewableImageMimeType, MAX_IMAGE_SRC_LENGTH } from '@universe-editor/mobile-protocol'

/** Inline data URIs are not requested from the PC; cap them so the DOM stays sane. */
export const MAX_DATA_IMAGE_CHARS = 2_800_000
const MAX_DIRECT_IMAGE_SRC_LENGTH = 8192

export type MarkdownImageSource =
  | { readonly kind: 'direct'; readonly src: string }
  | { readonly kind: 'workspace'; readonly src: string }

/**
 * Classify a markdown image `src`: remote/data images render directly, while
 * file paths are resolved by the PC (the phone cannot read the workspace).
 * Everything else stays inert rather than guessing.
 */
export function resolveMarkdownImageSource(src: string): MarkdownImageSource | undefined {
  const trimmed = src.trim()
  if (trimmed === '' || trimmed.includes('\0')) return undefined
  if (/^data:/i.test(trimmed)) {
    if (trimmed.length > MAX_DATA_IMAGE_CHARS) return undefined
    const mimeType = /^data:([^;,]+)/i.exec(trimmed)?.[1]?.trim().toLowerCase()
    if (mimeType === undefined || !isPreviewableImageMimeType(mimeType)) return undefined
    return { kind: 'direct', src: trimmed }
  }
  if (/^https?:/i.test(trimmed)) {
    return trimmed.length <= MAX_DIRECT_IMAGE_SRC_LENGTH
      ? { kind: 'direct', src: trimmed }
      : undefined
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return { kind: 'workspace', src: trimmed }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^file:/i.test(trimmed)) return undefined
  if (trimmed.length > MAX_IMAGE_SRC_LENGTH) return undefined
  return { kind: 'workspace', src: trimmed }
}
