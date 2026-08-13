/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Message protocol between a watcher client and a WatcherHost. Kept
 *  dependency-free so every transport (utility process, remote tunnel, in-memory
 *  test transport) shares the exact same shapes.
 *--------------------------------------------------------------------------------------------*/

export interface WatcherSubscribeRequest {
  readonly kind: 'subscribe'
  readonly seq: number
  readonly id: number
  readonly dir: string
  readonly ignore: readonly string[]
}

export interface WatcherUnsubscribeRequest {
  readonly kind: 'unsubscribe'
  readonly seq: number
  readonly id: number
}

export type WatcherHostRequest = WatcherSubscribeRequest | WatcherUnsubscribeRequest

/** `error` present ⇔ the request failed. */
export interface WatcherAckResponse {
  readonly kind: 'ack'
  readonly seq: number
  readonly error?: string
}

export type WatcherRawEventType = 'create' | 'update' | 'delete'

export interface WatcherRawEvent {
  readonly path: string
  readonly type: WatcherRawEventType
}

export interface WatcherEventsResponse {
  readonly kind: 'events'
  readonly id: number
  readonly events: readonly WatcherRawEvent[]
}

/** Runtime error reported by the native watcher for a live subscription. */
export interface WatcherErrorResponse {
  readonly kind: 'watch-error'
  readonly id: number
  readonly error: string
}

export type WatcherHostResponse = WatcherAckResponse | WatcherEventsResponse | WatcherErrorResponse
