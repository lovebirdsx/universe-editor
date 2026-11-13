/*---------------------------------------------------------------------------------------------
 *  Short-lived attachment storage for the phone gateway. Uploaded bytes land
 *  under `<userData>/mobile/attachments/<deviceId>/<attachmentId>/<name>` and
 *  are addressed by the server-generated id, never by the client's file name.
 *  The directory is wiped on gateway startup: attachments are a transfer
 *  buffer, not session history.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MAX_ATTACHMENT_BYTES_PER_PROMPT,
  MAX_ATTACHMENT_MIME_LENGTH,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS_PER_PROMPT,
  MAX_IMAGE_ATTACHMENT_BYTES,
  isMobileAttachmentKind,
  isMobileImageMimeType,
  type MobileAttachmentKind,
  type MobileAttachmentUploadResult,
  type MobileErrorCode,
} from '@universe-editor/mobile-protocol'
import { URI } from '@universe-editor/platform'
import type { MobileBridgePromptAttachment } from '../../../shared/ipc/mobileGatewayService.js'
import { sanitizeAttachmentFileName } from './attachmentNames.js'
import { writeBytesAtomic } from '../jsonConfig/atomicFile.js'

export const ATTACHMENT_PENDING_TTL_MS = 60 * 60 * 1000
export const ATTACHMENT_SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ATTACHMENT_SWEEP_INTERVAL_MS = 10 * 60 * 1000
export const MAX_PENDING_ATTACHMENTS_PER_DEVICE = 32
export const MAX_ATTACHMENT_BYTES_PER_DEVICE = 256 * 1024 * 1024

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const DEFAULT_MIME_TYPE = 'application/octet-stream'

export type MobileAttachmentErrorCode = Extract<
  MobileErrorCode,
  'attachment_not_found' | 'bad_request' | 'rate_limited' | 'not_supported'
>

export class MobileAttachmentError extends Error {
  constructor(
    readonly code: MobileAttachmentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MobileAttachmentError'
  }
}

export interface MobileGatewayAttachmentResolver {
  resolveForPrompt(
    deviceId: string,
    ids: readonly string[],
  ): Promise<readonly MobileBridgePromptAttachment[]>
  consume(deviceId: string, ids: readonly string[]): Promise<void>
}

export interface MobileGatewayAttachmentHttpStore {
  save(input: {
    readonly deviceId: string
    readonly kind: MobileAttachmentKind
    readonly name: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<MobileAttachmentUploadResult>
  open(
    deviceId: string,
    id: string,
  ): Promise<{ path: string; name: string; mimeType: string; size: number } | undefined>
}

export interface MobileAttachmentStoreOptions {
  readonly rootDir: string
  readonly logger?: Pick<Console, 'warn'> | undefined
  readonly now?: (() => number) | undefined
  readonly createId?: (() => string) | undefined
  readonly sweepIntervalMs?: number | undefined
}

interface StoredAttachment {
  readonly id: string
  readonly deviceId: string
  readonly kind: MobileAttachmentKind
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly path: string
  readonly createdAt: number
  state: 'pending' | 'sent'
  sentAt: number | undefined
  expiresAt: number
}

export class MobileAttachmentStore
  implements MobileGatewayAttachmentResolver, MobileGatewayAttachmentHttpStore
{
  private readonly _rootDir: string
  private readonly _logger: Pick<Console, 'warn'> | undefined
  private readonly _now: () => number
  private readonly _createId: () => string
  private readonly _sweepIntervalMs: number
  private readonly _byId = new Map<string, StoredAttachment>()
  private readonly _reservedBytes = new Map<string, number>()
  private readonly _reservedCount = new Map<string, number>()
  private readonly _inUse = new Set<string>()
  private _sweepTimer: ReturnType<typeof setInterval> | undefined
  private _initialized = false

  constructor(options: MobileAttachmentStoreOptions) {
    this._rootDir = options.rootDir
    this._logger = options.logger
    this._now = options.now ?? Date.now
    this._createId = options.createId ?? randomUUID
    this._sweepIntervalMs = options.sweepIntervalMs ?? ATTACHMENT_SWEEP_INTERVAL_MS
  }

  async initialize(): Promise<void> {
    if (this._initialized) return
    this._initialized = true
    await mkdir(this._rootDir, { recursive: true })
    try {
      await rm(this._rootDir, { recursive: true, force: true })
    } catch (err) {
      // A locked stale directory must not keep the gateway down; new uploads use
      // server-generated ids, so leftovers can never be resolved anyway.
      this._logger?.warn(`failed to clear stale attachments: ${String(err)}`)
    }
    await mkdir(this._rootDir, { recursive: true })
    this._byId.clear()
    this._sweepTimer = setInterval(() => this._sweep(), this._sweepIntervalMs)
    this._sweepTimer.unref?.()
  }

  dispose(): void {
    if (this._sweepTimer !== undefined) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = undefined
    }
    this._byId.clear()
    this._reservedBytes.clear()
    this._reservedCount.clear()
    this._inUse.clear()
  }

  async save(input: {
    readonly deviceId: string
    readonly kind: MobileAttachmentKind
    readonly name: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<MobileAttachmentUploadResult> {
    if (!DEVICE_ID_PATTERN.test(input.deviceId)) {
      throw new MobileAttachmentError('bad_request', 'invalid device id')
    }
    if (!isMobileAttachmentKind(input.kind)) {
      throw new MobileAttachmentError('bad_request', 'attachment kind is not supported')
    }
    const size = input.bytes.byteLength
    if (input.kind === 'image') {
      if (size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new MobileAttachmentError('bad_request', 'image attachment is too large')
      }
      if (!isMobileImageMimeType(input.mimeType)) {
        throw new MobileAttachmentError('bad_request', 'image type is not supported')
      }
    } else if (size > MAX_FILE_ATTACHMENT_BYTES) {
      throw new MobileAttachmentError('bad_request', 'file attachment is too large')
    }
    const id = this._createId()
    const name = sanitizeAttachmentFileName(input.name)
    const path = join(this._rootDir, input.deviceId, id, name)
    const createdAt = this._now()
    this._reserveQuota(input.deviceId, size)
    try {
      await writeBytesAtomic(path, input.bytes)
    } catch (err) {
      this._releaseQuota(input.deviceId, size)
      await rm(dirname(path), { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    this._releaseQuota(input.deviceId, size)
    this._byId.set(id, {
      id,
      deviceId: input.deviceId,
      kind: input.kind,
      name,
      mimeType: input.mimeType,
      size,
      path,
      createdAt,
      state: 'pending',
      sentAt: undefined,
      expiresAt: createdAt + ATTACHMENT_PENDING_TTL_MS,
    })
    return {
      id,
      kind: input.kind,
      name,
      mimeType: input.mimeType,
      size,
      createdAt,
    }
  }

  async resolveForPrompt(
    deviceId: string,
    ids: readonly string[],
  ): Promise<readonly MobileBridgePromptAttachment[]> {
    if (ids.length === 0) return []
    if (ids.length > MAX_ATTACHMENTS_PER_PROMPT) {
      throw new MobileAttachmentError('bad_request', 'too many attachments for one prompt')
    }
    const seen = new Set<string>()
    const held: string[] = []
    const resolved: MobileBridgePromptAttachment[] = []
    let imageCount = 0
    let totalBytes = 0
    try {
      for (const id of ids) {
        if (seen.has(id)) {
          throw new MobileAttachmentError('bad_request', 'duplicate attachment id')
        }
        seen.add(id)
        const entry = this._byId.get(id)
        if (entry === undefined || entry.deviceId !== deviceId || entry.expiresAt <= this._now()) {
          if (entry !== undefined && entry.deviceId === deviceId) this._dropEntry(entry)
          throw new MobileAttachmentError('attachment_not_found', 'attachment is not available')
        }
        totalBytes += entry.size
        if (totalBytes > MAX_ATTACHMENT_BYTES_PER_PROMPT) {
          throw new MobileAttachmentError('bad_request', 'attachments for one prompt are too large')
        }
        held.push(id)
        this._inUse.add(id)
        if (entry.kind === 'image') {
          imageCount += 1
          if (imageCount > MAX_IMAGE_ATTACHMENTS_PER_PROMPT) {
            throw new MobileAttachmentError('bad_request', 'too many image attachments')
          }
          let bytes: Buffer
          try {
            bytes = await readFile(entry.path)
          } catch {
            this._dropEntry(entry)
            throw new MobileAttachmentError('attachment_not_found', 'attachment is not available')
          }
          resolved.push({
            kind: 'image',
            id: entry.id,
            name: entry.name,
            mimeType: entry.mimeType,
            byteSize: entry.size,
            dataBase64: bytes.toString('base64'),
          })
        } else {
          try {
            await access(entry.path)
          } catch {
            this._dropEntry(entry)
            throw new MobileAttachmentError('attachment_not_found', 'attachment is not available')
          }
          resolved.push({
            kind: 'file',
            id: entry.id,
            name: entry.name,
            mimeType: entry.mimeType,
            byteSize: entry.size,
            uri: URI.file(entry.path).toString(),
          })
        }
      }
      return resolved
    } finally {
      for (const id of held) this._inUse.delete(id)
    }
  }

  async consume(deviceId: string, ids: readonly string[]): Promise<void> {
    const now = this._now()
    for (const id of ids) {
      const entry = this._byId.get(id)
      if (entry === undefined || entry.deviceId !== deviceId) continue
      entry.state = 'sent'
      entry.sentAt = now
      entry.expiresAt = now + ATTACHMENT_SENT_TTL_MS
    }
  }

  async open(
    deviceId: string,
    id: string,
  ): Promise<{ path: string; name: string; mimeType: string; size: number } | undefined> {
    const entry = this._byId.get(id)
    if (entry === undefined || entry.deviceId !== deviceId) return undefined
    if (entry.expiresAt <= this._now()) {
      this._dropEntry(entry)
      return undefined
    }
    return { path: entry.path, name: entry.name, mimeType: entry.mimeType, size: entry.size }
  }

  async deleteDevice(deviceId: string): Promise<void> {
    for (const [id, entry] of this._byId) {
      if (entry.deviceId === deviceId) this._byId.delete(id)
    }
    if (!DEVICE_ID_PATTERN.test(deviceId)) return
    await rm(join(this._rootDir, deviceId), { recursive: true, force: true }).catch((err) => {
      this._logger?.warn(`failed to delete attachments for device: ${String(err)}`)
    })
  }

  private _reserveQuota(deviceId: string, size: number): void {
    let pending = this._reservedCount.get(deviceId) ?? 0
    let totalBytes = this._reservedBytes.get(deviceId) ?? 0
    for (const entry of this._byId.values()) {
      if (entry.deviceId !== deviceId) continue
      totalBytes += entry.size
      if (entry.state === 'pending') pending += 1
    }
    if (pending >= MAX_PENDING_ATTACHMENTS_PER_DEVICE) {
      throw new MobileAttachmentError('rate_limited', 'too many pending attachments')
    }
    if (totalBytes + size > MAX_ATTACHMENT_BYTES_PER_DEVICE) {
      throw new MobileAttachmentError('rate_limited', 'attachment storage quota exceeded')
    }
    this._reservedCount.set(deviceId, (this._reservedCount.get(deviceId) ?? 0) + 1)
    this._reservedBytes.set(deviceId, (this._reservedBytes.get(deviceId) ?? 0) + size)
  }

  private _releaseQuota(deviceId: string, size: number): void {
    const pending = (this._reservedCount.get(deviceId) ?? 1) - 1
    const totalBytes = (this._reservedBytes.get(deviceId) ?? size) - size
    if (pending > 0) this._reservedCount.set(deviceId, pending)
    else this._reservedCount.delete(deviceId)
    if (totalBytes > 0) this._reservedBytes.set(deviceId, totalBytes)
    else this._reservedBytes.delete(deviceId)
  }

  private _dropEntry(entry: StoredAttachment): void {
    this._byId.delete(entry.id)
    void rm(dirname(entry.path), { recursive: true, force: true }).catch((err) => {
      this._logger?.warn(`failed to remove attachment: ${String(err)}`)
    })
  }

  private _sweep(): void {
    const now = this._now()
    for (const entry of this._byId.values()) {
      if (entry.expiresAt > now || this._inUse.has(entry.id)) continue
      this._dropEntry(entry)
    }
  }
}

export function normalizeAttachmentMimeType(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '' || trimmed.length > MAX_ATTACHMENT_MIME_LENGTH) return DEFAULT_MIME_TYPE
  return trimmed
}
