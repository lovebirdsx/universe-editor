/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for the phone gateway. The main process owns the HTTP/WS
 *  server; the renderer only reads status, pairs devices and revokes them.
 *  `IMobileBridgeService` is the reverse channel M2 extends to project ACP
 *  sessions out of each window's renderer.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'
import type {
  MobileAgentCandidate,
  MobileAttentionKind,
  MobileElicitationAction,
  MobileElicitationContentValue,
  MobileErrorCode,
  MobileSessionBucket,
  MobileSessionEvent,
  MobileSessionSnapshot,
  MobileToolCallDetail,
  MobileWorkspaceCandidate,
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
  /** VAPID `sub` claim: a `mailto:` address or an `https:` URL. */
  readonly vapidSubject: string
}

export interface MobileGatewayCapabilities {
  /** True when a trusted HTTPS origin exists (Service Worker / installability). */
  readonly installable: boolean
  /** True when a trusted HTTPS origin exists (Web Push requires a secure context). */
  readonly push: boolean
}

export interface MobileGatewayCertificateInfo {
  /** Lowercase hex SHA-256; the pairing link and phone pair page show it. */
  readonly fingerprint: string
  /** SAN entries: the bound LAN address and the PC host name. */
  readonly addresses: readonly string[]
  /** Epoch milliseconds. */
  readonly expiresAt: number
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
  /** Present on the LAN tier while its self-signed certificate is loaded. */
  readonly certificate?: MobileGatewayCertificateInfo
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
  /** Whether the phone turned on notifications for this device. */
  readonly notificationsEnabled: boolean
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

/**
 * A session needs attention: permission / question / completion / error edge.
 * `title` / `agentName` / `permissionTitle` let main build a push payload even
 * when no inbox subscriber ever asked for the session (attention-only mode).
 * Never carries prompt text or tool output.
 */
export interface MobileBridgeAttentionEvent {
  readonly kind: 'attention'
  readonly localId: string
  readonly durableId?: string
  readonly attentionKind: MobileAttentionKind
  readonly title: string
  readonly agentName?: string
  readonly permissionTitle?: string
}

export type MobileBridgeEvent =
  | MobileBridgeInboxChange
  | MobileBridgeSessionDelta
  | MobileBridgeAttentionEvent

/** Bridge-level command failure. `code` is the protocol error code sent back to the phone. */
export interface MobileBridgeCommandError {
  readonly ok: false
  readonly code: MobileErrorCode
  readonly message: string
}

/**
 * Result of a mutating command. Validation happens twice: the bridge rejects
 * first (read-only / stale / high-risk), and the gateway re-checks what it can
 * before routing. Renderer exceptions are folded into `internal` by the bridge.
 */
export type MobileBridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | MobileBridgeCommandError

export interface MobileBridgeNewSessionResult {
  readonly localId: string
  readonly durableId?: string
}

export interface MobileBridgeNewSessionWorkspace {
  /** Workspace folder as a URI string; the bridge stores it as the session cwd. */
  readonly folder: string
  readonly authority?: string
}

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

  /**
   * Lightweight attention-only watch. Runs while any paired device has
   * notifications enabled, even with no inbox/session subscriber, so a phone in
   * the background can still receive Web Push. Idempotent and independent of
   * `startStreaming()`.
   */
  startAttention(): Promise<void>

  stopAttention(): Promise<void>

  /** Full tool-call body; undefined when the session/tool call is gone. */
  getToolCallDetail(localId: string, toolCallId: string): Promise<MobileToolCallDetail | undefined>

  // ---- Mutating commands (M3) -------------------------------------------------

  sendPrompt(localId: string, text: string): Promise<MobileBridgeResult<void>>

  cancelTurn(localId: string): Promise<MobileBridgeResult<void>>

  resolvePermission(
    localId: string,
    requestId: string,
    optionId: string,
    feedback?: string,
  ): Promise<MobileBridgeResult<void>>

  cancelPermission(localId: string, requestId: string): Promise<MobileBridgeResult<void>>

  resolveElicitation(
    localId: string,
    requestId: string,
    action: MobileElicitationAction,
    content?: Record<string, MobileElicitationContentValue>,
  ): Promise<MobileBridgeResult<void>>

  setConfigOption(
    localId: string,
    configId: string,
    value: string | boolean,
  ): Promise<MobileBridgeResult<void>>

  pauseAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>>

  resumeAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>>

  newSession(
    agentId: string,
    workspace: MobileBridgeNewSessionWorkspace,
    initialPrompt?: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>

  renameSession(localId: string, title: string): Promise<MobileBridgeResult<void>>

  /** Runs the same plan/execute path as the PC "Delete Agent Session" command. */
  deleteSession(localId: string): Promise<MobileBridgeResult<void>>

  /** This window's open workspace (main merges it with recent workspaces). */
  listWorkspaces(): Promise<readonly MobileWorkspaceCandidate[]>

  /** Agents this window can start a session with. */
  listAgents(): Promise<readonly MobileAgentCandidate[]>

  /**
   * Inbox deltas and per-session delta batches. Per-session text is coalesced
   * (~50ms; ~100ms while a single message grows by more than 64K chars) and
   * deltas carry only suffixes.
   */
  readonly onDidChange: Event<MobileBridgeEvent>
}

export const IMobileBridgeService = createDecorator<IMobileBridgeService>('mobileBridgeService')
