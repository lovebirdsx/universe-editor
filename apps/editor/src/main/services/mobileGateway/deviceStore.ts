/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Device credential store. `<userData>/mobile/devices.json` holds one record per
 *  paired phone; only a SHA-256 digest of the bearer token is persisted, never
 *  the token itself. The token is 32 CSPRNG bytes, so it already has full
 *  entropy — a slow password hash would only let unauthenticated clients burn
 *  CPU with repeated hellos. Every read-modify-write is serialized through one
 *  queue so two concurrent hellos cannot clobber each other's lastSeenAt.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  MobileAttentionKind,
  MobileNotificationPrefs,
  MobilePushSubscription,
} from '@universe-editor/mobile-protocol'
import { writeJsonAtomic } from './atomicFile.js'

const FILE_VERSION = 2
const TOKEN_BYTES = 32
/** Paired-device cap; each device can hold up to MAX_CONNECTIONS_PER_DEVICE sockets. */
export const MAX_PAIRED_DEVICES = 32

export class DeviceLimitError extends Error {
  constructor() {
    super(`paired device limit reached (${MAX_PAIRED_DEVICES})`)
    this.name = 'DeviceLimitError'
  }
}

export interface MobileNotificationPrefsRecord {
  readonly enabled: boolean
  readonly kinds?: readonly MobileAttentionKind[]
  readonly alwaysNotify: boolean
}

export interface MobilePushSubscriptionRecord {
  readonly endpoint: string
  readonly keys: {
    readonly p256dh: string
    readonly auth: string
  }
  readonly updatedAt: number
}

export interface MobileDeviceRecord {
  readonly deviceId: string
  readonly name: string
  readonly platform: string
  readonly tokenHash: string
  readonly createdAt: number
  readonly lastSeenAt: number
  /** PC-granted permission for high-risk operations; absent means false. */
  readonly trusted?: boolean
  readonly notifications?: MobileNotificationPrefsRecord
  readonly push?: MobilePushSubscriptionRecord
}

/** What the notification router needs per device. */
export interface MobileNotifyTarget {
  readonly deviceId: string
  readonly notifications: MobileNotificationPrefsRecord
  readonly push?: MobilePushSubscriptionRecord
}

export interface AddedMobileDevice {
  readonly device: MobileDeviceRecord
  /** Returned once, at pairing time; never persisted or logged. */
  readonly token: string
}

interface DevicesFile {
  readonly version: number
  readonly devices: MobileDeviceRecord[]
}

export interface DeviceStoreOptions {
  readonly now?: () => number
  readonly onCorrupt?: (error: Error) => void
  readonly onChmodError?: (error: Error) => void
}

export class DeviceStore {
  private readonly _now: () => number
  private readonly _onCorrupt: ((error: Error) => void) | undefined
  private readonly _onChmodError: ((error: Error) => void) | undefined
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly _file: string,
    options: DeviceStoreOptions = {},
  ) {
    this._now = options.now ?? Date.now
    this._onCorrupt = options.onCorrupt
    this._onChmodError = options.onChmodError
  }

  list(): Promise<MobileDeviceRecord[]> {
    return this._enqueue(async () => (await this._load()).devices)
  }

  get(deviceId: string): Promise<MobileDeviceRecord | undefined> {
    return this._enqueue(async () => {
      const file = await this._load()
      return file.devices.find((device) => device.deviceId === deviceId)
    })
  }

  /** Mint a fresh bearer token and persist only its digest. */
  add(input: { name: string; platform: string }): Promise<AddedMobileDevice> {
    return this._enqueue(async () => {
      const file = await this._load()
      if (file.devices.length >= MAX_PAIRED_DEVICES) throw new DeviceLimitError()
      const createdAt = this._now()
      const token = randomBytes(TOKEN_BYTES).toString('base64url')
      const device: MobileDeviceRecord = {
        deviceId: randomUUID(),
        name: input.name,
        platform: input.platform,
        tokenHash: hashToken(token),
        createdAt,
        lastSeenAt: createdAt,
        trusted: false,
      }
      file.devices.push(device)
      await this._save(file)
      return { device, token }
    })
  }

  /**
   * Resolve a bearer token to its device. Hash once, then compare against each
   * stored digest with timingSafeEqual; an unknown token returns undefined.
   */
  verify(token: string): Promise<MobileDeviceRecord | undefined> {
    return this._enqueue(async () => {
      if (token.length === 0) return undefined
      const file = await this._load()
      const candidate = Buffer.from(hashToken(token), 'base64url')
      for (const device of file.devices) {
        const stored = Buffer.from(device.tokenHash, 'base64url')
        if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return device
      }
      return undefined
    })
  }

  revoke(deviceId: string): Promise<boolean> {
    return this._enqueue(async () => {
      const file = await this._load()
      const next = file.devices.filter((device) => device.deviceId !== deviceId)
      if (next.length === file.devices.length) return false
      await this._save({ version: FILE_VERSION, devices: next })
      return true
    })
  }

  /** Grant or revoke the device's high-risk permission. Returns false when it is gone. */
  setTrusted(deviceId: string, trusted: boolean): Promise<boolean> {
    return this._enqueue(async () => {
      const file = await this._load()
      const index = file.devices.findIndex((device) => device.deviceId === deviceId)
      if (index < 0) return false
      file.devices[index] = { ...file.devices[index]!, trusted: trusted === true }
      await this._save(file)
      return true
    })
  }

  /** Replace the device's notification preferences. Returns false when it is gone. */
  setNotificationPrefs(deviceId: string, prefs: MobileNotificationPrefs): Promise<boolean> {
    return this._enqueue(async () => {
      const file = await this._load()
      const index = file.devices.findIndex((device) => device.deviceId === deviceId)
      if (index < 0) return false
      const device = file.devices[index]!
      file.devices[index] = {
        ...device,
        notifications: {
          enabled: prefs.enabled,
          ...(prefs.kinds !== undefined ? { kinds: [...prefs.kinds] } : {}),
          alwaysNotify: prefs.alwaysNotify,
        },
      }
      await this._save(file)
      return true
    })
  }

  /** Store (or replace) the Web Push subscription for a device. */
  setPushSubscription(deviceId: string, subscription: MobilePushSubscription): Promise<boolean> {
    return this._enqueue(async () => {
      const file = await this._load()
      const index = file.devices.findIndex((device) => device.deviceId === deviceId)
      if (index < 0) return false
      const device = file.devices[index]!
      file.devices[index] = {
        ...device,
        push: {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
          updatedAt: this._now(),
        },
      }
      await this._save(file)
      return true
    })
  }

  removePushSubscription(deviceId: string): Promise<boolean> {
    return this._enqueue(async () => {
      const file = await this._load()
      const index = file.devices.findIndex((device) => device.deviceId === deviceId)
      if (index < 0) return false
      const device = file.devices[index]!
      if (device.push === undefined) return false
      const next = { ...device }
      delete next.push
      file.devices[index] = next
      await this._save(file)
      return true
    })
  }

  /** Devices that turned notifications on; the hub uses this to start attention. */
  listNotifyTargets(): Promise<MobileNotifyTarget[]> {
    return this._enqueue(async () => {
      const file = await this._load()
      const targets: MobileNotifyTarget[] = []
      for (const device of file.devices) {
        if (device.notifications?.enabled !== true) continue
        targets.push({
          deviceId: device.deviceId,
          notifications: device.notifications,
          ...(device.push !== undefined ? { push: device.push } : {}),
        })
      }
      return targets
    })
  }

  touch(deviceId: string, at = this._now()): Promise<void> {
    return this._enqueue(async () => {
      const file = await this._load()
      const device = file.devices.find((entry) => entry.deviceId === deviceId)
      if (!device || device.lastSeenAt === at) return
      const index = file.devices.indexOf(device)
      file.devices[index] = { ...device, lastSeenAt: at }
      await this._save(file)
    })
  }

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task, task)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async _load(): Promise<DevicesFile> {
    let text: string
    try {
      text = await readFile(this._file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: FILE_VERSION, devices: [] }
      }
      this._onCorrupt?.(toError(err))
      return { version: FILE_VERSION, devices: [] }
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed) || !Array.isArray(parsed['devices'])) {
        this._onCorrupt?.(new Error('devices.json has an unexpected shape'))
        return { version: FILE_VERSION, devices: [] }
      }
      // v1 stored scrypt hashes with per-record salts; treating them as v2 would
      // silently lock every paired phone out, so discard the file loudly.
      if (parsed['version'] !== FILE_VERSION) {
        this._onCorrupt?.(
          new Error(`devices.json version ${String(parsed['version'])} is not supported`),
        )
        return { version: FILE_VERSION, devices: [] }
      }
      return { version: FILE_VERSION, devices: parsed['devices'].filter(isDeviceRecord) }
    } catch (err) {
      this._onCorrupt?.(toError(err))
      return { version: FILE_VERSION, devices: [] }
    }
  }

  private _save(file: DevicesFile): Promise<void> {
    return writeJsonAtomic(this._file, file, this._onChmodError)
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDeviceRecord(value: unknown): value is MobileDeviceRecord {
  if (!isRecord(value)) return false
  return (
    typeof value['deviceId'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['platform'] === 'string' &&
    typeof value['tokenHash'] === 'string' &&
    typeof value['createdAt'] === 'number' &&
    typeof value['lastSeenAt'] === 'number' &&
    (value['trusted'] === undefined || typeof value['trusted'] === 'boolean') &&
    (value['notifications'] === undefined || isNotificationPrefs(value['notifications'])) &&
    (value['push'] === undefined || isPushSubscription(value['push']))
  )
}

function isNotificationPrefs(value: unknown): value is MobileNotificationPrefsRecord {
  if (!isRecord(value)) return false
  if (typeof value['enabled'] !== 'boolean') return false
  if (typeof value['alwaysNotify'] !== 'boolean') return false
  const kinds = value['kinds']
  return (
    kinds === undefined || (Array.isArray(kinds) && kinds.every((kind) => typeof kind === 'string'))
  )
}

function isPushSubscription(value: unknown): value is MobilePushSubscriptionRecord {
  if (!isRecord(value)) return false
  if (typeof value['endpoint'] !== 'string') return false
  if (typeof value['updatedAt'] !== 'number') return false
  const keys = value['keys']
  if (!isRecord(keys)) return false
  return typeof keys['p256dh'] === 'string' && typeof keys['auth'] === 'string'
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
