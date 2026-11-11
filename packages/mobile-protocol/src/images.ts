/**
 * Message images projected from ACP image content blocks. Bytes never travel on
 * the WebSocket: the phone fetches them from the gateway's same-origin HTTP API,
 * using `index` to address the image block inside the message.
 */

import { isMobileImageMimeType } from './attachments.js'

export const MAX_IMAGES_PER_MESSAGE = 24
export const MAX_MESSAGE_IMAGE_INDEX = 255
export const MAX_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_WORKSPACE_IMAGE_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_SRC_LENGTH = 4096

export const MOBILE_SESSION_IMAGE_PATH = '/api/sessions/image'
export const MOBILE_SESSION_FILE_PATH = '/api/sessions/file'

export interface MobileMessageImage {
  /** 0-based ordinal among all image blocks in the message (attachments included). */
  readonly index: number
  readonly mimeType: string
  /** Decoded byte length; 0 when the PC dropped the payload. */
  readonly size: number
  /** The PC dropped the base64 payload (media cap), so the phone must not request it. */
  readonly truncated?: boolean
}

/** Raster types the phone can decode in an `<img>`; SVG is intentionally excluded. */
export function isPreviewableImageMimeType(value: string): boolean {
  return isMobileImageMimeType(value.toLowerCase())
}
