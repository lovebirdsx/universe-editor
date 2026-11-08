/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for the phone gateway. The main process owns the HTTP/WS
 *  server; the renderer only reads status, pairs devices and revokes them.
 *  `IMobileBridgeService` is the reverse channel M2 extends to project ACP
 *  sessions out of each window's renderer.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'

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

/** Reverse channel: implemented in each renderer, called from main. M2 extends it. */
export interface IMobileBridgeService {
  readonly _serviceBrand: undefined
  ping(): Promise<'pong'>
}

export const IMobileBridgeService = createDecorator<IMobileBridgeService>('mobileBridgeService')
