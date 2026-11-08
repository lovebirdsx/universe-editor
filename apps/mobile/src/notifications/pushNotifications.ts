/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Web Push capability detection and subscription helpers for the phone PWA.
 *  Kept as pure functions over injected browser surfaces so the settings UI and
 *  its tests can drive them without a real service worker.
 *--------------------------------------------------------------------------------------------*/

import type { MobilePushSubscription } from '@universe-editor/mobile-protocol'

export type NotificationBlocker =
  | 'insecure'
  | 'notification-unsupported'
  | 'push-unsupported'
  | 'ios-not-standalone'

export interface NotificationCapability {
  readonly secureContext: boolean
  readonly notificationSupported: boolean
  readonly pushSupported: boolean
  readonly standalone: boolean
  readonly ios: boolean
  /** First reason notifications cannot be enabled, or undefined when supported. */
  readonly blocker?: NotificationBlocker
}

export interface CapabilityEnvironment {
  readonly secureContext?: boolean
  readonly notificationSupported?: boolean
  readonly pushSupported?: boolean
  readonly standalone?: boolean
  readonly ios?: boolean
}

export function detectNotificationCapability(
  env: CapabilityEnvironment = readBrowserCapability(),
): NotificationCapability {
  const secureContext = env.secureContext === true
  const notificationSupported = env.notificationSupported === true
  const pushSupported = env.pushSupported === true
  const standalone = env.standalone === true
  const ios = env.ios === true

  let blocker: NotificationBlocker | undefined
  if (!secureContext) blocker = 'insecure'
  else if (!notificationSupported) blocker = 'notification-unsupported'
  else if (!pushSupported) blocker = 'push-unsupported'
  // iOS only exposes PushManager from an installed (standalone) PWA.
  else if (ios && !standalone) blocker = 'ios-not-standalone'

  return {
    secureContext,
    notificationSupported,
    pushSupported,
    standalone,
    ios,
    ...(blocker !== undefined ? { blocker } : {}),
  }
}

/** Snapshot the current browser. Safe to call in tests because every lookup is guarded. */
export function readBrowserCapability(): CapabilityEnvironment {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { secureContext: false, notificationSupported: false, pushSupported: false }
  }
  return {
    secureContext: window.isSecureContext === true,
    notificationSupported: 'Notification' in window,
    pushSupported: 'PushManager' in window,
    standalone: isStandalone(),
    ios: isIos(),
  }
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  if (navigatorWithStandalone.standalone === true) return true
  if (typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(display-mode: standalone)').matches
  } catch {
    return false
  }
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ identifies as Macintosh; touch points are the reliable tell.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

export interface PushSubscriptionLike {
  readonly endpoint: string
  readonly keys?: {
    readonly p256dh?: string
    readonly auth?: string
  }
  toJSON?(): unknown
  unsubscribe?(): Promise<boolean>
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(options: {
    readonly userVisibleOnly: boolean
    readonly applicationServerKey: Uint8Array
  }): Promise<PushSubscriptionLike>
}

export interface PushRegistrationLike {
  readonly pushManager: PushManagerLike
}

export interface PushEnvironment {
  readonly permission: NotificationPermission
  readonly requestPermission: () => Promise<NotificationPermission>
  readonly registration: Promise<PushRegistrationLike>
  readonly applicationServerKey: string
}

export type EnablePushResult =
  | { readonly ok: true; readonly subscription: MobilePushSubscription }
  | {
      readonly ok: false
      readonly reason: 'denied' | 'unsupported' | 'failed'
      readonly error?: string
    }

/**
 * Must run inside the user gesture: requests permission, waits for the service
 * worker registration, then subscribes. Returns the wire shape the gateway
 * stores, not the browser object.
 */
export async function enablePushNotifications(env: PushEnvironment): Promise<EnablePushResult> {
  let permission: NotificationPermission
  try {
    permission = env.permission === 'granted' ? 'granted' : await env.requestPermission()
  } catch (err) {
    return { ok: false, reason: 'failed', error: messageOf(err) }
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' }

  let key: Uint8Array
  try {
    key = base64UrlToUint8Array(env.applicationServerKey)
  } catch (err) {
    return { ok: false, reason: 'unsupported', error: messageOf(err) }
  }
  if (key.byteLength === 0) return { ok: false, reason: 'unsupported' }

  try {
    const registration = await env.registration
    const existing = await registration.pushManager.getSubscription().catch(() => null)
    if (existing !== null) {
      const wire = toWireSubscription(existing)
      if (wire !== undefined) return { ok: true, subscription: wire }
    }
    const created = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    })
    const wire = toWireSubscription(created)
    if (wire === undefined) {
      return { ok: false, reason: 'unsupported', error: 'incomplete push subscription' }
    }
    return { ok: true, subscription: wire }
  } catch (err) {
    return { ok: false, reason: 'failed', error: messageOf(err) }
  }
}

export function toWireSubscription(
  value: PushSubscriptionLike,
): MobilePushSubscription | undefined {
  const raw = value.toJSON?.() ?? value
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as {
    endpoint?: unknown
    keys?: { p256dh?: unknown; auth?: unknown }
  }
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint : value.endpoint
  const p256dh = record.keys?.p256dh
  const auth = record.keys?.auth
  if (typeof endpoint !== 'string' || endpoint === '') return undefined
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return undefined
  return { endpoint, keys: { p256dh, auth } }
}

/** `applicationServerKey` is base64url; the browser wants raw bytes. */
export function base64UrlToUint8Array(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
