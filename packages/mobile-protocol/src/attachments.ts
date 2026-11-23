/**
 * Attachments accepted by the phone composer. Bytes travel over the gateway's
 * HTTP API; WebSocket frames carry only ids and display metadata. The limits
 * are shared by the PWA (pre-flight checks) and the PC gateway (authoritative).
 */

export const MOBILE_ATTACHMENT_KINDS = ['image', 'file'] as const
export type MobileAttachmentKind = (typeof MOBILE_ATTACHMENT_KINDS)[number]

/** Image types the desktop prompt pipeline accepts (`PromptImage`). */
export const MOBILE_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

export const MOBILE_ATTACHMENT_UPLOAD_PATH = '/api/attachments'
export const MOBILE_ATTACHMENT_PATH_PREFIX = '/api/attachments/'

/** Upload headers (case-insensitive); the name value is URL-encoded UTF-8. */
export const MOBILE_ATTACHMENT_KIND_HEADER = 'x-universe-attachment-kind'
export const MOBILE_ATTACHMENT_NAME_HEADER = 'x-universe-attachment-name'

export const MAX_FILE_ATTACHMENTS_PER_PROMPT = 8
export const MAX_IMAGE_ATTACHMENTS_PER_PROMPT = 20
export const MAX_ATTACHMENTS_PER_PROMPT =
  MAX_IMAGE_ATTACHMENTS_PER_PROMPT + MAX_FILE_ATTACHMENTS_PER_PROMPT
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES_PER_PROMPT = 50 * 1024 * 1024

/** Prompt images are downscaled before they leave the renderer/PWA. 1568px is
 *  the largest edge models sample at, so anything above it only costs bytes. */
export const IMAGE_COMPRESS_MAX_DIMENSION = 1568
export const IMAGE_COMPRESS_QUALITY = 0.82
export const IMAGE_COMPRESS_TARGET_BYTES = 1024 * 1024
export const IMAGE_COMPRESS_FALLBACK_DIMENSION = 1024
export const IMAGE_COMPRESS_FALLBACK_QUALITY = 0.7
/** Largest body the upload endpoint reads; kind-specific limits apply later. */
export const MAX_ATTACHMENT_UPLOAD_BYTES = MAX_FILE_ATTACHMENT_BYTES
export const MAX_ATTACHMENT_ID_LENGTH = 128
export const MAX_ATTACHMENT_NAME_LENGTH = 255
export const MAX_ATTACHMENT_MIME_LENGTH = 128

export function isMobileAttachmentKind(value: unknown): value is MobileAttachmentKind {
  return value === 'image' || value === 'file'
}

export function isMobileImageMimeType(value: string): boolean {
  return (MOBILE_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

/** Attachment summary carried on a timeline message / upsert event. */
export interface MobileMessageAttachment {
  readonly id: string
  readonly kind: MobileAttachmentKind
  readonly name: string
  /** Present unless the browser gave an empty type; server defaults to octet-stream. */
  readonly mimeType?: string
  readonly size: number
}

/** `POST /api/attachments` response. */
export interface MobileAttachmentUploadResult {
  readonly id: string
  readonly kind: MobileAttachmentKind
  readonly name: string
  readonly mimeType?: string
  readonly size: number
  /** Epoch milliseconds. */
  readonly createdAt: number
}
