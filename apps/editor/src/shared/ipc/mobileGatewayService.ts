/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for the phone gateway. The main process owns the HTTP/WS
 *  server; the renderer only reads status, pairs devices and revokes them.
 *  `IMobileBridgeService` is the reverse channel M2 extends to project ACP
 *  sessions out of each window's renderer.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'
import type {
  MobileSessionBucket,
  MobileSessionEvent,
  MobileSessionSnapshot,
  MobileToolCallDetail,
} from '@universe-editor/mobile-protocol'

export const MOBILE_GATEWAY_DEFAULT_PORT = 47321

export type MobileGatewayState = 'stopped' | 'starting' | 'running' | 'error'

export type MobileGatewayBindMode = 'loopback' | 'lan'

/** Settings mirrored from the renderer's `mobileGateway.*` configuration. */
export interface MobileGatewayConfig {
  readonly enabled: boolean
  readonly bind: MobileGatewayBindMode
  /** LAN address to bind in `lan` mode; empty means the first non-internal IPv4. */
  readonly lanAddress: string
  readonly port: number
  /** Extra Host values accepted on top of the bind address / loopback. */
  readonly allowedHosts: readonly string[]
}

export interface MobileGatewayCapabilities {
  /** True when at least one origin is HTTPS (service worker / installability). */
  readonly installable: boolean
  /** True when at least one origin is HTTPS (Web Push requires a secure context). */
  readonly push: boolean
}

export interface MobileGatewayStatus {
  readonly state: MobileGatewayState
  readonly error?: string
  /** Actual `host:port` while listening. */
  readonly listenAddress?: string
  /** URL origins the phone can open, ordered loopback/lan first, then allowed hosts. */
  readonly origins: readonly string[]
  /** True when HTTP is bound to a non-loopback address (development only). */
  readonly insecure: boolean
  readonly bind: MobileGatewayBindMode
  readonly capabilities: MobileGatewayCapabilities
  readonly connectedDeviceCount: number
}

export interface MobileDeviceInfo {
  readonly deviceId: string
  readonly name: string
  readonly platform: string
  /** Epoch milliseconds. */
  readonly createdAt: number
  /** Epoch milliseconds. */
  readonly lastSeenAt: number
  /** Whether this device currently has at least one WebSocket connection. */
  readonly connected: boolean
}

export interface MobilePairingSession {
  /** Display form `XXXX-XXXX`; shown on the PC only, never logged or audited. */
  readonly code: string
  /** Epoch milliseconds; `Number.MAX_SAFE_INTEGER` for the fixed e2e code. */
  readonly expiresAt: number
  /** `buildPairUrl` for every current origin. */
  readonly pairUrls: readonly string[]
}

export interface MobileAuditEntry {
  readonly ts: number
  readonly deviceId?: string
  readonly deviceName?: string
  readonly remoteAddress?: string
  readonly action: string
  readonly result: 'success' | 'failure'
  readonly detail?: string
}

/** Forward channel: implemented in main, consumed by the PC settings page. */
export interface IMobileGatewayService {
  readonly _serviceBrand: undefined

  getStatus(): Promise<MobileGatewayStatus>
  readonly onDidChangeStatus: Event<MobileGatewayStatus>

  /** Mint a one-time pairing code. A new call invalidates the previous code. */
  startPairing(): Promise<MobilePairingSession>
  cancelPairing(): Promise<void>

  listDevices(): Promise<readonly MobileDeviceInfo[]>
  /** Revoke and immediately disconnect every connection of that device. */
  revokeDevice(deviceId: string): Promise<void>
  readonly onDidChangeDevices: Event<readonly MobileDeviceInfo[]>

  getRecentAudit(limit: number): Promise<readonly MobileAuditEntry[]>

  /**
   * Push the current `mobileGateway.*` settings. Main reads settings.json at
   * startup; the renderer calls this on every relevant configuration change so
   * toggling the feature takes effect without a restart.
   */
  applyConfig(config: MobileGatewayConfig): Promise<void>
}

export const IMobileGatewayService = createDecorator<IMobileGatewayService>('mobileGatewayService')

/**
 * Renderer-side session reference. A renderer cannot know its own window id, so
 * the main gateway fills `windowId` (and `workspaceName`) when it converts these
 * DTOs into protocol frames.
 */
export interface MobileBridgeSessionRef {
  readonly localId: string
  readonly durableId?: string
}

/**
 * Inbox row as produced by one renderer. Same fields as the wire summary minus
 * the main-owned `ref.windowId` / `workspaceName`.
 */
export interface MobileBridgeSessionSummary {
  readonly localId: string
  readonly durableId?: string
  readonly agentId: string
  readonly agentName?: string
  readonly title: string
  /** Raw `AcpSessionStatus`. */
  readonly status: string
  /** `computeSessionDisplayStatus` result. */
  readonly displayStatus: string
  readonly bucket: MobileSessionBucket
  readonly cwd?: string
  readonly authority?: string
  readonly readOnly: boolean
  readonly hasPendingPermission: boolean
  readonly hasPendingElicitation: boolean
  readonly backgroundTaskCount: number
  readonly updatedAt: number
}

export interface MobileBridgeSessionSnapshot extends Omit<
  MobileSessionSnapshot,
  'seq' | 'summary'
> {
  readonly summary: MobileBridgeSessionSummary
}

/**
 * `summary_changed` carries the renderer projection; every other delta event is
 * already window-independent and travels unchanged.
 */
export type MobileBridgeSessionEvent =
  | Exclude<MobileSessionEvent, { type: 'summary_changed' }>
  | { readonly type: 'summary_changed'; readonly summary: MobileBridgeSessionSummary }

export interface MobileBridgeInboxChange {
  readonly kind: 'inbox'
  readonly upserts: readonly MobileBridgeSessionSummary[]
  readonly removes: readonly MobileBridgeSessionRef[]
}

export interface MobileBridgeSessionDelta {
  readonly kind: 'session_delta'
  readonly localId: string
  readonly events: readonly MobileBridgeSessionEvent[]
}

export type MobileBridgeEvent = MobileBridgeInboxChange | MobileBridgeSessionDelta

/** Reverse channel: implemented in each renderer, called from main. */
export interface IMobileBridgeService {
  readonly _serviceBrand: undefined

  /** Cheap liveness probe kept from M1. */
  ping(): Promise<'pong'>

  /** Current inbox rows for this window (no streaming state required). */
  listSessions(): Promise<readonly MobileBridgeSessionSummary[]>

  /** Full read-only state for one session. */
  getSnapshot(localId: string): Promise<MobileBridgeSessionSnapshot | undefined>

  /**
   * Begin observing sessions. Until this is called the bridge performs no
   * serialization at all, so a PC without a paired phone pays zero cost.
   * Idempotent; main calls it when the first phone subscribes to the inbox.
   */
  startStreaming(): Promise<void>

  /** Stop observing and release every watcher (last phone unsubscribed). */
  stopStreaming(): Promise<void>

  /** Full tool-call body; undefined when the session/tool call is gone. */
  getToolCallDetail(localId: string, toolCallId: string): Promise<MobileToolCallDetail | undefined>

  /**
   * Inbox deltas and per-session delta batches. Per-session text is coalesced
   * (~50ms; ~100ms while a single message grows by more than 64K chars) and
   * deltas carry only suffixes.
   */
  readonly onDidChange: Event<MobileBridgeEvent>
}

export const IMobileBridgeService = createDecorator<IMobileBridgeService>('mobileBridgeService')
