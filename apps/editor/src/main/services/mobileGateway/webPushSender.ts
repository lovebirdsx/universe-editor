/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin, injectable wrapper over `web-push`. The notification router depends on
 *  the interface so tests never open a socket; only the default factory touches
 *  the real library.
 *--------------------------------------------------------------------------------------------*/

import { sendNotification } from 'web-push'
import type { MobilePushSubscription } from '@universe-editor/mobile-protocol'
import type { VapidKeyPair } from './vapidKeys.js'

/** Browsers cap push payloads around 4KB; reject before sending. */
export const MAX_PUSH_PAYLOAD_BYTES = 4096
export const DEFAULT_PUSH_TTL_SECONDS = 60 * 60

export type PushUrgency = 'high' | 'normal'

export interface WebPushSendOptions {
  readonly vapid: VapidKeyPair
  readonly subject: string
  readonly ttlSeconds?: number
  readonly urgency?: PushUrgency
}

export type WebPushSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly statusCode?: number; readonly error: string }

export interface WebPushSender {
  send(
    subscription: MobilePushSubscription,
    payload: string,
    options: WebPushSendOptions,
  ): Promise<WebPushSendResult>
}

/** Real sender. Endpoint host validation is the caller's job (`pushEndpoint.ts`). */
export function createWebPushSender(): WebPushSender {
  return {
    async send(subscription, payload, options) {
      const bytes = Buffer.byteLength(payload, 'utf8')
      if (bytes > MAX_PUSH_PAYLOAD_BYTES) {
        return { ok: false, error: `payload is ${bytes} bytes (max ${MAX_PUSH_PAYLOAD_BYTES})` }
      }
      try {
        await sendNotification(subscription, payload, {
          TTL: options.ttlSeconds ?? DEFAULT_PUSH_TTL_SECONDS,
          urgency: options.urgency ?? 'normal',
          timeout: 10_000,
          vapidDetails: {
            subject: options.subject,
            publicKey: options.vapid.publicKey,
            privateKey: options.vapid.privateKey,
          },
        })
        return { ok: true }
      } catch (err) {
        const statusCode = (err as { statusCode?: unknown }).statusCode
        return {
          ok: false,
          ...(typeof statusCode === 'number' ? { statusCode } : {}),
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}
