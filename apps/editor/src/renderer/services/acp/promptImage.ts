/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Prompt images — pictures the user attaches to a prompt by pasting (Ctrl+V),
 *  dropping an image file, or picking one via the attach button. Mirrors the
 *  SelectionContext pipeline: a typed value carried on PromptInput state +
 *  QueuedPrompt, serialized into ACP `image` ContentBlocks on submit.
 *
 *  The bytes live as base64 in memory only (draft cache included) — never on
 *  disk. On the wire an image is an ImageContent block (`{ type:'image', data,
 *  mimeType }`); the agent must advertise `promptCapabilities.image` for it to
 *  be sent (the input gates on that, see PromptInput).
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'

export interface PromptImage {
  /** Stable id for React keys + removal, unique within one draft. */
  readonly id: string
  /** MIME type, e.g. `image/png`. One of {@link SUPPORTED_IMAGE_MIME}. */
  readonly mimeType: string
  /** Raw image bytes as a base64 string (no `data:` prefix). */
  readonly dataBase64: string
  /** Decoded byte size, used for the size-limit check and the chip tooltip. */
  readonly byteSize: number
  /** Original file name when available (drop / file picker); absent for pastes. */
  readonly name?: string
}

/** Limits applied when accepting an image, sourced from `acp.prompt.image.*`. */
export interface ImageLimits {
  /** Max size of a single image in bytes. */
  readonly maxBytes: number
  /** Max number of images attached to one prompt. */
  readonly maxCount: number
}

/** MIME types we accept. Kept in sync with the file picker's `accept` attr. */
export const SUPPORTED_IMAGE_MIME: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

export function isSupportedImageMime(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME.includes(mimeType)
}

export type ImageRejectReason = 'unsupported-type' | 'too-large' | 'too-many'

/**
 * Validate one candidate image against the limits and the current attachment
 * count. Pure — returns `null` when acceptable, else the reject reason so the
 * caller can surface a specific message.
 */
export function validateImage(
  candidate: { readonly mimeType: string; readonly byteSize: number },
  existingCount: number,
  limits: ImageLimits,
): ImageRejectReason | null {
  if (!isSupportedImageMime(candidate.mimeType)) return 'unsupported-type'
  if (candidate.byteSize > limits.maxBytes) return 'too-large'
  if (existingCount >= limits.maxCount) return 'too-many'
  return null
}

/**
 * Turn attached images into `image` ContentBlocks to prepend before the user's
 * text. Empty input → `[]`.
 */
export function composeImageBlocks(images: readonly PromptImage[]): readonly ContentBlock[] {
  return images.map((img) => ({
    type: 'image',
    data: img.dataBase64,
    mimeType: img.mimeType,
  }))
}

/**
 * Read a browser File/Blob (from paste, drop, or the file picker) into a
 * {@link PromptImage}. Rejects if the reader fails. Does NOT validate — the
 * caller runs {@link validateImage} first (it needs the current count).
 */
export async function blobToPromptImage(
  file: Blob,
  id: string,
  name?: string,
): Promise<PromptImage> {
  const dataBase64 = await blobToBase64(file)
  return {
    id,
    mimeType: file.type,
    dataBase64,
    byteSize: file.size,
    ...(name !== undefined ? { name } : {}),
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'))
        return
      }
      // Strip the `data:<mime>;base64,` prefix — the wire format wants raw base64.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * Build a {@link PromptImage} from raw bytes (an internal drag carries only a
 * URI, so the file is read via IFileService rather than a browser File). The
 * mime type is inferred from the file extension. Does NOT validate.
 */
export function bytesToPromptImage(bytes: Uint8Array, id: string, fileName: string): PromptImage {
  return {
    id,
    mimeType: mimeTypeForFileName(fileName),
    dataBase64: bytesToBase64(bytes),
    byteSize: bytes.byteLength,
    name: fileName,
  }
}

/** Infer an image MIME type from a file name's extension; '' if not an image. */
export function mimeTypeForFileName(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    default:
      return ''
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
