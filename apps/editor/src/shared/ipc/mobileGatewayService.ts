/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for the phone gateway. The main process owns the HTTP/WS
 *  server and the machine-local `gateway.json`; the renderer reads status,
 *  updates the config, pairs devices and revokes them.
 *  `IMobileBridgeService` is the reverse channel M2 extends to project ACP
 *  sessions out of each window's renderer.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type CancellationToken, type Event } from '@universe-editor/platform'
import type {
  MobileAgentCandidate,
  MobileAttentionKind,
  MobileDeliveryDetail,
  MobileDeliveryExpectation,
  MobileDeliveryPreview,
  MobileDeliveryStartResult,
  MobileDeliverySummary,
  MobileDraftContextSummary,
  MobileDraftFileRef,
  MobileDraftImageRef,
  MobileDraftRefSummary,
  MobileElicitationAction,
  MobileElicitationContentValue,
  MobileErrorCode,
  MobilePushBranchExpectation,
  MobilePushBranchPreview,
  MobilePushBranchResult,
  MobilePromptRef,
  MobilePromptRefSuggestion,
  MobilePromptRefTrigger,
  MobileRewindPreview,
  MobileRewindResult,
  MobileSessionBucket,
  MobileSessionEvent,
  MobileSessionSettings,
  MobileSessionSnapshot,
  MobileSideTaskSummary,
  MobileToolCallDetail,
  MobileWorkspaceCandidate,
  ResolvePromptRefRequest,
  ResolvePromptRefResult,
} from '@universe-editor/mobile-protocol'

export const MOBILE_GATEWAY_DEFAULT_PORT = 47321
export const MOBILE_GATEWAY_DEFAULT_SESSION_HISTORY_WORKSPACE_LIMIT = 20
export const MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT = 100

export type MobileGatewayState = 'stopped' | 'starting' | 'running' | 'error'

export type MobileGatewayBindMode = 'loopback' | 'lan'

/**
 * `self-signed` is a single leaf the phone accepts per-origin (browser warning).
 * `root-ca` adds a reusable root certificate the phone can install and trust;
 * the leaf is reissued behind that stable root.
 */
export type MobileGatewayCertificateMode = 'self-signed' | 'root-ca'

/**
 * Machine-local gateway configuration persisted to `<userData>/mobile/gateway.json`.
 * It deliberately stays out of settings.json: the config directory may be shared
 * across machines, while gateway settings must differ per machine.
 */
export interface MobileGatewayConfig {
  readonly enabled: boolean
  readonly bind: MobileGatewayBindMode
  /** LAN address to bind in `lan` mode; empty means the best auto-detected adapter. */
  readonly lanAddress: string
  readonly port: number
  /** Extra Host values accepted on top of the bind address / loopback. */
  readonly allowedHosts: readonly string[]
  readonly certificateMode: MobileGatewayCertificateMode
  /** VAPID `sub` claim: a `mailto:` address or an `https:` URL. */
  readonly vapidSubject: string
  /**
   * How many recently opened (but currently closed) workspaces contribute
   * resumable history to the phone catalog. Open windows are always included.
   */
  readonly sessionHistoryWorkspaceLimit: number
  /** Keep the gateway (and the editor process) alive after the last window closes. */
  readonly keepRunningInBackground: boolean
  /** Register an OS login item that starts the editor in the background. */
  readonly launchAtLogin: boolean
}

export const DEFAULT_MOBILE_GATEWAY_CONFIG: MobileGatewayConfig = {
  enabled: false,
  bind: 'loopback',
  lanAddress: '',
  port: MOBILE_GATEWAY_DEFAULT_PORT,
  allowedHosts: [],
  certificateMode: 'self-signed',
  // Placeholder per the repository's public-value policy. Override with a real
  // `mailto:` or `https:` URL before relying on push in the field.
  vapidSubject: 'https://universe-editor.example.com',
  sessionHistoryWorkspaceLimit: MOBILE_GATEWAY_DEFAULT_SESSION_HISTORY_WORKSPACE_LIMIT,
  keepRunningInBackground: false,
  launchAtLogin: false,
}

/** Field-level update. `allowedHosts` replaces the whole list. */
export interface MobileGatewayConfigPatch {
  readonly enabled?: boolean
  readonly bind?: MobileGatewayBindMode
  readonly lanAddress?: string
  readonly port?: number
  readonly allowedHosts?: readonly string[]
  readonly certificateMode?: MobileGatewayCertificateMode
  readonly vapidSubject?: string
  readonly sessionHistoryWorkspaceLimit?: number
  readonly keepRunningInBackground?: boolean
  readonly launchAtLogin?: boolean
}

/**
 * `config` is the last valid configuration. `error` is set when the file exists
 * but cannot be parsed or validated; the running gateway keeps using `config`.
 */
export interface MobileGatewayConfigState {
  readonly config: MobileGatewayConfig
  readonly error?: string
}

export type MobileGatewayConfigUpdateResult =
  | { readonly ok: true; readonly state: MobileGatewayConfigState }
  | {
      readonly ok: false
      readonly state: MobileGatewayConfigState
      readonly errors: readonly string[]
    }

export interface MobileGatewayCapabilities {
  /** True when a trusted HTTPS origin exists (Service Worker / installability). */
  readonly installable: boolean
  /** True when a trusted HTTPS origin exists (Web Push requires a secure context). */
  readonly push: boolean
}

export interface MobileGatewayCertificateInfo {
  /** Lowercase hex SHA-256 of the leaf; the pairing link and phone pair page show it. */
  readonly fingerprint: string
  /** SAN entries: the bound LAN address and the PC host name. */
  readonly addresses: readonly string[]
  /** Epoch milliseconds. */
  readonly expiresAt: number
  /** Root CA fingerprint (root-ca mode only); this is what the phone installs. */
  readonly caFingerprint?: string
  /** Root CA expiry (root-ca mode only). */
  readonly caExpiresAt?: number
}

/**
 * A phone rejected the gateway certificate during the TLS handshake. This is the
 * layer below HTTP/WS: the request never reaches the gateway, so only the audit
 * trail (and this status field) reveals it.
 */
export interface MobileGatewayTlsTrustWarning {
  /** Epoch milliseconds of the most recent rejected handshake. */
  readonly at: number
  /** Remote address of the rejecting client. */
  readonly remoteAddress: string
}

export interface MobileGatewayStatus {
  readonly state: MobileGatewayState
  readonly error?: string
  /** Actual `host:port` while listening. */
  readonly listenAddress?: string
  /**
   * Usable IPv4 candidates for `lan` mode, best first. Link-local (169.254/16)
   * addresses are already excluded; the settings page uses this as the picker.
   */
  readonly lanAddresses: readonly string[]
  /** URL origins the phone can open, ordered loopback/lan first, then allowed hosts. */
  readonly origins: readonly string[]
  /**
   * Optional HTTPS origin built from the PC host name (LAN + TLS only). It sits
   * after the IP origin because the name may resolve to Tailscale/WSL addresses;
   * iOS 26 can fall back to it when bare-IP `ws` fails.
   */
  readonly lanHostnameOrigin?: string
  /** True when HTTP is bound to a non-loopback address (development only). */
  readonly insecure: boolean
  readonly bind: MobileGatewayBindMode
  readonly capabilities: MobileGatewayCapabilities
  readonly connectedDeviceCount: number
  /** This build can register an OS login item: packaged Windows / macOS only. */
  readonly supportsLaunchAtLogin: boolean
  /** Present on the LAN tier while its TLS certificate is loaded. */
  readonly certificate?: MobileGatewayCertificateInfo
  /** Same-origin download URL for the root CA (root-ca + LAN + TLS only). */
  readonly caDownloadUrl?: string
  /**
   * Set while a client has recently rejected the TLS certificate. Cleared when
   * the gateway restarts; the phone may otherwise stay on a cached app shell
   * that can never reach the gateway.
   */
  readonly tlsTrustWarning?: MobileGatewayTlsTrustWarning
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

  /** Persisted machine-local config (not the environment-overridden runtime values). */
  getConfig(): Promise<MobileGatewayConfigState>

  /**
   * Merge a field-level patch into the persisted config, validate it, write
   * `gateway.json` atomically and apply the result at runtime.
   */
  updateConfig(patch: MobileGatewayConfigPatch): Promise<MobileGatewayConfigUpdateResult>

  readonly onDidChangeConfig: Event<MobileGatewayConfigState>

  /** `file:` URI of `<userData>/mobile/gateway.json`; does not create the file. */
  getConfigFileUri(): Promise<string>

  /** Create the config file with defaults when missing, then return its URI. */
  ensureConfigFile(): Promise<string>
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
  /** Whether the agent accepts prompt images; absent until the handshake reports it. */
  readonly imageSupported?: boolean
  /** Agent advertised `sessionCapabilities.fork`. */
  readonly forkSupported?: boolean
  /** Agent advertised the universe rewind ext-method capability. */
  readonly rewindSupported?: boolean
  /** Durable id of the parent session when this row is a side task. */
  readonly sideTaskOf?: string
  /** Number of direct side-task children (parent rows only). */
  readonly sideTaskChildCount?: number
  /** Latest agent delivery for this row's worktree (protocol projection). */
  readonly delivery?: MobileDeliverySummary
  /** Idle, writable session whose worktree is dirty or holds commits main lacks. */
  readonly deliveryAvailable?: boolean
  readonly updatedAt: number
}

/** Renderer-side delivery summary; same shape as the wire projection. */
export interface MobileBridgeDeliveryContext {
  readonly sourceCwd: string
  readonly authority?: string
  readonly deliveryId?: string
  readonly phase?: string
  readonly mainWorktree?: string
}

/**
 * One session-history row as projected by a renderer. Main adds `windowId` and
 * the workspace display name; live rows are merged on the phone from the inbox
 * mirror, so this shape stays history-only.
 */
export interface MobileBridgeSessionHistoryEntry {
  /** Agent-issued durable id (`sessionIdOnAgent`). */
  readonly durableId: string
  readonly agentId: string
  readonly agentName?: string
  readonly title: string
  /** First content-bearing user prompt, already capped for the wire. */
  readonly firstPrompt?: string
  readonly cwd?: string
  readonly authority?: string
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly pinned?: boolean
}

export interface MobileBridgeSessionSnapshot extends Omit<
  MobileSessionSnapshot,
  'seq' | 'summary' | 'draft'
> {
  readonly summary: MobileBridgeSessionSummary
  /** Renderer-side draft; main stamps the gateway-assigned revision and source. */
  readonly draft?: MobileBridgeDraft
}

/** Draft content produced by a renderer; the gateway owns revision/order. */
export interface MobileBridgeDraft {
  readonly text: string
  readonly images: readonly MobileDraftImageRef[]
  readonly files?: readonly MobileDraftFileRef[]
  readonly refs?: readonly MobileDraftRefSummary[]
  readonly contexts?: readonly MobileDraftContextSummary[]
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

export interface MobileBridgeDraftChange {
  readonly kind: 'draft'
  readonly localId: string
  /** Absent means the draft was cleared (submitted / session closed). */
  readonly draft: MobileBridgeDraft | undefined
}

export type MobileBridgeEvent =
  | MobileBridgeInboxChange
  | MobileBridgeSessionDelta
  | MobileBridgeAttentionEvent
  | MobileBridgeDraftChange

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
  /**
   * Workspace-relative session directory (`/`-separated); the bridge resolves
   * and validates it against `folder`. Omitted = the workspace root.
   */
  readonly relativePath?: string
}

/**
 * Raw image bytes for the gateway's session-image endpoints. Main proxies the
 * request to the renderer and writes the bytes to the HTTP response; they never
 * travel over the WebSocket.
 */
export interface MobileBridgeImage {
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/**
 * One phone-uploaded attachment resolved by main for the authenticated device.
 * Images carry raw base64 (they become ACP `image` blocks); files carry a
 * `file:` URI that the agent reads from the PC (they become `resource_link`s).
 */
export type MobileBridgePromptAttachment =
  | {
      readonly kind: 'image'
      readonly id: string
      readonly name: string
      readonly mimeType: string
      readonly byteSize: number
      readonly dataBase64: string
    }
  | {
      readonly kind: 'file'
      readonly id: string
      readonly name: string
      readonly mimeType: string
      readonly byteSize: number
      readonly uri: string
    }

/** Reverse channel: implemented in each renderer, called from main. */
export interface IMobileBridgeService {
  readonly _serviceBrand: undefined

  /**
   * Cheap liveness probe kept from M1. A token lets a caller abandon a probe
   * whose frame may never settle (renderer listener not installed yet); the
   * proxy lifts it out of the argument list, so implementations ignore it.
   */
  ping(token?: CancellationToken): Promise<'pong'>

  /**
   * Any git source control in this window reports changes. Used by the main
   * gateway for remote windows, whose git extension runs in the remote host.
   * Returns undefined when no git provider has reported a count yet.
   */
  getWorkspaceGitDirty(token?: CancellationToken): Promise<boolean | undefined>

  /** Current inbox rows for this window (no streaming state required). */
  listSessions(token?: CancellationToken): Promise<readonly MobileBridgeSessionSummary[]>

  /**
   * Resumable history rows owned by this window (side tasks, archived and
   * never-messaged sessions excluded). Cheap: reads the in-memory history
   * mirror, no agent round-trip.
   */
  listSessionHistory(token?: CancellationToken): Promise<readonly MobileBridgeSessionHistoryEntry[]>

  /** True when this window's history can resume `durableId`; used for routing. */
  hasSessionHistory(durableId: string, token?: CancellationToken): Promise<boolean>

  /**
   * Resume a history-only session without activating it in the PC window.
   * Returns the live ref, or a protocol error when the row is unknown / foreign.
   */
  openSession(
    durableId: string,
    token?: CancellationToken,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>

  /** Full read-only state for one session. */
  getSnapshot(
    localId: string,
    token?: CancellationToken,
  ): Promise<MobileBridgeSessionSnapshot | undefined>

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

  /**
   * Read-only `@` / `#` completion for a session. `limit` is required so the
   * proxy never has to carry a mid-argument `undefined` (it would become null).
   */
  searchPromptRefs(
    localId: string,
    trigger: MobilePromptRefTrigger,
    query: string,
    limit: number,
  ): Promise<MobileBridgeResult<readonly MobilePromptRefSuggestion[]>>

  /**
   * Second step for `#` entries that cannot be listed in one query: commit
   * history (returns final commit entries) and extension chatContext (runs the
   * provider's own picker on this PC). Object parameter so optional fields keep
   * their `undefined` identity across IPC.
   */
  resolvePromptRef(
    localId: string,
    request: ResolvePromptRefRequest,
  ): Promise<MobileBridgeResult<ResolvePromptRefResult>>

  /** The `index`-th ACP image block of a message; undefined when unavailable. */
  getMessageImage(
    localId: string,
    messageId: string,
    index: number,
    token?: CancellationToken,
  ): Promise<MobileBridgeImage | undefined>

  /** A markdown-referenced workspace file image, resolved against the session cwd. */
  getWorkspaceImage(
    localId: string,
    src: string,
    token?: CancellationToken,
  ): Promise<MobileBridgeImage | undefined>

  /**
   * Apply a draft authored by the phone. Writes the renderer's draft cache even
   * when no PromptInput is mounted; the next mount restores it.
   */
  applyDraft(localId: string, draft: MobileBridgeDraft): Promise<MobileBridgeResult<void>>

  /**
   * The revision the gateway assigned to the phone draft just passed to
   * `applyDraft`. The renderer uses it to settle a deferred remote apply
   * against its own local publish order.
   */
  noteDraftRevision(localId: string, revision: number): Promise<void>

  /**
   * The revision the gateway assigned to a draft this renderer published.
   * Every local publish awaits this ack before it accepts an older remote draft.
   */
  ackDraftRevision(localId: string, revision: number): Promise<void>

  /**
   * Bytes for a picture the PC pasted into the draft. `undefined` when the id
   * is not (or no longer) part of the draft.
   */
  getDraftImage(
    localId: string,
    imageId: string,
    token?: CancellationToken,
  ): Promise<MobileBridgeImage | undefined>

  /**
   * Materialize phone-uploaded attachments into the draft cache. Called when a
   * phone draft first references them, so PromptInput can render the chips.
   */
  attachDraftAttachments(
    localId: string,
    attachments: readonly MobileBridgePromptAttachment[],
  ): Promise<MobileBridgeResult<void>>

  /** Draft attachments (PC-pasted images / another phone's files), ready to be sent. */
  resolveDraftAttachments(
    localId: string,
    imageIds: readonly string[],
    fileIds?: readonly string[],
  ): Promise<MobileBridgeResult<readonly MobileBridgePromptAttachment[]>>

  /** Drop the shared draft after a prompt was sent (from either side). */
  clearDraft(localId: string): Promise<MobileBridgeResult<void>>

  // ---- Mutating commands (M3) -------------------------------------------------

  sendPrompt(
    localId: string,
    text: string,
    attachments?: readonly MobileBridgePromptAttachment[],
    refs?: readonly MobilePromptRef[],
  ): Promise<MobileBridgeResult<void>>

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

  /**
   * On-demand session settings. The subagent value comes from an async
   * `settings.json` read on the session's host, so it is not part of the
   * observable snapshot stream.
   */
  getSessionSettings(localId: string): Promise<MobileBridgeResult<MobileSessionSettings>>

  /**
   * Write the subagent model env pair (`CLAUDE_CODE_SUBAGENT_MODEL` +
   * `_FORCE`) into the session host's settings file. `null` clears both.
   */
  setSubagentModel(localId: string, model: string | null): Promise<MobileBridgeResult<void>>

  /** Respawn the agent process so spawn-time env (subagent model) is re-read. */
  restartAgentProcess(localId: string): Promise<MobileBridgeResult<void>>

  /** Pin this session's MCP whitelist; `null` restores the default set. */
  setSessionMcpServers(
    localId: string,
    servers: readonly string[] | null,
  ): Promise<MobileBridgeResult<void>>

  pauseAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>>

  resumeAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>>

  /**
   * A trailing token lets the gateway abandon a request whose frame may be
   * lost while the renderer boots, so it cannot create a session after the
   * phone already received a timeout.
   *
   * `initialPrompt` must be `null` rather than `undefined` when absent: the
   * proxy strips a trailing `undefined` before sending, which would shift the
   * cancellation token into the prompt slot on the renderer side.
   */
  newSession(
    agentId: string,
    workspace: MobileBridgeNewSessionWorkspace,
    initialPrompt: string | null,
    token?: CancellationToken,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>

  renameSession(localId: string, title: string): Promise<MobileBridgeResult<void>>

  /**
   * Ends the live session and closes its editor tab, but keeps the history row
   * so it can be resumed on the PC. Same effect as closing the tab locally.
   */
  closeSession(localId: string): Promise<MobileBridgeResult<void>>

  /** Runs the same plan/execute path as the PC "Delete Agent Session" command. */
  deleteSession(localId: string): Promise<MobileBridgeResult<void>>

  /**
   * Deletes one history row owned by this window. The phone has no local id for
   * history rows, so the durable id is the address. When this window resumed
   * the session after the phone listed it, the shared pipeline closes the live
   * instance first; agent-side deletion stays best-effort.
   */
  deleteHistorySession(durableId: string): Promise<MobileBridgeResult<void>>

  // ---- Fork / rewind / side task -------------------------------------------------

  /**
   * Fork the session into a new independent session (from the tip when
   * `messageId` is omitted). The child is never made active — a phone command
   * must not steal the PC window's focus.
   */
  forkSession(
    localId: string,
    messageId?: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>

  /** Dry-run file-impact preview for a rewind anchor. */
  previewRewind(
    localId: string,
    messageId: string,
  ): Promise<MobileBridgeResult<MobileRewindPreview>>

  /**
   * Truncate the conversation at a user-turn anchor and optionally roll back
   * the agent-edited files. The anchor's original text is returned for the
   * phone-side composer backfill; it is never written to the PC inbox.
   */
  rewindSession(
    localId: string,
    messageId: string,
    rewindFiles?: boolean,
  ): Promise<MobileBridgeResult<MobileRewindResult>>

  /** Fork the parent into a read-only-mode side task; `quote` is the pulled-aside text. */
  createSideTask(
    localId: string,
    quote?: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>

  /** Direct side-task children of the parent, most recently used first. */
  listSideTasks(localId: string): Promise<MobileBridgeResult<readonly MobileSideTaskSummary[]>>

  /** Open an existing (live or history-only) side task without activating it. */
  openSideTask(
    localId: string,
    sideTaskId: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>

  /** Delete a side task and its whole descendant subtree. */
  deleteSideTask(localId: string, sideTaskId: string): Promise<MobileBridgeResult<void>>

  // ---- Agent delivery ---------------------------------------------------------

  /**
   * Inspect the session's repository: commits to deliver, main/upstream heads,
   * blockers and warnings. `durableId` lets a resumed row (whose local id
   * changed) resolve the owning delivery.
   */
  previewDelivery(
    localId: string,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobileDeliveryPreview>>

  /**
   * Start a delivery, pinning the heads returned by the preview. Returns the
   * delivery id; progress arrives through `onDidChange` inbox/session deltas.
   */
  startDelivery(
    localId: string,
    expectation: MobileDeliveryExpectation,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobileDeliveryStartResult>>

  getDelivery(
    localId: string,
    deliveryId: string,
  ): Promise<MobileBridgeResult<MobileDeliveryDetail>>

  /** Promote the temporary worktree to main and push it (no force). */
  confirmDeliveryPush(localId: string, deliveryId: string): Promise<MobileBridgeResult<void>>

  /** Re-run a failed delivery, or retry worktree sync after a push. */
  retryDelivery(localId: string, deliveryId: string): Promise<MobileBridgeResult<void>>

  /** Undo an unpushed delivery locally, or revert + push it when already pushed. */
  undoDelivery(localId: string, deliveryId: string): Promise<MobileBridgeResult<void>>

  /** Open the repository's main worktree in the PC workbench. */
  openDeliveryMainWorktree(localId: string, deliveryId: string): Promise<MobileBridgeResult<void>>

  /**
   * Inspect the session branch and its remote before publishing. This never
   * writes; blockers cover a diverged remote and an already-pushed branch.
   */
  previewPushBranch(
    localId: string,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobilePushBranchPreview>>

  /** Publish the session branch, pinning the heads the preview returned. */
  pushBranch(
    localId: string,
    expectation: MobilePushBranchExpectation,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobilePushBranchResult>>

  /**
   * Main-only routing/guard context (source/main worktree, current phase).
   * Carries absolute paths and is never forwarded to a phone frame. Falls back
   * to the live session's cwd when no delivery record exists yet.
   */
  getDeliveryContext(
    localId: string,
    durableId?: string,
  ): Promise<MobileBridgeDeliveryContext | undefined>

  /** Active deliveries owned by this window (main-only cross-window guard). */
  listActiveDeliveries(): Promise<readonly MobileBridgeDeliveryContext[]>

  /** This window's open workspace (main merges it with recent workspaces). */
  listWorkspaces(): Promise<readonly MobileWorkspaceCandidate[]>

  /** Agents this window can start a session with. */
  listAgents(token?: CancellationToken): Promise<readonly MobileAgentCandidate[]>

  /**
   * Inbox deltas and per-session delta batches. Per-session text is coalesced
   * (~50ms; ~100ms while a single message grows by more than 64K chars) and
   * deltas carry only suffixes.
   */
  readonly onDidChange: Event<MobileBridgeEvent>
}

export const IMobileBridgeService = createDecorator<IMobileBridgeService>('mobileBridgeService')
