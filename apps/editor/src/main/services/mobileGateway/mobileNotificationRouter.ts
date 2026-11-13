/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Routes an attention edge to the phones that should hear about it.
 *
 *  Suppression matrix: a paired device receives a notification only when its
 *  own notification switch is on and the kind is enabled. When any PC window is
 *  focused, devices without `alwaysNotify` are skipped. A device with a visible
 *  WebSocket gets an in-app `notification` frame; otherwise (or in addition on
 *  another connection) the gateway sends a Web Push.
 *
 *  Payloads contain the session title and a fixed Chinese category line only —
 *  never prompt text, tool output or feedback, because Web Push travels through
 *  Apple / Google / Mozilla servers.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import type { ILogger } from '@universe-editor/platform'
import {
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  type MobileAttentionKind,
  type MobilePushSubscription,
  type MobileSessionRef,
  type NotificationFrame,
} from '@universe-editor/mobile-protocol'
import type {
  MobileNotificationPrefsRecord,
  MobileNotifyTarget,
  MobilePushSubscriptionRecord,
} from './deviceStore.js'
import type { VapidKeyPair } from './vapidKeys.js'
import {
  DEFAULT_PUSH_TTL_SECONDS,
  MAX_PUSH_PAYLOAD_BYTES,
  type PushUrgency,
  type WebPushSender,
} from './webPushSender.js'

export interface AttentionNotificationInput {
  readonly kind: MobileAttentionKind
  readonly ref: MobileSessionRef
  readonly title: string
  readonly agentName?: string
  readonly permissionTitle?: string
  /** Automated session: deliver even while a PC window is focused. */
  readonly alwaysNotify?: boolean
}

export interface MobileNotificationRouterOptions {
  readonly logger: ILogger
  readonly listTargets: () => Promise<readonly MobileNotifyTarget[]>
  readonly isPcFocused: () => boolean
  readonly isDeviceVisible: (deviceId: string) => boolean
  readonly sendToVisibleDevices: (deviceId: string, frame: NotificationFrame) => boolean
  readonly pushSender?: WebPushSender
  readonly vapid?: VapidKeyPair
  readonly subject: string
  /** Called when a push service reports the subscription is gone (404/410). */
  readonly onPushSubscriptionGone: (deviceId: string) => Promise<void>
  readonly now?: () => number
  readonly createId?: () => string
}

interface NotificationContent {
  readonly title: string
  readonly body: string
}

export class MobileNotificationRouter {
  private readonly _now: () => number
  private readonly _createId: () => string

  constructor(private readonly _options: MobileNotificationRouterOptions) {
    this._now = _options.now ?? Date.now
    this._createId = _options.createId ?? randomUUID
  }

  async notify(input: AttentionNotificationInput): Promise<void> {
    let targets: readonly MobileNotifyTarget[]
    try {
      targets = await this._options.listTargets()
    } catch (err) {
      this._options.logger.warn(`mobile notifications: failed to list devices: ${String(err)}`)
      return
    }
    if (targets.length === 0) return

    const focused = safeBoolean(this._options.isPcFocused)
    const content = buildNotificationContent(input)
    const at = this._now()
    const id = this._createId()
    const refKey = input.ref.durableId ?? input.ref.localId
    const url = `/s/${encodeURIComponent(refKey)}${
      input.kind === 'permission' ? '?focus=pending' : ''
    }`
    const tag = `session:${refKey}`

    for (const target of targets) {
      if (!wantsKind(target.notifications, input.kind)) continue
      // Automated-session attention bypasses the focus suppression: the trigger
      // may be waiting on an approval nobody is watching the PC for.
      if (focused && input.alwaysNotify !== true && !target.notifications.alwaysNotify) continue

      if (safeBoolean(() => this._options.isDeviceVisible(target.deviceId))) {
        const sent = this._options.sendToVisibleDevices(target.deviceId, {
          type: 'notification',
          id,
          kind: input.kind,
          ref: input.ref,
          title: content.title,
          body: content.body,
          at,
        })
        if (sent) continue
      }

      if (target.push === undefined) continue
      await this._sendPush(target.deviceId, target.push, input.kind, content, { id, url, tag, at })
    }
  }

  private async _sendPush(
    deviceId: string,
    push: MobilePushSubscriptionRecord,
    kind: MobileAttentionKind,
    content: NotificationContent,
    meta: { id: string; url: string; tag: string; at: number },
  ): Promise<void> {
    const sender = this._options.pushSender
    const vapid = this._options.vapid
    if (sender === undefined || vapid === undefined) return

    const payload = JSON.stringify({
      id: meta.id,
      kind,
      title: content.title,
      body: content.body,
      url: meta.url,
      tag: meta.tag,
      at: meta.at,
    })
    if (Buffer.byteLength(payload, 'utf8') > MAX_PUSH_PAYLOAD_BYTES) {
      this._options.logger.warn(`mobile push skipped: payload exceeds ${MAX_PUSH_PAYLOAD_BYTES}`)
      return
    }

    let result: Awaited<ReturnType<WebPushSender['send']>>
    try {
      result = await sender.send(subscriptionFor(push), payload, {
        vapid,
        subject: this._options.subject,
        ttlSeconds: DEFAULT_PUSH_TTL_SECONDS,
        urgency: urgencyFor(kind),
      })
    } catch (err) {
      this._options.logger.warn(
        `mobile push send failed device=${deviceId} kind=${kind}: ${String(err)}`,
      )
      return
    }
    if (result.ok) {
      this._options.logger.debug(`mobile push sent device=${deviceId} kind=${kind}`)
      return
    }
    if (result.statusCode === 404 || result.statusCode === 410) {
      this._options.logger.info(
        `mobile push subscription expired device=${deviceId} status=${result.statusCode}`,
      )
      try {
        await this._options.onPushSubscriptionGone(deviceId)
      } catch (err) {
        this._options.logger.warn(`mobile push cleanup failed: ${String(err)}`)
      }
      return
    }
    this._options.logger.warn(
      `mobile push failed device=${deviceId} kind=${kind} status=${result.statusCode ?? 'unknown'}: ${result.error}`,
    )
  }
}

export function buildNotificationContent(input: AttentionNotificationInput): NotificationContent {
  const fallbackTitle =
    input.agentName !== undefined && input.agentName !== '' ? input.agentName : 'Agent'
  const rawTitle = input.title.trim() !== '' ? input.title.trim() : fallbackTitle
  const title = clampText(rawTitle, MAX_TITLE_LENGTH)
  switch (input.kind) {
    case 'permission': {
      const tool = input.permissionTitle?.trim()
      const detail = tool !== undefined && tool !== '' ? tool : '需要你的确认'
      return { title, body: clampText(`等待审批：${detail}`, MAX_NOTIFICATION_BODY_LENGTH) }
    }
    case 'question':
      return { title, body: 'Agent 提问' }
    case 'completed':
      return { title, body: '已完成' }
    case 'errored':
      return { title, body: '出错' }
  }
}

function wantsKind(prefs: MobileNotificationPrefsRecord, kind: MobileAttentionKind): boolean {
  if (!prefs.enabled) return false
  return prefs.kinds === undefined || prefs.kinds.includes(kind)
}

function urgencyFor(kind: MobileAttentionKind): PushUrgency {
  return kind === 'permission' || kind === 'question' ? 'high' : 'normal'
}

function subscriptionFor(push: NonNullable<MobileNotifyTarget['push']>): MobilePushSubscription {
  return { endpoint: push.endpoint, keys: { p256dh: push.keys.p256dh, auth: push.keys.auth } }
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function safeBoolean(read: () => boolean): boolean {
  try {
    return read()
  } catch {
    return false
  }
}
