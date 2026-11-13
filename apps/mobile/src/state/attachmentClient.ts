import {
  MOBILE_ATTACHMENT_KIND_HEADER,
  MOBILE_ATTACHMENT_NAME_HEADER,
  MOBILE_ATTACHMENT_PATH_PREFIX,
  MOBILE_ATTACHMENT_UPLOAD_PATH,
  MOBILE_DRAFT_IMAGE_PATH,
  MOBILE_SESSION_FILE_PATH,
  MOBILE_SESSION_IMAGE_PATH,
  MOBILE_SESSION_REPORT_PATH,
  isMobileAttachmentKind,
  isMobileErrorCode,
  type MobileAttachmentKind,
  type MobileAttachmentUploadResult,
  type MobileMessageAttachment,
  type MobileSessionRef,
} from '@universe-editor/mobile-protocol'
import { CommandError } from './commandClient.js'

export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000
export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000

export interface AttachmentClientOptions {
  readonly origin: string
  readonly token: string
  readonly fetchImpl?: typeof fetch | undefined
  readonly onUnauthorized?: (() => void) | undefined
  readonly uploadTimeoutMs?: number | undefined
  readonly downloadTimeoutMs?: number | undefined
}

/** `ws(s)://host:port/ws` → `http(s)://host:port`; tokens never travel in the URL. */
export function httpOriginForSocketUrl(socketUrl: string): string {
  const url = new URL(socketUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.origin
}

/**
 * HTTP side of phone attachments. The WebSocket carries only ids; bytes move
 * through authenticated POST/GET requests on the same gateway origin.
 */
export class AttachmentClient {
  private readonly _origin: string
  private readonly _token: string
  private readonly _fetch: typeof fetch
  private readonly _onUnauthorized: (() => void) | undefined
  private readonly _uploadTimeoutMs: number
  private readonly _downloadTimeoutMs: number

  constructor(options: AttachmentClientOptions) {
    this._origin = options.origin
    this._token = options.token
    this._fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this._onUnauthorized = options.onUnauthorized
    this._uploadTimeoutMs = options.uploadTimeoutMs ?? ATTACHMENT_UPLOAD_TIMEOUT_MS
    this._downloadTimeoutMs = options.downloadTimeoutMs ?? ATTACHMENT_DOWNLOAD_TIMEOUT_MS
  }

  async upload(file: File, kind: MobileAttachmentKind): Promise<MobileAttachmentUploadResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._uploadTimeoutMs)
    try {
      const mimeType = file.type.trim() === '' ? 'application/octet-stream' : file.type.trim()
      const response = await this._fetch(`${this._origin}${MOBILE_ATTACHMENT_UPLOAD_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this._token}`,
          'Content-Type': mimeType,
          [MOBILE_ATTACHMENT_KIND_HEADER]: kind,
          [MOBILE_ATTACHMENT_NAME_HEADER]: encodeURIComponent(
            file.name.trim() === '' ? 'attachment' : file.name,
          ),
        },
        body: file,
        signal: controller.signal,
      })
      if (!response.ok) throw await this._errorFromResponse(response)
      const value: unknown = await response.json()
      if (!isUploadResult(value)) {
        throw new CommandError('invalid_response', 'attachment upload response is malformed')
      }
      return value
    } catch (err) {
      throw this._normalizeError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  async fetchBlob(attachment: Pick<MobileMessageAttachment, 'id'>): Promise<Blob> {
    return this._fetchBlob(`${MOBILE_ATTACHMENT_PATH_PREFIX}${encodeURIComponent(attachment.id)}`)
  }

  /** Bytes of one ACP image block of the open session's message. */
  async fetchSessionImage(ref: MobileSessionRef, messageId: string, index: number): Promise<Blob> {
    return this._fetchBlob(MOBILE_SESSION_IMAGE_PATH, {
      ...refQuery(ref),
      message: messageId,
      index: String(index),
    })
  }

  /** Bytes of a markdown-referenced workspace image, resolved on the PC. */
  async fetchWorkspaceImage(ref: MobileSessionRef, src: string): Promise<Blob> {
    return this._fetchBlob(MOBILE_SESSION_FILE_PATH, { ...refQuery(ref), path: src })
  }

  /** Full trigger-run report for a session; main resolves the run and file. */
  async fetchSessionReport(ref: MobileSessionRef): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._downloadTimeoutMs)
    try {
      const response = await this._fetch(
        `${this._origin}${MOBILE_SESSION_REPORT_PATH}?${new URLSearchParams(refQuery(ref)).toString()}`,
        {
          headers: { Authorization: `Bearer ${this._token}` },
          cache: 'no-store',
          signal: controller.signal,
        },
      )
      if (!response.ok) throw await this._errorFromResponse(response)
      return await response.text()
    } catch (err) {
      throw this._normalizeError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Bytes of a picture the PC pasted into the shared draft. */
  async fetchDraftImage(ref: MobileSessionRef, imageId: string): Promise<Blob> {
    return this._fetchBlob(MOBILE_DRAFT_IMAGE_PATH, { ...refQuery(ref), image: imageId })
  }

  private async _fetchBlob(pathname: string, params?: Record<string, string>): Promise<Blob> {
    const query = params === undefined ? '' : `?${new URLSearchParams(params).toString()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._downloadTimeoutMs)
    try {
      const response = await this._fetch(`${this._origin}${pathname}${query}`, {
        headers: { Authorization: `Bearer ${this._token}` },
        signal: controller.signal,
      })
      if (!response.ok) throw await this._errorFromResponse(response)
      return await response.blob()
    } catch (err) {
      throw this._normalizeError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  private async _errorFromResponse(response: Response): Promise<CommandError> {
    if (response.status === 401) {
      this._onUnauthorized?.()
      return new CommandError('unauthorized', 'attachment request is not authorized')
    }
    let code: string | undefined
    try {
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null) {
        const value = (body as { readonly code?: unknown }).code
        if (typeof value === 'string') code = value
      }
    } catch {
      // A non-JSON error body still maps by status below.
    }
    if (isMobileErrorCode(code)) {
      return new CommandError(code, `attachment request failed (${response.status})`)
    }
    if (response.status === 413) {
      return new CommandError('bad_request', 'attachment is too large')
    }
    if (response.status === 404) {
      return new CommandError('attachment_not_found', 'attachment is not available')
    }
    return new CommandError('internal', `attachment request failed (${response.status})`)
  }

  private _normalizeError(err: unknown): CommandError {
    if (err instanceof CommandError) return err
    if (typeof err === 'object' && err !== null) {
      const name = (err as { readonly name?: unknown }).name
      if (name === 'AbortError') return new CommandError('timeout', 'attachment request timed out')
    }
    return new CommandError('network', 'attachment request failed')
  }
}

function refQuery(ref: MobileSessionRef): Record<string, string> {
  return {
    windowId: String(ref.windowId),
    localId: ref.localId,
    ...(ref.durableId !== undefined ? { durableId: ref.durableId } : {}),
  }
}

function isUploadResult(value: unknown): value is MobileAttachmentUploadResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    record['id'] !== '' &&
    isMobileAttachmentKind(record['kind']) &&
    typeof record['name'] === 'string' &&
    record['name'] !== '' &&
    (record['mimeType'] === undefined || typeof record['mimeType'] === 'string') &&
    typeof record['size'] === 'number' &&
    Number.isFinite(record['size']) &&
    record['size'] >= 0 &&
    typeof record['createdAt'] === 'number' &&
    Number.isFinite(record['createdAt'])
  )
}
