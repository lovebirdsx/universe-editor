/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Aggregates the per-window renderer bridges into the phone-facing stream.
 *  One hub owns every WebSocket subscriber: inbox fan-out, per-session snapshots
 *  + monotonic deltas, backpressure resync, and command routing. Window ids and
 *  workspace names (main-only facts) are stamped here; renderers never see them.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  normalizePlatform,
  relativePathUnder,
  URI,
  type CancellationToken,
  type ILogger,
} from '@universe-editor/platform'
import {
  DEFAULT_COMMIT_PROMPT_REFS,
  DEFAULT_PROMPT_REF_SUGGESTIONS,
  MAX_COMMIT_PROMPT_REFS,
  MAX_PROMPT_REF_COMMIT_TEXT_LENGTH,
  MAX_PROMPT_REF_DESCRIPTION_LENGTH,
  MAX_PROMPT_REF_DIR_PATH_LENGTH,
  MAX_PROMPT_REF_LABEL_LENGTH,
  MAX_PROMPT_REF_STATUS_LENGTH,
  MAX_PROMPT_REF_SUGGESTIONS,
  MAX_PROMPT_REF_TEXT_LENGTH,
  MAX_PROMPT_REF_URI_LENGTH,
  MAX_SERVER_FRAME_BYTES,
  MAX_HISTORY_PROMPT_LENGTH,
  MAX_ID_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORKSPACE_NAME_LENGTH,
  MOBILE_PROMPT_REF_KINDS,
  clampText,
  isValidCommitHash,
  parseServerFrame,
  parseWorkspaceRelativePath,
  serializeFrame,
  type CommandFrame,
  type DraftUpdateFrame,
  type GetNewSessionOptionsPayload,
  type GetSessionSettingsPayload,
  type ListDirectoryPayload,
  type RestartAgentProcessPayload,
  type SetSessionMcpServersPayload,
  type SetSubagentModelPayload,
  type MobileAgentCandidate,
  type MobileAttentionKind,
  type MobileDeliveryExpectation,
  type MobileDirectoryListing,
  type MobileDraftState,
  type MobileErrorCode,
  type MobileNewSessionOptions,
  type MobileNewSessionResult,
  type MobilePendingPermission,
  type MobilePromptRef,
  type MobilePromptRefSuggestion,
  type MobilePushBranchExpectation,
  type MobileSessionEvent,
  type MobileSessionHistoryEntry,
  type MobileSessionRef,
  type MobileSessionSnapshot,
  type MobileSessionSummary,
  type MobileSideTaskSummary,
  type MobileWorkspaceCandidate,
  type ResolvePromptRefPayload,
  type ResolvePromptRefResult,
  type SearchPromptRefsPayload,
  type ServerFrame,
  type SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'
import type {
  IMobileBridgeService,
  MobileBridgeAttentionEvent,
  MobileBridgeDeliveryContext,
  MobileBridgeEvent,
  MobileBridgeImage,
  MobileBridgeNewSessionResult,
  MobileBridgePromptAttachment,
  MobileBridgeResult,
  MobileBridgeSessionEvent,
  MobileBridgeSessionHistoryEntry,
  MobileBridgeSessionSummary,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  MOBILE_GATEWAY_DEFAULT_SESSION_HISTORY_WORKSPACE_LIMIT,
  MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  MobileAttachmentError,
  type MobileGatewayAttachmentResolver,
} from './mobileAttachmentStore.js'
import { isSameWorkspace } from '../window/workspaceWindowRouting.js'

export { isSameWorkspace } from '../window/workspaceWindowRouting.js'
import { MobileDraftRegistry, isDraftEmpty } from './mobileDraftRegistry.js'
import { WorkspaceDirectoryBrowseError } from './workspaceDirectoryBrowser.js'
import { describeFsError } from '../../../shared/mobileGateway/workspaceFsErrors.js'

/** Once a socket has this much queued we drop deltas and ask the phone to resync. */
export const MAX_BUFFERED_SESSION_BYTES = 1024 * 1024

export interface MobileGatewayHubConnection {
  /** Synchronous send; the server drops frames when the socket is not open. */
  send(frame: ServerFrame): void
  /** Current `WebSocket.bufferedAmount`. */
  bufferedAmount(): number
}

interface WindowEntry {
  readonly windowId: number
  readonly bridge: IMobileBridgeService
  readonly workspaceName: () => string
  /** Subscribed lazily: the renderer channel may not exist yet. */
  subscription: { dispose(): void } | undefined
  streaming: boolean
  attention: boolean
  /**
   * True once a ping reached this window's renderer. Main registers the
   * reverse channel before `loadURL`, so subscribe / startStreaming frames
   * sent earlier are dropped by the transport and nothing retries them.
   */
  rendererReady: boolean
  /** In-flight readiness probe, shared by the wiring and command paths. */
  readyProbe: Promise<boolean> | undefined
}

/** Main-owned attention fact, resolved from a bridge event and the inbox cache. */
export interface MobileGatewayAttention {
  readonly kind: MobileAttentionKind
  readonly ref: MobileSessionRef
  readonly title: string
  readonly agentName?: string
  readonly permissionTitle?: string
  /** Automated session: ignore the "PC focused" suppression. */
  readonly alwaysNotify?: boolean
}

interface SessionSubscription {
  readonly windowId: number
  readonly localId: string
  ref: MobileSessionRef
  seq: number
  snapshotPending: boolean
  buffered: MobileSessionEvent[]
  desynced: boolean
  cancelled: boolean
}

interface HubConnectionState {
  readonly connection: MobileGatewayHubConnection
  /** Bound on the first successful hello. */
  deviceId: string | undefined
  inbox: boolean
  inboxSnapshotPending: boolean
  bufferedInbox: Array<{
    readonly upserts: readonly MobileSessionSummary[]
    readonly removes: readonly MobileSessionRef[]
  }>
  readonly sessions: Map<string, SessionSubscription>
}

interface InboxEntry {
  readonly windowId: number
  readonly summary: MobileSessionSummary
}

/** One workspace main can open or already has open. */
export interface MobileGatewayHostWorkspace {
  readonly windowId?: number
  /** URI string (`file:///…` / `remote-ssh://…`). */
  readonly folder: string
  readonly name: string
  readonly authority?: string
}

/** Main-owned facts the hub needs for `listWorkspaces` / `newSession`. */
export interface MobileGatewayHost {
  listOpenWorkspaces(): readonly MobileGatewayHostWorkspace[]
  listRecentWorkspaces(): Promise<readonly MobileGatewayHostWorkspace[]>
  openWorkspace(folder: string, authority?: string): Promise<void>
  /**
   * Resolve when the window is open and main has registered its reverse
   * channel, or undefined on timeout. The renderer may still be booting: its
   * IPC channel is registered long after this point, so callers must ping it
   * before issuing commands.
   */
  waitForBridge(
    folder: string,
    authority: string | undefined,
    timeoutMs: number,
  ): Promise<number | undefined>
  /**
   * Best-effort dirty probe for one workspace candidate. `bridge` is present
   * only for an open window whose renderer is ready. Implementations must not
   * throw; `undefined` means unknown (non-repo / git missing / timeout).
   */
  workspaceGitDirty?(
    workspace: MobileGatewayHostWorkspace,
    bridge: IMobileBridgeService | undefined,
    signal: AbortSignal,
  ): Promise<boolean | undefined>
  /**
   * Read the resumable history persisted in a closed workspace's own storage
   * bucket. Read-only; missing or corrupt buckets resolve to an empty list.
   */
  readWorkspaceSessionHistory(
    workspace: MobileGatewayHostWorkspace,
  ): Promise<readonly MobileBridgeSessionHistoryEntry[]>
  /**
   * List the directories under a workspace-relative path. The hub has already
   * matched the workspace against the open/recent set; implementations only
   * enforce containment within that root. Optional so test doubles can omit it
   * (the hub answers `not_supported`).
   */
  listDirectory?(
    workspace: MobileGatewayHostWorkspace,
    relativePath: string | undefined,
  ): Promise<MobileDirectoryListing>
  /**
   * Read the new-session defaults for one workspace. The hub has already
   * matched the workspace against the open/recent set; implementations only
   * return data derived from that workspace. Optional so test doubles can omit
   * it (the hub answers `not_supported`).
   */
  readNewSessionOptions?(workspace: MobileGatewayHostWorkspace): Promise<MobileNewSessionOptions>
  /** Cap for closed workspaces included in the history catalog (config-driven). */
  sessionHistoryWorkspaceLimit(): number
  /** Phone-uploaded attachments, scoped to the authenticated device. */
  attachments?: MobileGatewayAttachmentResolver
}

/** Per-command audit sink; the server adds device identity and owns the file. */
export interface MobileCommandAudit {
  record(action: string, result: 'success' | 'failure', detail?: string): void
}

interface CommandOutcome {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: MobileErrorCode
}

interface OpenWorkspaceFailure {
  readonly ok: false
  readonly error: MobileErrorCode
}

interface ClosedWorkspaceHistory {
  readonly workspace: MobileGatewayHostWorkspace
  readonly rows: readonly MobileSessionHistoryEntry[]
}

interface HistoryEntryContext {
  readonly windowId?: number
  readonly workspaceName: string
  readonly folder?: string
  readonly authority?: string
}

/** How long a repeated idempotency key returns the first result. */
export const COMMAND_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000
export const SEND_PROMPT_TIMEOUT_MS = 15_000
/** Read-only completion; the renderer budgets its own walks below this. */
export const SEARCH_PROMPT_REFS_TIMEOUT_MS = 10_000
/** Commit history is a git-graph round-trip queued behind the desktop picker. */
export const RESOLVE_COMMIT_TIMEOUT_MS = 20_000
/**
 * chatContext runs the extension's own picker on the PC, which blocks until the
 * user acts. The phone waits 125s + 5s idempotent grace, so 120s here leaves the
 * real error path reachable.
 */
export const RESOLVE_CHAT_CONTEXT_TIMEOUT_MS = 120_000
/**
 * Total budget for open + renderer-ready + create. Stays below the phone's 30s
 * command timeout so the phone receives the real error instead of a timeout.
 */
export const NEW_SESSION_TIMEOUT_MS = 25_000
/** Read-only directory browsing; stays below the phone's 25s command timeout. */
const LIST_DIRECTORY_TIMEOUT_MS = 20_000
/** Read-only options; remote settings/existence checks may need a connection setup. */
const NEW_SESSION_OPTIONS_TIMEOUT_MS = 20_000
/** A ping sent before the renderer's listener exists never settles; cap each try. */
const BRIDGE_PING_TIMEOUT_MS = 500
const BRIDGE_PING_INTERVAL_MS = 100
/** Inbox snapshot: bound each window's readiness wait and list call. */
const INBOX_WINDOW_READY_TIMEOUT_MS = 5_000
const INBOX_LIST_TIMEOUT_MS = 5_000
/** Session subscribe: a snapshot requested before the renderer answers is lost. */
const SESSION_READY_TIMEOUT_MS = 10_000
/** List agents: also bound by the phone's own 10s command timeout. */
const LIST_AGENTS_TIMEOUT_MS = 10_000
/** Fork / rewind / side-task commands wait on an agent fork RPC plus a resume. */
const LONG_COMMAND_TIMEOUT_MS = 120_000
/**
 * History probes (live scan + owner search) can take ~20s before the bridge is
 * called; keep the total under the phone's 120s + 5s grace.
 */
export const OPEN_SESSION_TIMEOUT_MS = 100_000
/** History delete: owner probes + bridge delete, within the phone's 30s + grace. */
const DELETE_HISTORY_TIMEOUT_MS = 30_000
/** A freshly opened window may still be swapping to its workspace bucket. */
const HISTORY_OPEN_POLL_INTERVAL_MS = 300
const PREVIEW_REWIND_TIMEOUT_MS = 30_000
const LIST_SIDE_TASKS_TIMEOUT_MS = 10_000
/** Preview may fetch; start only waits for preflight and the delivery lock. */
const DELIVERY_PREVIEW_TIMEOUT_MS = 110_000
const DELIVERY_START_TIMEOUT_MS = 110_000
/** Push / retry / undo include network round-trips and worktree sync. */
const DELIVERY_MUTATION_TIMEOUT_MS = 110_000
/** Local record reads and opening an existing window. */
const DELIVERY_READ_TIMEOUT_MS = 10_000
/** Cross-window guards probe peers; a wedged renderer must not block routing. */
const DELIVERY_GUARD_TIMEOUT_MS = 5_000
/** History catalog: bound each window's readiness and history read. */
const HISTORY_WINDOW_READY_TIMEOUT_MS = 5_000
const HISTORY_LIST_TIMEOUT_MS = 8_000
/** Reading a closed workspace bucket is a local small-file read. */
const HISTORY_DISK_READ_TIMEOUT_MS = 2_000
/** Session settings read a settings file (possibly on a remote host) plus the MCP pool. */
const SESSION_SETTINGS_TIMEOUT_MS = 20_000
const SUBAGENT_MODEL_WRITE_TIMEOUT_MS = 30_000
const RESTART_PROCESS_TIMEOUT_MS = 10_000
const SESSION_MCP_WRITE_TIMEOUT_MS = 10_000
/** Limit concurrent local bucket reads while building the catalog. */
const HISTORY_DISK_READ_CONCURRENCY = 4
/** Ownership probe before resuming; a wrong window answers `false` quickly. */
const HISTORY_OWNER_TIMEOUT_MS = 5_000
/** Reading image bytes is a renderer round-trip (and, for workspace files, a disk read). */
const SESSION_IMAGE_TIMEOUT_MS = 15_000
/** A report lookup is one renderer round-trip; the disk read happens in main afterwards. */
const SESSION_REPORT_TIMEOUT_MS = 10_000
/** Keep the phone list responsive even with many open workspaces. */
const MAX_HISTORY_RESULTS = 200
/** Cap how many workspace candidates pay for a `git status` probe. */
export const MAX_GIT_STATUS_CANDIDATES = 20
const GIT_STATUS_CONCURRENCY = 4
const GIT_STATUS_TOTAL_BUDGET_MS = 2_500

const MUTATING_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'sendPrompt',
  'cancelTurn',
  'resolvePermission',
  'cancelPermission',
  'resolveElicitation',
  'setConfigOption',
  'setSubagentModel',
  'restartAgentProcess',
  'setSessionMcpServers',
  'pauseAutoResolve',
  'resumeAutoResolve',
  // Semantically read-only, but it can open a picker on the PC; the idempotency
  // key keeps a reconnect resend from popping a second one.
  'resolvePromptRef',
  'newSession',
  'renameSession',
  'closeSession',
  'deleteSession',
  'deleteHistorySession',
  'forkSession',
  'rewindSession',
  'createSideTask',
  'openSideTask',
  'deleteSideTask',
  'openSession',
  'startDelivery',
  'confirmDeliveryPush',
  'retryDelivery',
  'undoDelivery',
  'openDeliveryMainWorktree',
  'pushBranch',
])

const sessionKey = (windowId: number, localId: string): string => `${windowId}:${localId}`

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isBoundedIdentity(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

function isPrintableBounded(value: unknown, max: number): value is string {
  return isBoundedIdentity(value, max) && !CONTROL_CHAR_RE.test(value)
}

/** chatContext bodies are multi-line: tabs/newlines are fine, other C0 + DEL are not. */
function isSafePromptRefText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function clampRefDescription(value: unknown): { description?: string } {
  return typeof value === 'string'
    ? { description: clampText(value, MAX_PROMPT_REF_DESCRIPTION_LENGTH) }
    : {}
}

/**
 * The bridge is trusted but version-skewed or buggy code must not push an
 * unbounded / malformed completion payload to the phone. Invalid entries are
 * dropped instead of failing the whole command.
 */
function clampPromptRefSuggestions(
  value: unknown,
  requestedLimit: number,
): readonly MobilePromptRefSuggestion[] {
  if (!Array.isArray(value)) return []
  const limit = Math.max(1, Math.min(requestedLimit, MAX_PROMPT_REF_SUGGESTIONS))
  const entries: MobilePromptRefSuggestion[] = []
  for (const raw of value) {
    if (entries.length >= limit) break
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const kind = item.kind
    if (
      typeof kind !== 'string' ||
      !(MOBILE_PROMPT_REF_KINDS as readonly string[]).includes(kind)
    ) {
      continue
    }
    const label = item.label
    if (!isPrintableBounded(label, MAX_PROMPT_REF_LABEL_LENGTH)) continue
    const description = clampRefDescription(item.description)
    if (kind === 'commit') {
      if (item.uri !== '') continue
      entries.push({ kind: 'commit', label, uri: '', ...description })
      continue
    }
    if (kind === 'chatContext') {
      if (item.uri !== '' || !isPositiveInteger(item.chatContextHandle)) continue
      entries.push({
        kind: 'chatContext',
        label,
        uri: '',
        chatContextHandle: item.chatContextHandle,
        ...description,
      })
      continue
    }
    const uri = item.uri
    if (!isPrintableBounded(uri, MAX_PROMPT_REF_URI_LENGTH)) continue
    const dirPath = item.dirPath
    const docsDirPath = isPrintableBounded(dirPath, MAX_PROMPT_REF_DIR_PATH_LENGTH)
      ? dirPath
      : undefined
    if (kind === 'docs' && docsDirPath === undefined) continue
    entries.push({
      kind: kind as MobilePromptRefSuggestion['kind'],
      label,
      uri,
      ...description,
      ...(isPositiveInteger(item.line) ? { line: item.line } : {}),
      ...(isPositiveInteger(item.column) ? { column: item.column } : {}),
      ...(isNonNegativeInteger(item.symbolKind) ? { symbolKind: item.symbolKind } : {}),
      ...(isPrintableBounded(item.scmStatus, MAX_PROMPT_REF_STATUS_LENGTH)
        ? { scmStatus: item.scmStatus }
        : {}),
      ...(kind === 'docs' && docsDirPath !== undefined ? { dirPath: docsDirPath } : {}),
    })
  }
  return entries
}

function clampCommitPromptRefEntries(
  value: unknown,
  requestedLimit: number,
): readonly MobilePromptRefSuggestion[] {
  if (!Array.isArray(value)) return []
  const limit = Math.max(1, Math.min(requestedLimit, MAX_COMMIT_PROMPT_REFS))
  const entries: MobilePromptRefSuggestion[] = []
  for (const raw of value) {
    if (entries.length >= limit) break
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const label = item.label
    const uri = item.uri
    const commitHash = item.commitHash
    const text = item.text
    if (item.kind !== 'commit') continue
    if (!isPrintableBounded(label, MAX_PROMPT_REF_LABEL_LENGTH)) continue
    if (!isPrintableBounded(uri, MAX_PROMPT_REF_URI_LENGTH)) continue
    if (typeof commitHash !== 'string' || !isValidCommitHash(commitHash)) continue
    if (!isPrintableBounded(text, MAX_PROMPT_REF_COMMIT_TEXT_LENGTH)) continue
    entries.push({
      kind: 'commit',
      label,
      uri,
      commitHash,
      text,
      ...clampRefDescription(item.description),
    })
  }
  return entries
}

function clampChatContextPromptRefEntry(value: unknown): MobilePromptRefSuggestion | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  if (item.kind !== 'chatContext' || item.uri !== '') return undefined
  const label = item.label
  const text = item.text
  if (!isPrintableBounded(label, MAX_PROMPT_REF_LABEL_LENGTH)) return undefined
  if (!isSafePromptRefText(text, MAX_PROMPT_REF_TEXT_LENGTH)) return undefined
  return {
    kind: 'chatContext',
    label,
    uri: '',
    text,
    ...clampRefDescription(item.description),
  }
}

function clampResolvePromptRefResult(
  value: unknown,
  payload: ResolvePromptRefPayload,
): ResolvePromptRefResult {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  if (payload.kind === 'commit') {
    return {
      kind: 'commit',
      entries: clampCommitPromptRefEntries(
        record?.kind === 'commit' ? record.entries : undefined,
        payload.limit ?? DEFAULT_COMMIT_PROMPT_REFS,
      ),
    }
  }
  const entry =
    record?.kind === 'chatContext' ? clampChatContextPromptRefEntry(record.entry) : undefined
  return { kind: 'chatContext', ...(entry !== undefined ? { entry } : {}) }
}

export class MobileGatewayHub {
  private readonly _windows = new Map<number, WindowEntry>()
  private readonly _connections = new Set<HubConnectionState>()
  private readonly _inboxState = new Map<string, InboxEntry>()
  /** `windowId:localId:requestId` → option ids the gateway announced. */
  private readonly _permissionOptions = new Map<string, ReadonlySet<string>>()
  private readonly _idempotentResults = new Map<
    string,
    { readonly outcome: CommandOutcome; readonly expiresAt: number }
  >()
  private readonly _inflightCommands = new Map<string, Promise<CommandOutcome>>()
  /** Resumes are deduped by durable id across devices / idempotency keys. */
  private readonly _inflightOpenSessions = new Map<string, Promise<CommandOutcome>>()
  private readonly _drafts = new MobileDraftRegistry()
  /** Per-session serialization so concurrent draft updates cannot reorder. */
  private readonly _draftQueues = new Map<string, Promise<void>>()
  /** Bumped when a prompt clears the draft; older in-flight updates are dropped. */
  private readonly _draftEpochs = new Map<string, number>()
  private _inboxSeq = 0
  private _streaming = false
  private _attention = false

  constructor(
    private readonly _logger: ILogger,
    private readonly _host?: MobileGatewayHost,
    private readonly _onAttention?: (attention: MobileGatewayAttention) => void,
  ) {}

  registerWindow(
    windowId: number,
    bridge: IMobileBridgeService,
    workspaceName: () => string = () => '',
  ): void {
    this.unregisterWindow(windowId)
    const entry: WindowEntry = {
      windowId,
      bridge,
      workspaceName,
      subscription: undefined,
      streaming: false,
      attention: false,
      rendererReady: false,
      readyProbe: undefined,
    }
    this._windows.set(windowId, entry)
    this._syncWindow(entry)
  }

  unregisterWindow(windowId: number): void {
    const entry = this._windows.get(windowId)
    if (entry === undefined) return
    this._windows.delete(windowId)
    this._disposeWindowWatch(entry)
    this._clearWindowPermissions(windowId)
    this._drafts.deleteWindow(windowId)

    const removes: MobileSessionRef[] = []
    for (const [key, value] of this._inboxState) {
      if (value.windowId !== windowId) continue
      this._inboxState.delete(key)
      removes.push(value.summary.ref)
    }
    for (const state of this._connections) {
      for (const [key, subscription] of state.sessions) {
        if (subscription.windowId !== windowId) continue
        subscription.cancelled = true
        state.sessions.delete(key)
        this._send(
          state.connection,
          { type: 'session_removed', ref: subscription.ref },
          subscription.localId,
        )
      }
    }
    if (removes.length > 0) this._broadcastInboxDelta([], removes)
    this._updateStreaming()
  }

  /**
   * Whether any phone is watching a live session in `windowId`. Only session
   * subscriptions count: the inbox and attention listeners are passive views
   * and must not keep an otherwise idle hidden window alive.
   */
  hasSessionSubscribers(windowId: number): boolean {
    for (const state of this._connections) {
      for (const subscription of state.sessions.values()) {
        if (subscription.windowId === windowId) return true
      }
    }
    return false
  }

  dispose(): void {
    for (const entry of this._windows.values()) {
      this._disposeWindowWatch(entry)
    }
    this._windows.clear()
    this._connections.clear()
    this._inboxState.clear()
    this._permissionOptions.clear()
    this._streaming = false
    this._attention = false
  }

  /**
   * Bytes for one ACP image block of a live session. Served over HTTP (not the
   * WebSocket); `undefined` makes the caller answer 404 without distinguishing
   * "missing" from "not allowed".
   */
  readSessionImage(
    ref: MobileSessionRef,
    messageId: string,
    index: number,
  ): Promise<MobileBridgeImage | undefined> {
    return this._readSessionResource(ref, (bridge, localId, token) =>
      bridge.getMessageImage(localId, messageId, index, token),
    )
  }

  /** A workspace image referenced from markdown, resolved against the session cwd. */
  readSessionWorkspaceImage(
    ref: MobileSessionRef,
    src: string,
  ): Promise<MobileBridgeImage | undefined> {
    return this._readSessionResource(ref, (bridge, localId, token) =>
      bridge.getWorkspaceImage(localId, src, token),
    )
  }

  /**
   * Trigger run id recorded on the session, or undefined for a manual session /
   * a session owned by another window. Main reads the report itself so the
   * renderer never exposes a run directory to the phone.
   */
  readSessionReportRunId(ref: MobileSessionRef): Promise<string | undefined> {
    return this._readSessionValue(
      ref,
      (bridge, localId, token) => bridge.getAutomationRunId(localId, token),
      SESSION_REPORT_TIMEOUT_MS,
    )
  }

  /** Bytes for a picture the PC pasted into the draft (phone preview only). */
  readDraftImage(ref: MobileSessionRef, imageId: string): Promise<MobileBridgeImage | undefined> {
    const draft = this._drafts.get(sessionKey(ref.windowId, ref.localId))
    if (!draft?.images.some((image) => image.id === imageId)) return Promise.resolve(undefined)
    return this._readSessionResource(ref, (bridge, localId, token) =>
      bridge.getDraftImage(localId, imageId, token),
    )
  }

  private async _readSessionResource(
    ref: MobileSessionRef,
    call: (
      bridge: IMobileBridgeService,
      localId: string,
      token: CancellationToken,
    ) => Promise<MobileBridgeImage | undefined>,
  ): Promise<MobileBridgeImage | undefined> {
    return this._readSessionValue(ref, call, SESSION_IMAGE_TIMEOUT_MS)
  }

  private async _readSessionValue<T>(
    ref: MobileSessionRef,
    call: (bridge: IMobileBridgeService, localId: string, token: CancellationToken) => Promise<T>,
    timeoutMs: number,
  ): Promise<T | undefined> {
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return undefined
    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) return undefined
    const deadline = Date.now() + timeoutMs
    if (!(await this._ensureWindowReady(entry, deadline))) return undefined
    if (this._windows.get(resolved.windowId) !== entry) return undefined
    try {
      return await callWithToken(
        (token) => call(entry.bridge, resolved.localId, token),
        Math.max(1, deadline - Date.now()),
      )
    } catch (err) {
      this._logger.warn(`mobile session resource read failed: ${String(err)}`)
      return undefined
    }
  }

  /**
   * Attention-only listening is cheap: no timeline serialization, no inbox
   * snapshots, just the shared edge signal. Main turns it on while at least one
   * paired device has notifications enabled — the phone may be in the
   * background with no inbox subscriber at all.
   */
  setAttentionNeeded(needed: boolean): void {
    if (this._attention === needed) return
    this._attention = needed
    for (const entry of this._windows.values()) this._syncWindow(entry)
  }

  addConnection(connection: MobileGatewayHubConnection): void {
    this._connections.add({
      connection,
      deviceId: undefined,
      inbox: false,
      inboxSnapshotPending: false,
      bufferedInbox: [],
      sessions: new Map(),
    })
  }

  authenticateConnection(connection: MobileGatewayHubConnection, deviceId: string): void {
    const state = this._find(connection)
    if (state === undefined || state.deviceId !== undefined) return
    state.deviceId = deviceId
  }

  removeConnection(connection: MobileGatewayHubConnection): void {
    for (const state of this._connections) {
      if (state.connection !== connection) continue
      state.inbox = false
      state.sessions.clear()
      this._connections.delete(state)
      this._updateStreaming()
      return
    }
  }

  subscribeInbox(connection: MobileGatewayHubConnection): void {
    const state = this._find(connection)
    if (state === undefined) return
    if (state.inbox) {
      void this._sendInboxSnapshot(state)
      return
    }
    state.inbox = true
    this._updateStreaming()
    void this._sendInboxSnapshot(state)
  }

  unsubscribeInbox(connection: MobileGatewayHubConnection): void {
    const state = this._find(connection)
    if (state === undefined) return
    state.inbox = false
    state.inboxSnapshotPending = false
    state.bufferedInbox = []
    this._updateStreaming()
  }

  async subscribeSession(
    connection: MobileGatewayHubConnection,
    ref: MobileSessionRef,
  ): Promise<void> {
    const state = this._find(connection)
    if (state === undefined) return
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) {
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }
    const key = sessionKey(resolved.windowId, resolved.localId)
    const previous = state.sessions.get(key)
    if (previous !== undefined) {
      previous.cancelled = true
      state.sessions.delete(key)
    }
    const subscription: SessionSubscription = {
      windowId: resolved.windowId,
      localId: resolved.localId,
      ref: {
        windowId: resolved.windowId,
        localId: resolved.localId,
        ...(ref.durableId !== undefined ? { durableId: ref.durableId } : {}),
      },
      seq: 0,
      snapshotPending: true,
      buffered: [],
      desynced: false,
      cancelled: false,
    }
    state.sessions.set(key, subscription)
    this._updateStreaming()

    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) {
      subscription.cancelled = true
      state.sessions.delete(key)
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS
    if (!(await this._ensureWindowReady(entry, deadline))) {
      // Unregister already removed the subscription and sent its own frame.
      if (subscription.cancelled || state.sessions.get(key) !== subscription) return
      this._logger.warn(
        `mobile snapshot skipped: window ${resolved.windowId} renderer never answered`,
      )
      state.sessions.delete(key)
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }
    if (subscription.cancelled || state.sessions.get(key) !== subscription) return
    let snapshot: Awaited<ReturnType<IMobileBridgeService['getSnapshot']>>
    try {
      snapshot = await callWithToken(
        (token) => entry.bridge.getSnapshot(resolved.localId, token),
        Math.max(1, deadline - Date.now()),
      )
    } catch (err) {
      this._logger.warn(`mobile snapshot failed: ${String(err)}`)
      snapshot = undefined
    }
    // Unsubscribe / re-subscribe / window close may have replaced the entry
    // while the snapshot was in flight; the newer request owns the output.
    if (subscription.cancelled || state.sessions.get(key) !== subscription) return
    if (snapshot === undefined) {
      subscription.cancelled = true
      state.sessions.delete(key)
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }

    const summary = this._toProtocolSummary(entry, snapshot.summary)
    if (snapshot.pendingPermission !== undefined) {
      this._cachePermission(resolved.windowId, summary.ref.localId, snapshot.pendingPermission)
    }
    subscription.ref = summary.ref
    subscription.seq += 1
    // The renderer snapshot is the freshest PC state; the registry may also
    // hold a phone-authored update that has not reached the cache yet.
    // Seed from the renderer only when this session has no registry entry; a
    // phone update that landed while the snapshot was in flight must win.
    if (snapshot.draft !== undefined && this._drafts.get(key) === undefined) {
      this._drafts.setFromRenderer(key, snapshot.draft)
    }
    const { draft: _snapshotDraft, ...snapshotRest } = snapshot
    const draft = this._drafts.get(key)
    const base: MobileSessionSnapshot = {
      ...snapshotRest,
      seq: subscription.seq,
      summary,
      ...(draft !== undefined ? { draft } : {}),
    }
    const frame: SessionSnapshotFrame = {
      type: 'session_snapshot',
      seq: subscription.seq,
      session: this._fitSnapshot(base),
    }
    this._send(connection, frame, resolved.localId)
    subscription.snapshotPending = false
    const buffered = subscription.buffered
    subscription.buffered = []
    this._sendSessionEvents(state, subscription, buffered)
  }

  unsubscribeSession(connection: MobileGatewayHubConnection, ref: MobileSessionRef): void {
    const state = this._find(connection)
    if (state === undefined) return
    const key =
      ref.durableId !== undefined
        ? this._findSubscriptionKeyByDurable(state, ref.durableId)
        : undefined
    const target = key ?? sessionKey(ref.windowId, ref.localId)
    const subscription = state.sessions.get(target)
    if (subscription !== undefined) subscription.cancelled = true
    state.sessions.delete(target)
    this._updateStreaming()
  }

  async handleCommand(
    connection: MobileGatewayHubConnection,
    frame: CommandFrame,
    audit?: MobileCommandAudit,
    context?: { readonly deviceId?: string },
  ): Promise<void> {
    const state = this._find(connection)
    const sender = { deviceId: state?.deviceId ?? context?.deviceId }
    const mutating = MUTATING_COMMAND_KINDS.has(frame.kind)
    const cacheKey =
      frame.idempotencyKey !== undefined && mutating
        ? `${sender.deviceId ?? ''}:${frame.idempotencyKey}`
        : undefined
    let outcome: CommandOutcome
    if (cacheKey !== undefined) {
      const now = Date.now()
      const cached = this._idempotentResults.get(cacheKey)
      if (cached !== undefined && cached.expiresAt > now) {
        outcome = cached.outcome
      } else {
        if (cached !== undefined) this._idempotentResults.delete(cacheKey)
        const inflight = this._inflightCommands.get(cacheKey)
        if (inflight !== undefined) {
          outcome = await inflight
        } else {
          const run = this._dispatchCommand(frame, sender).finally(() => {
            this._inflightCommands.delete(cacheKey)
          })
          this._inflightCommands.set(cacheKey, run)
          outcome = await run
          this._idempotentResults.set(cacheKey, {
            outcome,
            expiresAt: Date.now() + COMMAND_IDEMPOTENCY_TTL_MS,
          })
          this._pruneIdempotency()
        }
      }
    } else {
      outcome = await this._dispatchCommand(frame, sender)
    }

    if (audit !== undefined && mutating) {
      const ref = (frame.payload as { ref?: MobileSessionRef }).ref
      const parts: string[] = []
      if (ref !== undefined) {
        parts.push(`window=${ref.windowId}`, `local=${ref.localId}`)
      }
      if (frame.kind === 'newSession') {
        const agentId = (frame.payload as { agentId?: string }).agentId
        if (agentId !== undefined) parts.push(`agent=${agentId}`)
      }
      if (frame.kind === 'openSession') {
        const created = outcome.ok
          ? (outcome.result as MobileNewSessionResult | undefined)
          : undefined
        if (created !== undefined) {
          parts.push(`window=${created.ref.windowId}`, `local=${created.ref.localId}`)
        } else {
          const windowId = (frame.payload as { windowId?: number }).windowId
          if (windowId !== undefined) parts.push(`window=${windowId}`)
        }
      }
      if (!outcome.ok && outcome.error !== undefined) parts.push(`error=${outcome.error}`)
      audit.record(
        frame.kind,
        outcome.ok ? 'success' : 'failure',
        parts.length > 0 ? parts.join(' ') : undefined,
      )
    }

    if (outcome.ok) {
      this._send(connection, {
        type: 'command_result',
        requestId: frame.requestId,
        ok: true,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      })
    } else {
      this._send(connection, {
        type: 'command_result',
        requestId: frame.requestId,
        ok: false,
        error: outcome.error ?? 'internal',
      })
    }
  }

  /** High-frequency, best-effort phone draft. Never produces a command_result. */
  async handleDraftUpdate(
    connection: MobileGatewayHubConnection,
    frame: DraftUpdateFrame,
  ): Promise<void> {
    const state = this._find(connection)
    if (state === undefined) return
    const resolved = this._resolveSession(frame.ref)
    if (resolved === undefined) return
    let key = sessionKey(resolved.windowId, resolved.localId)
    let localId = resolved.localId
    if (!state.sessions.has(key) && frame.ref.durableId !== undefined) {
      // The agent re-issued a localId; the subscription still tracks the
      // session by its durable id, so follow that instead of dropping the edit.
      const durableKey = this._findSubscriptionKeyByDurable(state, frame.ref.durableId)
      const subscription = durableKey === undefined ? undefined : state.sessions.get(durableKey)
      if (durableKey !== undefined && subscription !== undefined) {
        key = durableKey
        localId = subscription.ref.localId
      }
    }
    if (!state.sessions.has(key)) return
    const epoch = this._draftEpochs.get(key) ?? 0
    await this._enqueueDraft(key, async () => {
      if ((this._draftEpochs.get(key) ?? 0) !== epoch) return
      const current = this._find(connection)
      if (current === undefined) return
      const subscription = current.sessions.get(key)
      if (subscription === undefined || subscription.cancelled) return
      const entry = this._windows.get(subscription.ref.windowId)
      if (entry === undefined) return
      await this._attachNewDraftAttachments(entry.bridge, current.deviceId, localId, key, frame)
      if ((this._draftEpochs.get(key) ?? 0) !== epoch) return
      const applied = await entry.bridge
        .applyDraft(localId, {
          text: frame.draft.text,
          images: frame.draft.images,
          ...(frame.draft.files !== undefined ? { files: frame.draft.files } : {}),
        })
        .catch(() => undefined)
      // A read-only / vanished session is not a protocol error for a lossy update.
      if (applied === undefined || !applied.ok) return
      if ((this._draftEpochs.get(key) ?? 0) !== epoch) {
        // A prompt cleared the draft while this update was in flight; undo it.
        void entry.bridge.clearDraft(localId).catch(() => undefined)
        return
      }
      if (this._find(connection)?.sessions.get(key) !== subscription) return
      const result = this._drafts.setFromPhone(key, frame.draft)
      if (result.state === undefined) return
      // Let the renderer pair this phone draft with the order the hub assigned
      // before any later local publish can be acknowledged.
      await entry.bridge.noteDraftRevision(localId, result.state.revision).catch(() => undefined)
      // Empty content must not survive as a registry entry: a later snapshot
      // would otherwise erase another phone's locally restored draft.
      if (isDraftEmpty(result.state)) this._drafts.delete(key)
      if (!result.changed) {
        this._sendSessionEvents(current, subscription, [
          {
            type: 'draft_update',
            draft: result.state,
            clientUpdateId: frame.clientUpdateId,
          },
        ])
        return
      }
      this._broadcastDraft(key, result.state, connection, frame.clientUpdateId)
    })
  }

  private _enqueueDraft(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this._draftQueues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this._draftQueues.set(key, next)
    return next.finally(() => {
      if (this._draftQueues.get(key) === next) this._draftQueues.delete(key)
    })
  }

  /**
   * Phone uploads live in the main-process attachment store; PromptInput needs
   * `PromptImage`/`PromptFileAttachment` objects. Resolve only ids the registry
   * has not seen yet — a draft update is sent on every keystroke.
   */
  private async _attachNewDraftAttachments(
    bridge: IMobileBridgeService,
    deviceId: string | undefined,
    localId: string,
    key: string,
    frame: DraftUpdateFrame,
  ): Promise<void> {
    const resolver = this._host?.attachments
    if (deviceId === undefined || resolver === undefined) return
    const previous = this._drafts.get(key)
    const known = new Set<string>([
      ...(previous?.images ?? []).map((image) => image.id),
      ...(previous?.files ?? []).map((file) => file.id),
    ])
    const ids = [
      ...frame.draft.images.filter((image) => image.source === 'mobile').map((image) => image.id),
      ...(frame.draft.files ?? []).map((file) => file.id),
    ].filter((id) => !known.has(id))
    if (ids.length === 0) return
    try {
      const attachments = await resolver.resolveForPrompt(deviceId, ids)
      await bridge.attachDraftAttachments(localId, attachments)
    } catch (err) {
      // A missing/expired upload should drop that chip, not the text edit.
      this._logger.warn(`mobile draft attachment resolve failed: ${String(err)}`)
    }
  }

  private _broadcastDraft(
    key: string,
    draft: MobileDraftState,
    origin?: MobileGatewayHubConnection,
    clientUpdateId?: string,
  ): void {
    for (const state of this._connections) {
      const subscription = state.sessions.get(key)
      if (subscription === undefined) continue
      const event: MobileSessionEvent = {
        type: 'draft_update',
        draft,
        ...(state.connection === origin && clientUpdateId !== undefined ? { clientUpdateId } : {}),
      }
      if (subscription.snapshotPending) {
        subscription.buffered.push(event)
        continue
      }
      this._sendSessionEvents(state, subscription, [event])
    }
  }

  private async _dispatchCommand(
    frame: CommandFrame,
    sender: { readonly deviceId: string | undefined },
  ): Promise<CommandOutcome> {
    const payload = frame.payload as { ref?: MobileSessionRef }
    switch (frame.kind) {
      case 'getToolCallDetail': {
        const detailPayload = frame.payload as { ref: MobileSessionRef; toolCallId: string }
        const resolved = this._resolveSession(detailPayload.ref)
        if (resolved === undefined) return failOutcome('session_not_found')
        const entry = this._windows.get(resolved.windowId)
        if (entry === undefined) return failOutcome('session_not_found')
        try {
          const detail = await entry.bridge.getToolCallDetail(
            resolved.localId,
            detailPayload.toolCallId,
          )
          return detail === undefined
            ? failOutcome('session_not_found')
            : { ok: true, result: detail }
        } catch (err) {
          this._logger.warn(`mobile command getToolCallDetail failed: ${String(err)}`)
          return failOutcome('internal')
        }
      }
      case 'searchPromptRefs': {
        const p = frame.payload as SearchPromptRefsPayload
        const outcome = await this._sessionCommand(
          p.ref,
          SEARCH_PROMPT_REFS_TIMEOUT_MS,
          (bridge, localId) =>
            bridge.searchPromptRefs(
              localId,
              p.trigger,
              p.query,
              p.limit ?? DEFAULT_PROMPT_REF_SUGGESTIONS,
            ),
        )
        if (!outcome.ok) return outcome
        return {
          ok: true,
          result: {
            entries: clampPromptRefSuggestions(
              outcome.result,
              p.limit ?? DEFAULT_PROMPT_REF_SUGGESTIONS,
            ),
          },
        }
      }
      case 'resolvePromptRef': {
        const p = frame.payload as ResolvePromptRefPayload
        const timeoutMs =
          p.kind === 'commit' ? RESOLVE_COMMIT_TIMEOUT_MS : RESOLVE_CHAT_CONTEXT_TIMEOUT_MS
        const outcome = await this._sessionCommand(p.ref, timeoutMs, (bridge, localId) =>
          bridge.resolvePromptRef(localId, {
            kind: p.kind,
            query: p.query,
            ...(p.kind === 'commit' ? { limit: p.limit ?? DEFAULT_COMMIT_PROMPT_REFS } : {}),
            ...(p.handle !== undefined ? { handle: p.handle } : {}),
            ...(p.label !== undefined ? { label: p.label } : {}),
          }),
        )
        if (!outcome.ok) return outcome
        return { ok: true, result: clampResolvePromptRefResult(outcome.result, p) }
      }
      case 'sendPrompt': {
        const p = frame.payload as {
          ref: MobileSessionRef
          text: string
          attachmentIds?: readonly string[]
          draftImageIds?: readonly string[]
          draftFileIds?: readonly string[]
          refs?: readonly MobilePromptRef[]
        }
        const refs = p.refs ?? []
        if (this._windows.size > 1 && (await this._deliveryBusyForSession(p.ref))) {
          return failOutcome('delivery_busy')
        }
        const ids = p.attachmentIds ?? []
        const draftImageIds = p.draftImageIds ?? []
        const draftFileIds = p.draftFileIds ?? []
        let attachments: readonly MobileBridgePromptAttachment[] | undefined
        if (ids.length > 0) {
          if (sender.deviceId === undefined) return failOutcome('unauthorized')
          const resolver = this._host?.attachments
          if (resolver === undefined) return failOutcome('not_supported')
          try {
            attachments = await resolver.resolveForPrompt(sender.deviceId, ids)
          } catch (err) {
            if (err instanceof MobileAttachmentError) return failOutcome(err.code)
            throw err
          }
        }
        const outcome = await this._sessionCommand(
          p.ref,
          SEND_PROMPT_TIMEOUT_MS,
          async (bridge, localId) => {
            let all = attachments ?? []
            if (draftImageIds.length > 0 || draftFileIds.length > 0) {
              const resolved = await bridge.resolveDraftAttachments(
                localId,
                draftImageIds,
                draftFileIds,
              )
              if (!resolved.ok) return resolved
              all = [...all, ...resolved.value]
            }
            if (all.length === 0 && refs.length === 0) {
              return bridge.sendPrompt(localId, p.text)
            }
            return refs.length === 0
              ? bridge.sendPrompt(localId, p.text, all)
              : bridge.sendPrompt(localId, p.text, all, refs)
          },
        )
        if (outcome.ok && ids.length > 0 && sender.deviceId !== undefined) {
          const resolver = this._host?.attachments
          void resolver?.consume(sender.deviceId, ids).catch((err: unknown) => {
            this._logger.warn(`mobile attachment consume failed: ${String(err)}`)
          })
        }
        if (outcome.ok) {
          const key = sessionKey(p.ref.windowId, p.ref.localId)
          // Invalidate draft updates that were received before this prompt.
          this._draftEpochs.set(key, (this._draftEpochs.get(key) ?? 0) + 1)
          const cleared = this._drafts.setFromRenderer(key, undefined)
          if (cleared.changed && cleared.state !== undefined) {
            this._broadcastDraft(key, cleared.state)
          }
          const entry = this._windows.get(p.ref.windowId)
          void entry?.bridge.clearDraft(p.ref.localId).catch((err: unknown) => {
            this._logger.warn(`mobile draft clear failed: ${String(err)}`)
          })
        }
        return outcome
      }
      case 'cancelTurn': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, 5000, (bridge, localId) => bridge.cancelTurn(localId))
      }
      case 'resolvePermission': {
        const p = frame.payload as {
          ref: MobileSessionRef
          requestId: string
          optionId: string
          feedback?: string
        }
        const resolved = this._resolveSession(p.ref)
        if (resolved === undefined) return failOutcome('session_not_found')
        const offered = this._permissionOptions.get(
          permissionKey(resolved.windowId, resolved.localId, p.requestId),
        )
        // A missing entry means the request is no longer pending here: it was settled
        // and cleared, or was never announced to a phone. That is a stale click, not a
        // policy denial; the bridge would answer `stale_request` for it too, and the
        // phone treats that as "already handled" instead of showing an error.
        if (offered === undefined) return failOutcome('stale_request')
        // The gateway must not route an option it cannot prove was offered.
        if (!offered.has(p.optionId)) return failOutcome('forbidden_operation')
        return this._withBridge(resolved, 10_000, (bridge) =>
          bridge.resolvePermission(resolved.localId, p.requestId, p.optionId, p.feedback),
        )
      }
      case 'cancelPermission': {
        const p = frame.payload as { ref: MobileSessionRef; requestId: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.cancelPermission(localId, p.requestId),
        )
      }
      case 'resolveElicitation': {
        const p = frame.payload as {
          ref: MobileSessionRef
          requestId: string
          action: 'accept' | 'decline' | 'cancel'
          content?: Record<string, string | number | boolean | string[]>
        }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.resolveElicitation(localId, p.requestId, p.action, p.content),
        )
      }
      case 'setConfigOption': {
        const p = frame.payload as {
          ref: MobileSessionRef
          configId: string
          value: string | boolean
        }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.setConfigOption(localId, p.configId, p.value),
        )
      }
      case 'getSessionSettings': {
        const p = frame.payload as GetSessionSettingsPayload
        return this._sessionCommand(p.ref, SESSION_SETTINGS_TIMEOUT_MS, (bridge, localId) =>
          bridge.getSessionSettings(localId),
        )
      }
      case 'setSubagentModel': {
        const p = frame.payload as SetSubagentModelPayload
        return this._sessionCommand(p.ref, SUBAGENT_MODEL_WRITE_TIMEOUT_MS, (bridge, localId) =>
          bridge.setSubagentModel(localId, p.model),
        )
      }
      case 'restartAgentProcess': {
        const p = frame.payload as RestartAgentProcessPayload
        return this._sessionCommand(p.ref, RESTART_PROCESS_TIMEOUT_MS, (bridge, localId) =>
          bridge.restartAgentProcess(localId),
        )
      }
      case 'setSessionMcpServers': {
        const p = frame.payload as SetSessionMcpServersPayload
        return this._sessionCommand(p.ref, SESSION_MCP_WRITE_TIMEOUT_MS, (bridge, localId) =>
          bridge.setSessionMcpServers(localId, p.servers),
        )
      }
      case 'pauseAutoResolve': {
        const p = frame.payload as { ref: MobileSessionRef; requestId: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.pauseAutoResolve(localId, p.requestId),
        )
      }
      case 'resumeAutoResolve': {
        const p = frame.payload as { ref: MobileSessionRef; requestId: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.resumeAutoResolve(localId, p.requestId),
        )
      }
      case 'newSession': {
        const p = frame.payload as {
          agentId: string
          workspace: { folder: string; authority?: string; relativePath?: string }
          initialPrompt?: string
        }
        if (this._windows.size > 1 && (await this._deliveryBusyForWorkspace(p.workspace))) {
          return failOutcome('delivery_busy')
        }
        return this._newSession(p)
      }
      case 'renameSession': {
        const p = frame.payload as { ref: MobileSessionRef; title: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.renameSession(localId, p.title),
        )
      }
      case 'closeSession': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.closeSession(localId),
        )
      }
      case 'deleteSession': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, 30_000, (bridge, localId) =>
          bridge.deleteSession(localId),
        )
      }
      case 'deleteHistorySession': {
        const p = frame.payload as { durableId: string; windowId?: number }
        return this._deleteHistorySession(p.durableId, p.windowId)
      }
      case 'forkSession': {
        const p = frame.payload as { ref: MobileSessionRef; messageId?: string }
        return this._sessionRefCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.forkSession(localId, p.messageId),
        )
      }
      case 'previewRewind': {
        const p = frame.payload as { ref: MobileSessionRef; messageId: string }
        return this._sessionCommand(p.ref, PREVIEW_REWIND_TIMEOUT_MS, (bridge, localId) =>
          bridge.previewRewind(localId, p.messageId),
        )
      }
      case 'rewindSession': {
        const p = frame.payload as {
          ref: MobileSessionRef
          messageId: string
          rewindFiles?: boolean
        }
        return this._sessionCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.rewindSession(localId, p.messageId, p.rewindFiles),
        )
      }
      case 'createSideTask': {
        const p = frame.payload as { ref: MobileSessionRef; quote?: string }
        return this._sessionRefCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.createSideTask(localId, p.quote),
        )
      }
      case 'listSideTasks': {
        const p = frame.payload as { ref: MobileSessionRef }
        const outcome = await this._sessionCommand(
          p.ref,
          LIST_SIDE_TASKS_TIMEOUT_MS,
          (bridge, localId) => bridge.listSideTasks(localId),
        )
        return outcome.ok ? { ok: true, result: clampSideTaskSummaries(outcome.result) } : outcome
      }
      case 'openSideTask': {
        const p = frame.payload as { ref: MobileSessionRef; sideTaskId: string }
        return this._sessionRefCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.openSideTask(localId, p.sideTaskId),
        )
      }
      case 'deleteSideTask': {
        const p = frame.payload as { ref: MobileSessionRef; sideTaskId: string }
        return this._sessionCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.deleteSideTask(localId, p.sideTaskId),
        )
      }
      case 'listWorkspaces':
        return this._listWorkspaces()
      case 'listDirectory':
        return this._listDirectory(frame.payload as ListDirectoryPayload)
      case 'getNewSessionOptions':
        return this._getNewSessionOptions(frame.payload as GetNewSessionOptionsPayload)
      case 'listAgents':
        return this._listAgents()
      case 'listSessionHistory':
        return this._listSessionHistory()
      case 'openSession': {
        const p = frame.payload as {
          durableId: string
          windowId?: number
          folder?: string
          authority?: string
        }
        return this._openSession(p.durableId, p.windowId, p.folder, p.authority)
      }
      case 'previewDelivery': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, DELIVERY_PREVIEW_TIMEOUT_MS, (bridge, localId) =>
          bridge.previewDelivery(localId, p.ref.durableId),
        )
      }
      case 'startDelivery': {
        const p = frame.payload as {
          ref: MobileSessionRef
          expectation: MobileDeliveryExpectation
        }
        return this._startDelivery(p.ref, p.expectation)
      }
      case 'getDelivery': {
        const p = frame.payload as { ref: MobileSessionRef; deliveryId: string }
        return this._sessionCommand(p.ref, DELIVERY_READ_TIMEOUT_MS, (bridge, localId) =>
          bridge.getDelivery(localId, p.deliveryId),
        )
      }
      case 'confirmDeliveryPush': {
        const p = frame.payload as { ref: MobileSessionRef; deliveryId: string }
        return this._sessionCommand(p.ref, DELIVERY_MUTATION_TIMEOUT_MS, (bridge, localId) =>
          bridge.confirmDeliveryPush(localId, p.deliveryId),
        )
      }
      case 'retryDelivery': {
        const p = frame.payload as { ref: MobileSessionRef; deliveryId: string }
        return this._sessionCommand(p.ref, DELIVERY_MUTATION_TIMEOUT_MS, (bridge, localId) =>
          bridge.retryDelivery(localId, p.deliveryId),
        )
      }
      case 'undoDelivery': {
        const p = frame.payload as { ref: MobileSessionRef; deliveryId: string }
        return this._sessionCommand(p.ref, DELIVERY_MUTATION_TIMEOUT_MS, (bridge, localId) =>
          bridge.undoDelivery(localId, p.deliveryId),
        )
      }
      case 'openDeliveryMainWorktree': {
        const p = frame.payload as { ref: MobileSessionRef; deliveryId: string }
        return this._sessionCommand(p.ref, DELIVERY_READ_TIMEOUT_MS, (bridge, localId) =>
          bridge.openDeliveryMainWorktree(localId, p.deliveryId),
        )
      }
      case 'previewPushBranch': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, DELIVERY_PREVIEW_TIMEOUT_MS, (bridge, localId) =>
          bridge.previewPushBranch(localId, p.ref.durableId),
        )
      }
      case 'pushBranch': {
        const p = frame.payload as {
          ref: MobileSessionRef
          expectation: MobilePushBranchExpectation
        }
        return this._sessionCommand(p.ref, DELIVERY_MUTATION_TIMEOUT_MS, (bridge, localId) =>
          bridge.pushBranch(localId, p.expectation, p.ref.durableId),
        )
      }
      default:
        // Unknown kinds still reach here through a newer phone; payload carried
        // through validation unchanged.
        void payload
        return failOutcome('not_supported')
    }
  }

  /**
   * Delete one catalog row addressed by durable id. The phone sends this only
   * for rows it could not delete through `deleteSession` (history rows have no
   * local id); live rows still use their ref.
   */
  private async _deleteHistorySession(
    durableId: string,
    windowIdHint: number | undefined,
  ): Promise<CommandOutcome> {
    const deadline = Date.now() + DELETE_HISTORY_TIMEOUT_MS

    // The PC may have resumed the row after the phone listed it. Route that
    // race through the live path so read-only / delivery guards still apply.
    const live = this._inboxSessionByDurable(durableId)
    let liveOutcome: CommandOutcome | undefined
    if (live !== undefined) {
      liveOutcome = await this._withBridge(live, DELETE_HISTORY_TIMEOUT_MS, (bridge) =>
        bridge.deleteSession(live.localId),
      )
      if (!liveOutcome.ok && liveOutcome.error !== 'session_not_found') return liveOutcome
    }

    // Two open windows on one workspace keep separate history mirrors, so drop
    // the row from every owner; otherwise a catalog refresh resurrects it.
    const entries = [...this._windows.values()]
    const owners = (
      await Promise.all(
        entries.map(async (entry) =>
          (await this._windowHasHistory(entry, durableId, deadline)) ? entry : undefined,
        ),
      )
    ).filter((entry): entry is WindowEntry => entry !== undefined)
    const hint = windowIdHint !== undefined ? this._windows.get(windowIdHint) : undefined
    if (hint !== undefined) {
      const index = owners.indexOf(hint)
      if (index > 0) {
        owners.splice(index, 1)
        owners.unshift(hint)
      }
    }

    if (owners.length === 0) {
      return liveOutcome?.ok === true ? liveOutcome : failOutcome('session_not_found')
    }

    const results = await Promise.all(
      owners.map((entry) => this._deleteHistoryInWindow(entry, durableId, deadline)),
    )
    const succeeded = results.find((outcome) => outcome.ok)
    if (succeeded !== undefined) return succeeded
    if (liveOutcome?.ok === true) return liveOutcome
    // A window that never had the row answers session_not_found; surface a real
    // failure (read-only, forbidden, internal) when every owner failed.
    return (
      results.find((outcome) => !outcome.ok && outcome.error !== 'session_not_found') ??
      results[0] ??
      failOutcome('session_not_found')
    )
  }

  private async _deleteHistoryInWindow(
    entry: WindowEntry,
    durableId: string,
    deadline: number,
  ): Promise<CommandOutcome> {
    try {
      const result = await withTimeout(
        entry.bridge.deleteHistorySession(durableId),
        Math.max(1, Math.min(DELETE_HISTORY_TIMEOUT_MS, deadline - Date.now())),
      )
      return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.code }
    } catch (err) {
      this._logger.warn(
        `mobile deleteHistorySession window ${entry.windowId} failed: ${String(err)}`,
      )
      return failOutcome('internal')
    }
  }

  private _inboxSessionByDurable(
    durableId: string,
  ): { windowId: number; localId: string } | undefined {
    for (const entry of this._inboxState.values()) {
      if (entry.summary.ref.durableId !== durableId) continue
      return { windowId: entry.windowId, localId: entry.summary.ref.localId }
    }
    return undefined
  }

  private async _sessionCommand(
    ref: MobileSessionRef,
    timeoutMs: number,
    call: (bridge: IMobileBridgeService, localId: string) => Promise<MobileBridgeResult<unknown>>,
  ): Promise<CommandOutcome> {
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return failOutcome('session_not_found')
    return this._withBridge(resolved, timeoutMs, (bridge) => call(bridge, resolved.localId))
  }

  /**
   * Like `_sessionCommand`, but the bridge result is a renderer-local session
   * ref: main stamps `windowId` so the phone can address the new session.
   */
  private async _sessionRefCommand(
    ref: MobileSessionRef,
    timeoutMs: number,
    call: (
      bridge: IMobileBridgeService,
      localId: string,
    ) => Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>,
  ): Promise<CommandOutcome> {
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return failOutcome('session_not_found')
    const outcome = await this._withBridge(resolved, timeoutMs, (bridge) =>
      call(bridge, resolved.localId),
    )
    if (!outcome.ok) return outcome
    if (!isBridgeNewSessionResult(outcome.result)) {
      this._logger.warn('mobile bridge returned an invalid session ref')
      return failOutcome('internal')
    }
    const value = outcome.result
    const created: MobileNewSessionResult = {
      ref: {
        windowId: resolved.windowId,
        localId: value.localId,
        ...(value.durableId !== undefined ? { durableId: value.durableId } : {}),
      },
    }
    return { ok: true, result: created }
  }

  private async _withBridge(
    resolved: { windowId: number; localId: string },
    timeoutMs: number,
    call: (bridge: IMobileBridgeService) => Promise<MobileBridgeResult<unknown>>,
  ): Promise<CommandOutcome> {
    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) return failOutcome('session_not_found')
    try {
      const result = await withTimeout(call(entry.bridge), timeoutMs)
      return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.code }
    } catch (err) {
      this._logger.warn(`mobile command failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  private async _startDelivery(
    ref: MobileSessionRef,
    expectation: MobileDeliveryExpectation,
  ): Promise<CommandOutcome> {
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return failOutcome('session_not_found')
    if (await this._deliveryBusyForSession(ref)) return failOutcome('delivery_busy')
    return this._withBridge(resolved, DELIVERY_START_TIMEOUT_MS, (bridge) =>
      bridge.startDelivery(resolved.localId, expectation, ref.durableId),
    )
  }

  /**
   * Cross-window guard: a phone may address a window whose bridge has only its
   * own delivery records. A delivery in another window for the same source (or
   * main) worktree must reject prompts/starts before they reach the renderer.
   * The git directory lock is still the final defence.
   */
  private async _deliveryBusyForSession(ref: MobileSessionRef): Promise<boolean> {
    if (this._windows.size <= 1) return false
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return false
    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) return false
    let context: MobileBridgeDeliveryContext | undefined
    try {
      context = await withTimeout(
        entry.bridge.getDeliveryContext(resolved.localId, ref.durableId),
        DELIVERY_GUARD_TIMEOUT_MS,
      )
    } catch {
      return false
    }
    if (context === undefined) return false
    return this._deliveryBusyForCwd(resolved.windowId, context.sourceCwd, context.authority)
  }

  private async _deliveryBusyForWorkspace(workspace: {
    folder: string
    authority?: string
  }): Promise<boolean> {
    if (this._windows.size <= 1) return false
    let folder: URI
    try {
      folder = URI.parse(workspace.folder)
    } catch {
      return false
    }
    const authority = workspace.authority ?? folder.authority ?? undefined
    const cwd = folder.scheme ? folder.fsPath : workspace.folder
    return this._deliveryBusyForCwd(-1, cwd, authority || undefined)
  }

  private async _deliveryBusyForCwd(
    excludeWindowId: number,
    cwd: string,
    authority: string | undefined,
  ): Promise<boolean> {
    const probes = [...this._windows.values()]
      .filter((entry) => entry.windowId !== excludeWindowId)
      .map(async (entry) => {
        try {
          return await withTimeout(entry.bridge.listActiveDeliveries(), DELIVERY_GUARD_TIMEOUT_MS)
        } catch {
          return []
        }
      })
    const activeDeliveries = await Promise.all(probes)
    for (const contexts of activeDeliveries) {
      for (const context of contexts) {
        if ((context.authority ?? '') !== (authority ?? '')) continue
        if (isPathInside(context.sourceCwd, cwd, authority)) return true
        if (
          context.mainWorktree !== undefined &&
          isPathInside(context.mainWorktree, cwd, authority)
        ) {
          return true
        }
      }
    }
    return false
  }

  private async _newSession(payload: {
    agentId: string
    workspace: { folder: string; authority?: string; relativePath?: string }
    initialPrompt?: string
  }): Promise<CommandOutcome> {
    const relativePath = parseWorkspaceRelativePath(payload.workspace.relativePath)
    if (relativePath === null) return failOutcome('bad_request')
    const deadline = Date.now() + NEW_SESSION_TIMEOUT_MS
    const opened = await this._openWorkspaceWindow(payload.workspace, deadline)
    if (!opened.ok) return { ok: false, error: opened.error }
    const { entry, authority, folder } = opened
    const windowId = entry.windowId

    try {
      const result = await callWithToken(
        (token) =>
          entry.bridge.newSession(
            payload.agentId,
            {
              folder,
              ...(authority !== undefined ? { authority } : {}),
              ...(relativePath.path !== '' ? { relativePath: relativePath.path } : {}),
            },
            payload.initialPrompt ?? null,
            token,
          ),
        Math.max(1, deadline - Date.now()),
      )
      if (!result.ok) return { ok: false, error: result.code }
      const created: MobileNewSessionResult = {
        ref: {
          windowId,
          localId: result.value.localId,
          ...(result.value.durableId !== undefined ? { durableId: result.value.durableId } : {}),
        },
      }
      return { ok: true, result: created }
    } catch (err) {
      this._logger.warn(`mobile newSession failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  /**
   * Bring a workspace's window to the foreground (when needed), wait for main
   * to register its reverse channel and for the renderer to answer, then hand
   * back the ready window entry. Shared by `newSession` and the history
   * `openSession` fallback so both paths behave identically.
   */
  private async _openWorkspaceWindow(
    workspace: { folder: string; authority?: string },
    deadline: number,
  ): Promise<
    | { ok: true; entry: WindowEntry; authority: string | undefined; folder: string }
    | OpenWorkspaceFailure
  > {
    const open = this._host?.listOpenWorkspaces() ?? []
    const recent = (await this._host?.listRecentWorkspaces().catch(() => [])) ?? []
    const openMatch = open.find((candidate) => isSameWorkspace(candidate, workspace))
    const recentMatch = recent.find((candidate) => isSameWorkspace(candidate, workspace))
    const target = openMatch ?? recentMatch
    if (target === undefined) return { ok: false, error: 'workspace_not_open' }

    // Match is case-insensitive on Windows even for remote-ssh, whose paths are
    // POSIX; hand the bridge the matched spelling so its containment check uses
    // the same root as the workspace, not the phone's variation.
    const folder = target.folder
    const authority = workspace.authority ?? target.authority
    let windowId = openMatch?.windowId
    if (windowId === undefined || !this._windows.has(windowId)) {
      if (openMatch === undefined) {
        const host = this._host
        if (host === undefined) return { ok: false, error: 'workspace_not_open' }
        try {
          await withTimeout(
            host.openWorkspace(folder, authority),
            Math.max(1, deadline - Date.now()),
          )
        } catch (err) {
          this._logger.warn(`mobile openWorkspace failed: ${String(err)}`)
          return { ok: false, error: 'workspace_not_open' }
        }
      }
      windowId = await this._host?.waitForBridge(
        folder,
        authority,
        Math.max(0, deadline - Date.now()),
      )
    }
    if (windowId === undefined) return { ok: false, error: 'workspace_not_open' }
    const entry = this._windows.get(windowId)
    if (entry === undefined) return { ok: false, error: 'workspace_not_open' }

    // `waitForBridge` only proves main registered the reverse channel. A fresh
    // window's renderer registers its side after the bundle boots, so a command
    // sent now is dropped by the transport and never settles; ping until the
    // renderer actually answers. Also covers a renderer reload.
    if (!(await this._ensureWindowReady(entry, deadline))) {
      this._logger.warn(
        `mobile renderer not ready within the command deadline (window=${windowId})`,
      )
      return { ok: false, error: 'workspace_not_open' }
    }
    return { ok: true, entry, authority, folder }
  }

  /**
   * A dropped frame (renderer listener not installed yet) never settles, so
   * each probe is bounded and cancelled on timeout. A failed probe also clears
   * `rendererReady`: a reload kills the old renderer's wiring, and the next
   * successful ping must rebuild it. Retries stop at the shared deadline.
   */
  private async _waitForBridgeReady(entry: WindowEntry, deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      if (this._windows.get(entry.windowId) !== entry) return false
      try {
        await callWithToken(
          (token) => entry.bridge.ping(token),
          Math.max(1, Math.min(BRIDGE_PING_TIMEOUT_MS, deadline - Date.now())),
        )
        return true
      } catch {
        // Transport drop, ChannelNotFound, channel disposed, or timeout: retry.
        if (this._windows.get(entry.windowId) === entry) this._markRendererLost(entry)
      }
      const sleepMs = Math.min(BRIDGE_PING_INTERVAL_MS, deadline - Date.now())
      if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs))
    }
    return false
  }

  /**
   * Probe until the renderer channel answers, then run the deferred wiring on
   * the first success. Used by both the command path and the background sync.
   */
  private async _ensureWindowReady(entry: WindowEntry, deadline: number): Promise<boolean> {
    if (!(await this._waitForBridgeReady(entry, deadline))) return false
    if (this._windows.get(entry.windowId) !== entry) return false
    if (!entry.rendererReady) {
      entry.rendererReady = true
      this._syncWindow(entry)
    }
    return true
  }

  /**
   * A failed probe means the old renderer's event wiring is gone (reload) or
   * never existed. Reset the flags so a later successful probe re-subscribes
   * and re-sends the idempotent streaming/attention toggles; the old renderer
   * is not asked to stop because it may already be gone.
   */
  private _markRendererLost(entry: WindowEntry): void {
    entry.rendererReady = false
    entry.subscription?.dispose()
    entry.subscription = undefined
    entry.streaming = false
    entry.attention = false
  }

  private _startReadyProbe(entry: WindowEntry): void {
    if (entry.readyProbe !== undefined) return
    const probe = this._ensureWindowReady(entry, Date.now() + NEW_SESSION_TIMEOUT_MS)
    entry.readyProbe = probe
    void probe.finally(() => {
      if (entry.readyProbe === probe) entry.readyProbe = undefined
    })
  }

  private async _listWorkspaces(): Promise<CommandOutcome> {
    const open = this._host?.listOpenWorkspaces() ?? []
    const recent = (await this._host?.listRecentWorkspaces().catch(() => [])) ?? []
    // The phone keeps group order as-is, so the open group needs the same
    // newest-first recency order as the recent group. Window order is just
    // window creation order; rank each open workspace by its position in the
    // recent list (which is `lastOpened` desc), unknown ones last.
    const openByRecency = open
      .map((workspace, windowOrder) => ({
        workspace,
        windowOrder,
        recentIndex: recent.findIndex((entry) => isSameWorkspace(entry, workspace)),
      }))
      .sort((a, b) => {
        const left = a.recentIndex === -1 ? Number.MAX_SAFE_INTEGER : a.recentIndex
        const right = b.recentIndex === -1 ? Number.MAX_SAFE_INTEGER : b.recentIndex
        return left - right || a.windowOrder - b.windowOrder
      })
      .map((entry) => entry.workspace)
    const result: MobileWorkspaceCandidate[] = openByRecency.map((workspace) => ({
      folder: workspace.folder,
      name: workspace.name,
      ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
      isOpen: true,
      ...(workspace.windowId !== undefined ? { windowId: workspace.windowId } : {}),
    }))
    for (const workspace of recent) {
      if (open.some((candidate) => isSameWorkspace(candidate, workspace))) continue
      result.push({
        folder: workspace.folder,
        name: workspace.name,
        ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
        isOpen: false,
      })
    }
    await this._annotateWorkspaceGitDirty(result, open.length)
    return { ok: true, result }
  }

  /**
   * Directory browsing deliberately does not open a window: a recent-but-closed
   * workspace can be browsed without bringing the PC front and center. It also
   * never touches the renderer bridge, so main's IFileService (local + remote
   * providers) is the single implementation for both kinds of workspace.
   */
  private async _listDirectory(payload: ListDirectoryPayload): Promise<CommandOutcome> {
    const parsed = parseWorkspaceRelativePath(payload.relativePath)
    if (parsed === null) return failOutcome('bad_request')
    const host = this._host
    const listDirectory = host?.listDirectory?.bind(host)
    if (host === undefined || listDirectory === undefined) return failOutcome('not_supported')

    const open = host.listOpenWorkspaces()
    const recent = (await host.listRecentWorkspaces().catch(() => [])) ?? []
    const target =
      open.find((candidate) => isSameWorkspace(candidate, payload)) ??
      recent.find((candidate) => isSameWorkspace(candidate, payload))
    if (target === undefined) return failOutcome('workspace_not_open')

    try {
      const listing = await withTimeout(
        listDirectory(target, parsed.path === '' ? undefined : parsed.path),
        LIST_DIRECTORY_TIMEOUT_MS,
      )
      return { ok: true, result: listing }
    } catch (err) {
      if (err instanceof WorkspaceDirectoryBrowseError) return failOutcome(err.code)
      this._logger.warn(`mobile listDirectory failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  /**
   * Read-only new-session defaults (remembered directory + configured project
   * roots). Like `listDirectory` this never opens a window; the host derives
   * everything from the matched workspace.
   */
  private async _getNewSessionOptions(
    payload: GetNewSessionOptionsPayload,
  ): Promise<CommandOutcome> {
    const host = this._host
    const read = host?.readNewSessionOptions?.bind(host)
    if (host === undefined || read === undefined) return failOutcome('not_supported')

    const open = host.listOpenWorkspaces()
    const recent = (await host.listRecentWorkspaces().catch(() => [])) ?? []
    const target =
      open.find((candidate) => isSameWorkspace(candidate, payload)) ??
      recent.find((candidate) => isSameWorkspace(candidate, payload))
    if (target === undefined) return failOutcome('workspace_not_open')

    try {
      const options = await withTimeout(read(target), NEW_SESSION_OPTIONS_TIMEOUT_MS)
      return { ok: true, result: options }
    } catch (err) {
      this._logger.warn(`mobile getNewSessionOptions failed: ${describeFsError(err)}`)
      return failOutcome('internal')
    }
  }

  /**
   * Local workspaces are probed by main; remote candidates only answer through
   * an open, ready renderer. The phone shows no marker for unknown, so a slow
   * repo or a booting window degrades to "no badge" instead of blocking the
   * whole list.
   */
  private async _annotateWorkspaceGitDirty(
    candidates: MobileWorkspaceCandidate[],
    openCount: number,
  ): Promise<void> {
    const host = this._host
    if (host?.workspaceGitDirty === undefined) return
    // Every open window is needed for the inbox join; only recent-only entries
    // are capped.
    const limit = Math.max(MAX_GIT_STATUS_CANDIDATES, openCount)
    const targets = candidates.slice(0, limit)
    const controller = new AbortController()
    const results = new Map<number, boolean>()
    const run = mapWithConcurrency(targets, GIT_STATUS_CONCURRENCY, async (candidate, index) => {
      const entry =
        candidate.windowId !== undefined ? this._windows.get(candidate.windowId) : undefined
      const bridge = entry?.rendererReady === true ? entry.bridge : undefined
      try {
        const value = await host.workspaceGitDirty!(candidate, bridge, controller.signal)
        if (!controller.signal.aborted && value !== undefined) results.set(index, value)
      } catch {
        // Unknown for this candidate; keep probing the rest.
      }
    })
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        budgetTimer = setTimeout(resolve, GIT_STATUS_TOTAL_BUDGET_MS)
      }),
    ])
    if (budgetTimer !== undefined) clearTimeout(budgetTimer)
    controller.abort()
    for (const [index, value] of results) {
      const candidate = candidates[index]
      if (candidate !== undefined) candidate.gitDirty = value
    }
  }

  private async _listAgents(): Promise<CommandOutcome> {
    const entries = [...this._windows.values()]
    // Prefer a renderer that already answered; otherwise probe the first one.
    const entry = entries.find((candidate) => candidate.rendererReady) ?? entries[0]
    if (entry === undefined) return { ok: true, result: [] as MobileAgentCandidate[] }
    try {
      const deadline = Date.now() + LIST_AGENTS_TIMEOUT_MS
      if (!(await this._ensureWindowReady(entry, deadline))) {
        return failOutcome('internal')
      }
      return {
        ok: true,
        result: await callWithToken(
          (token) => entry.bridge.listAgents(token),
          Math.max(1, deadline - Date.now()),
        ),
      }
    } catch (err) {
      this._logger.warn(`mobile listAgents failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  private async _listSessionHistory(): Promise<CommandOutcome> {
    const openWorkspaceByWindow = new Map<number, MobileGatewayHostWorkspace>()
    for (const workspace of this._host?.listOpenWorkspaces() ?? []) {
      if (workspace.windowId !== undefined) openWorkspaceByWindow.set(workspace.windowId, workspace)
    }
    const windows = [...this._windows.values()]
    // Open windows stay authoritative and fresh: they read the renderer's
    // in-memory mirror, which also sees history writes that are still inside
    // the renderer's write debounce. When a renderer cannot answer (still
    // booting, timed out, reloading), fall back to that workspace's bucket so
    // its rows do not vanish from the catalog.
    const openLists = await Promise.all(
      windows.map(async (entry) => {
        const readFallback = async (reason: string): Promise<MobileSessionHistoryEntry[]> => {
          const workspace = openWorkspaceByWindow.get(entry.windowId)
          if (workspace === undefined) return []
          this._logger.warn(
            `mobile history list window ${entry.windowId} ${reason}; reading its bucket instead`,
          )
          return this._readWorkspaceHistory(workspace)
        }
        try {
          // A window registered before its renderer booted cannot answer; give
          // it the same short readiness window as the inbox snapshot.
          if (
            !(await this._ensureWindowReady(entry, Date.now() + HISTORY_WINDOW_READY_TIMEOUT_MS))
          ) {
            return await readFallback('renderer not ready')
          }
          const rows = await callWithToken(
            (token) => entry.bridge.listSessionHistory(token),
            HISTORY_LIST_TIMEOUT_MS,
          )
          return rows
            .map((row) =>
              this._toProtocolHistoryEntry(row, {
                windowId: entry.windowId,
                workspaceName: this._workspaceName(entry),
              }),
            )
            .filter((row): row is MobileSessionHistoryEntry => row !== undefined)
        } catch (err) {
          return await readFallback(`failed: ${String(err)}`)
        }
      }),
    )

    const diskHistories = await this._readClosedWorkspaceHistories()

    // Two windows on the same workspace each keep their own history bucket.
    // Keep one row per durable id; a pinned row or the freshest timestamp wins
    // among open windows, the same rule dedupes disk copies, and an open row
    // always beats the disk copy.
    const byDurable = new Map<string, MobileSessionHistoryEntry>()
    for (const rows of openLists) {
      for (const row of rows) {
        const existing = byDurable.get(row.durableId)
        if (existing === undefined || preferHistoryRow(row, existing)) {
          byDurable.set(row.durableId, row)
        }
      }
    }
    const diskByDurable = new Map<string, MobileSessionHistoryEntry>()
    for (const { rows } of diskHistories) {
      for (const row of rows) {
        const existing = diskByDurable.get(row.durableId)
        if (existing === undefined || preferHistoryRow(row, existing)) {
          diskByDurable.set(row.durableId, row)
        }
      }
    }
    for (const [durableId, row] of diskByDurable) {
      if (!byDurable.has(durableId)) byDurable.set(durableId, row)
    }
    const result = [...byDurable.values()]
      .sort(
        (a, b) =>
          Number(b.pinned === true) - Number(a.pinned === true) || b.lastUsedAt - a.lastUsedAt,
      )
      .slice(0, MAX_HISTORY_RESULTS)
    return { ok: true, result }
  }

  /** Recent workspaces that no open window covers, capped by configuration. */
  private async _closedHistoryWorkspaces(): Promise<MobileGatewayHostWorkspace[]> {
    const host = this._host
    if (host === undefined) return []
    const recent = await host.listRecentWorkspaces().catch(() => [])
    const open = host.listOpenWorkspaces()
    const limit = this._historyWorkspaceLimit()
    const targets: MobileGatewayHostWorkspace[] = []
    for (const workspace of recent) {
      if (targets.length >= limit) break
      if (open.some((candidate) => isSameWorkspace(candidate, workspace))) continue
      targets.push(workspace)
    }
    return targets
  }

  private _historyWorkspaceLimit(): number {
    const raw = this._host?.sessionHistoryWorkspaceLimit()
    if (raw === undefined || !Number.isInteger(raw) || raw < 1) {
      return MOBILE_GATEWAY_DEFAULT_SESSION_HISTORY_WORKSPACE_LIMIT
    }
    return Math.min(raw, MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT)
  }

  /**
   * Read every closed candidate's bucket with bounded concurrency. Both the
   * catalog and the deep-link reverse lookup consume this shape.
   */
  private async _readClosedWorkspaceHistories(): Promise<ClosedWorkspaceHistory[]> {
    const workspaces = await this._closedHistoryWorkspaces()
    const results = new Array<ClosedWorkspaceHistory | undefined>(workspaces.length)
    await mapWithConcurrency(
      workspaces,
      HISTORY_DISK_READ_CONCURRENCY,
      async (workspace, index) => {
        results[index] = { workspace, rows: await this._readWorkspaceHistory(workspace) }
      },
    )
    return results.filter((value): value is ClosedWorkspaceHistory => value !== undefined)
  }

  /** Find the closed workspace whose persisted bucket owns a durable id. */
  private async _findClosedWorkspaceForSession(
    durableId: string,
  ): Promise<MobileGatewayHostWorkspace | undefined> {
    const histories = await this._readClosedWorkspaceHistories()
    for (const { workspace, rows } of histories) {
      if (rows.some((row) => row.durableId === durableId)) return workspace
    }
    return undefined
  }

  private async _readWorkspaceHistory(
    workspace: MobileGatewayHostWorkspace,
  ): Promise<MobileSessionHistoryEntry[]> {
    const host = this._host
    if (host === undefined) return []
    try {
      const rows = await withTimeout(
        host.readWorkspaceSessionHistory(workspace),
        HISTORY_DISK_READ_TIMEOUT_MS,
      )
      return rows
        .map((row) =>
          this._toProtocolHistoryEntry(row, {
            workspaceName: workspace.name,
            folder: workspace.folder,
            ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
          }),
        )
        .filter((row): row is MobileSessionHistoryEntry => row !== undefined)
    } catch (err) {
      this._logger.warn(`mobile history read for ${workspace.name} failed: ${String(err)}`)
      return []
    }
  }

  private _openSession(
    durableId: string,
    windowIdHint: number | undefined,
    folder: string | undefined,
    authority: string | undefined,
  ): Promise<CommandOutcome> {
    const inflight = this._inflightOpenSessions.get(durableId)
    if (inflight !== undefined) return inflight
    const deadline = Date.now() + OPEN_SESSION_TIMEOUT_MS
    const promise = this._openSessionOnce(durableId, windowIdHint, folder, authority, deadline)
    this._inflightOpenSessions.set(durableId, promise)
    const release = (): void => {
      if (this._inflightOpenSessions.get(durableId) === promise) {
        this._inflightOpenSessions.delete(durableId)
      }
    }
    void promise.then(release, release)
    return promise
  }

  private async _openSessionOnce(
    durableId: string,
    windowIdHint: number | undefined,
    folder: string | undefined,
    authority: string | undefined,
    deadline: number,
  ): Promise<CommandOutcome> {
    const live = await this._findLiveRef(durableId, deadline)
    if (live !== undefined) return { ok: true, result: { ref: live } }

    const candidates = [...this._windows.values()]
    const hint = windowIdHint !== undefined ? this._windows.get(windowIdHint) : undefined
    const owners = (
      await Promise.all(
        candidates.map(async (entry) =>
          (await this._windowHasHistory(entry, durableId, deadline)) ? entry : undefined,
        ),
      )
    ).filter((entry): entry is WindowEntry => entry !== undefined)
    if (hint !== undefined) {
      const index = owners.indexOf(hint)
      if (index > 0) {
        owners.splice(index, 1)
        owners.unshift(hint)
      }
    }
    if (owners.length === 0) {
      // A catalog row from a closed workspace carries its folder. Deep links and
      // refreshed pages may not: reverse-look the durable id in the same closed
      // workspace buckets the catalog reads. Reuse the new-session open flow so
      // the phone can resume without first opening the workspace by hand.
      const target =
        folder !== undefined
          ? { folder, ...(authority !== undefined ? { authority } : {}) }
          : await this._findClosedWorkspaceForSession(durableId)
      if (target === undefined) return failOutcome('session_not_found')
      const opened = await this._openWorkspaceWindow(target, deadline)
      if (!opened.ok) return { ok: false, error: opened.error }
      // A fresh renderer may still be swapping from the empty/GLOBAL bucket to
      // this workspace's bucket. Poll until the row becomes visible instead of
      // resuming before the history exists.
      if (!(await this._waitForHistory(opened.entry, durableId, deadline))) {
        return failOutcome('session_not_found')
      }
      return this._openSessionInWindow(opened.entry, durableId, deadline)
    }

    let lastError: MobileErrorCode | undefined
    for (const target of owners) {
      const outcome = await this._openSessionInWindow(target, durableId, deadline)
      if (outcome.ok) return outcome
      lastError = outcome.error
      // A stale hint or a window that lost its workspace can fail while another
      // window still owns the row. Transient failures are not retried: a second
      // full resume would exceed the phone's deadline.
      if (outcome.error !== 'session_not_found' && outcome.error !== 'forbidden_operation') {
        return outcome
      }
    }
    return lastError === undefined
      ? failOutcome('session_not_found')
      : { ok: false, error: lastError }
  }

  private async _openSessionInWindow(
    target: WindowEntry,
    durableId: string,
    deadline: number,
  ): Promise<CommandOutcome> {
    try {
      const result = await callWithToken(
        (token) => target.bridge.openSession(durableId, token),
        Math.max(1, deadline - Date.now()),
      )
      if (!result.ok) return { ok: false, error: result.code }
      if (!isBridgeNewSessionResult(result.value)) {
        this._logger.warn('mobile bridge returned an invalid session ref')
        return failOutcome('internal')
      }
      const created: MobileNewSessionResult = {
        ref: {
          windowId: target.windowId,
          localId: result.value.localId,
          durableId: result.value.durableId ?? durableId,
        },
      }
      return { ok: true, result: created }
    } catch (err) {
      this._logger.warn(`mobile openSession failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  /**
   * Wait for a freshly opened window's history service to publish this row.
   * Keeps polling on the caller's shared budget so the whole command still
   * fits inside the phone's timeout.
   */
  private async _waitForHistory(
    entry: WindowEntry,
    durableId: string,
    deadline: number,
  ): Promise<boolean> {
    while (Date.now() < deadline) {
      if (await this._windowHasHistory(entry, durableId, deadline)) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await delay(Math.min(HISTORY_OPEN_POLL_INTERVAL_MS, remaining))
    }
    return false
  }

  /**
   * A resumable row may already be resident somewhere. Prefer the inbox cache
   * maintained by streaming; when no phone subscribed, ask each window directly
   * so a resume never duplicates an agent session in another window.
   */
  private async _findLiveRef(
    durableId: string,
    deadline: number,
  ): Promise<MobileSessionRef | undefined> {
    for (const entry of this._inboxState.values()) {
      const ref = entry.summary.ref
      if (ref.durableId === durableId) return ref
    }
    const windows = [...this._windows.values()]
    const lists = await Promise.all(
      windows.map(async (entry) => {
        try {
          const readyDeadline = Math.min(deadline, Date.now() + HISTORY_WINDOW_READY_TIMEOUT_MS)
          if (!(await this._ensureWindowReady(entry, readyDeadline))) {
            return undefined
          }
          return await callWithToken(
            (token) => entry.bridge.listSessions(token),
            Math.max(1, Math.min(HISTORY_OWNER_TIMEOUT_MS, deadline - Date.now())),
          )
        } catch {
          return undefined
        }
      }),
    )
    for (let index = 0; index < lists.length; index += 1) {
      const summary = lists[index]?.find((row) => row.durableId === durableId)
      if (summary === undefined) continue
      return {
        windowId: windows[index]!.windowId,
        localId: summary.localId,
        durableId,
      }
    }
    return undefined
  }

  private async _windowHasHistory(
    entry: WindowEntry,
    durableId: string,
    deadline: number,
  ): Promise<boolean> {
    try {
      const readyDeadline = Math.min(deadline, Date.now() + HISTORY_WINDOW_READY_TIMEOUT_MS)
      if (!(await this._ensureWindowReady(entry, readyDeadline))) {
        return false
      }
      return await callWithToken(
        (token) => entry.bridge.hasSessionHistory(durableId, token),
        Math.max(1, Math.min(HISTORY_OWNER_TIMEOUT_MS, deadline - Date.now())),
      )
    } catch {
      return false
    }
  }

  private _toProtocolHistoryEntry(
    row: MobileBridgeSessionHistoryEntry,
    context: HistoryEntryContext,
  ): MobileSessionHistoryEntry | undefined {
    const durableId = clampText(row.durableId, MAX_ID_LENGTH)
    const agentId = clampText(row.agentId, MAX_ID_LENGTH)
    // A corrupted persisted row must not fail the phone's all-or-nothing list
    // guard; drop it here instead.
    if (durableId === '' || agentId === '') return undefined
    if (!Number.isFinite(row.createdAt) || !Number.isFinite(row.lastUsedAt)) return undefined
    // `folder` and `authority` are identities, not display text: truncating
    // them would make the phone open or label the wrong workspace. Drop an
    // over-long hint instead, matching the protocol's payload limits.
    const folder =
      context.folder !== undefined && context.folder.length <= MAX_SERVER_FRAME_BYTES
        ? context.folder
        : undefined
    const rawAuthority = row.authority ?? context.authority
    const authority =
      rawAuthority !== undefined && rawAuthority.length <= MAX_WORKSPACE_NAME_LENGTH
        ? rawAuthority
        : undefined
    return {
      durableId,
      ...(context.windowId !== undefined ? { windowId: context.windowId } : {}),
      agentId,
      ...(row.agentName !== undefined
        ? { agentName: clampText(row.agentName, MAX_TITLE_LENGTH) }
        : {}),
      title: clampText(row.title, MAX_TITLE_LENGTH),
      ...(row.firstPrompt !== undefined
        ? { firstPrompt: clampText(row.firstPrompt, MAX_HISTORY_PROMPT_LENGTH) }
        : {}),
      workspaceName: clampText(context.workspaceName, MAX_WORKSPACE_NAME_LENGTH),
      ...(folder !== undefined ? { folder } : {}),
      ...(row.cwd !== undefined ? { cwd: clampText(row.cwd, MAX_WORKSPACE_NAME_LENGTH) } : {}),
      ...(authority !== undefined ? { authority } : {}),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.pinned === true ? { pinned: true } : {}),
    }
  }

  private _pruneIdempotency(): void {
    const now = Date.now()
    for (const [key, entry] of this._idempotentResults) {
      if (entry.expiresAt <= now) this._idempotentResults.delete(key)
    }
  }

  private _cachePermission(
    windowId: number,
    localId: string,
    permission: MobilePendingPermission,
  ): void {
    this._permissionOptions.set(
      permissionKey(windowId, localId, permission.requestId),
      new Set(permission.options.map((option) => option.optionId)),
    )
  }

  private _clearPermission(windowId: number, localId: string, requestId: string): void {
    this._permissionOptions.delete(permissionKey(windowId, localId, requestId))
  }

  private _clearSessionPermissions(windowId: number, localId: string): void {
    const prefix = `${windowId}:${localId}:`
    for (const key of this._permissionOptions.keys()) {
      if (key.startsWith(prefix)) this._permissionOptions.delete(key)
    }
  }

  private _clearWindowPermissions(windowId: number): void {
    const prefix = `${windowId}:`
    for (const key of this._permissionOptions.keys()) {
      if (key.startsWith(prefix)) this._permissionOptions.delete(key)
    }
  }

  private _find(connection: MobileGatewayHubConnection): HubConnectionState | undefined {
    for (const state of this._connections) {
      if (state.connection === connection) return state
    }
    return undefined
  }

  private _handleBridgeEvent(windowId: number, event: MobileBridgeEvent): void {
    const entry = this._windows.get(windowId)
    if (entry === undefined) return
    if (event.kind === 'attention') {
      this._handleAttention(windowId, event)
      return
    }
    if (event.kind === 'inbox') {
      const upserts = event.upserts.map((summary) => this._toProtocolSummary(entry, summary))
      for (const summary of upserts) {
        this._inboxState.set(sessionKey(windowId, summary.ref.localId), {
          windowId,
          summary,
        })
      }
      const removes: MobileSessionRef[] = []
      for (const ref of event.removes) {
        this._inboxState.delete(sessionKey(windowId, ref.localId))
        this._clearSessionPermissions(windowId, ref.localId)
        this._drafts.delete(sessionKey(windowId, ref.localId))
        removes.push({
          windowId,
          localId: ref.localId,
          ...(ref.durableId !== undefined ? { durableId: ref.durableId } : {}),
        })
        // A subscriber may be looking at the session when it closes (from the
        // phone itself or from the PC). Tell it explicitly instead of leaving
        // the page on stale data until the next resubscribe.
        const key = sessionKey(windowId, ref.localId)
        for (const state of this._connections) {
          const subscription = state.sessions.get(key)
          if (subscription === undefined) continue
          subscription.cancelled = true
          state.sessions.delete(key)
          this._send(
            state.connection,
            { type: 'session_removed', ref: subscription.ref },
            subscription.localId,
          )
        }
      }
      this._broadcastInboxDelta(upserts, removes)
      return
    }
    if (event.kind === 'draft') {
      const key = sessionKey(windowId, event.localId)
      const result = this._drafts.setFromRenderer(key, event.draft)
      // The renderer increments its awaiting-publish counter for every local
      // publish; ack even an unchanged or empty draft or it waits forever.
      // No registry entry means the hub never assigned this session a revision.
      const revision = result.state?.revision ?? 0
      void entry.bridge.ackDraftRevision(event.localId, revision).catch(() => undefined)
      if (!result.changed || result.state === undefined) return
      // An empty state clears every subscriber's draft; the registry itself
      // drops the entry so a later snapshot does not resurrect it.
      if (isDraftEmpty(result.state)) this._drafts.delete(key)
      this._broadcastDraft(key, result.state)
      return
    }
    for (const delta of event.events) {
      if (delta.type === 'permission_upsert') {
        this._cachePermission(windowId, event.localId, delta.permission)
      } else if (delta.type === 'permission_cleared') {
        this._clearPermission(windowId, event.localId, delta.requestId)
      }
    }
    for (const state of this._connections) {
      const subscription = state.sessions.get(sessionKey(windowId, event.localId))
      if (subscription === undefined) continue
      const events = event.events.map((delta) => this._toProtocolEvent(entry, delta))
      for (const delta of events) {
        if (delta.type !== 'summary_changed') continue
        subscription.ref = delta.summary.ref
      }
      if (subscription.snapshotPending) {
        subscription.buffered.push(...events)
        continue
      }
      this._sendSessionEvents(state, subscription, events)
    }
  }

  /**
   * Single outbound exit: a frame the protocol validator would reject must never
   * reach the phone, because the client drops the whole frame (including a
   * snapshot) and would otherwise wait forever.
   */
  private _send(
    connection: MobileGatewayHubConnection,
    frame: ServerFrame,
    sessionId?: string,
  ): boolean {
    const parsed = parseServerFrame(serializeFrame(frame))
    if (parsed.ok) {
      connection.send(frame)
      return true
    }
    // A draft can be larger than the wire limits (PC prompt has no protocol
    // cap). Drop just the draft so the snapshot/delta still reaches the phone.
    const stripped = stripDraft(frame)
    if (stripped !== undefined) {
      const retry = parseServerFrame(serializeFrame(stripped))
      if (retry.ok) {
        this._logger.warn(
          `mobile gateway dropped an out-of-range draft type=${frame.type} session=${sessionId ?? '-'}: ${parsed.error.message}`,
        )
        connection.send(stripped)
        return true
      }
    }
    this._logger.error(
      `mobile gateway dropped invalid frame type=${frame.type} session=${sessionId ?? '-'}: ${parsed.error.message}`,
    )
    return false
  }

  private _sendSessionEvents(
    state: HubConnectionState,
    subscription: SessionSubscription,
    events: readonly MobileSessionEvent[],
  ): void {
    if (events.length === 0 || subscription.desynced) return
    if (state.connection.bufferedAmount() > MAX_BUFFERED_SESSION_BYTES) {
      subscription.desynced = true
      this._send(
        state.connection,
        {
          type: 'resync_required',
          scope: 'session',
          reason: 'backpressure',
          ref: subscription.ref,
        },
        subscription.localId,
      )
      return
    }
    subscription.seq += 1
    const sent = this._send(
      state.connection,
      {
        type: 'session_delta',
        seq: subscription.seq,
        ref: subscription.ref,
        events,
      },
      subscription.localId,
    )
    if (!sent) subscription.seq -= 1
  }

  private _broadcastInboxDelta(
    upserts: readonly MobileSessionSummary[],
    removes: readonly MobileSessionRef[],
  ): void {
    if (upserts.length === 0 && removes.length === 0) return
    for (const state of this._connections) {
      if (!state.inbox) continue
      if (state.inboxSnapshotPending) {
        state.bufferedInbox.push({ upserts, removes })
        continue
      }
      this._send(state.connection, {
        type: 'inbox_delta',
        seq: ++this._inboxSeq,
        upserts,
        removes,
      })
    }
  }

  private async _sendInboxSnapshot(state: HubConnectionState): Promise<void> {
    state.inboxSnapshotPending = true
    state.bufferedInbox = []
    const sessions: MobileSessionSummary[] = []
    try {
      const windows = [...this._windows.values()]
      const lists = await Promise.all(
        windows.map(async (entry) => {
          try {
            // A window registered before its renderer booted cannot answer.
            // Wait briefly; if it is still booting, leave its rows to the
            // deltas its streaming emits once the readiness probe wires it.
            if (
              !(await this._ensureWindowReady(entry, Date.now() + INBOX_WINDOW_READY_TIMEOUT_MS))
            ) {
              return []
            }
            const summaries = await callWithToken(
              (token) => entry.bridge.listSessions(token),
              INBOX_LIST_TIMEOUT_MS,
            )
            return summaries.map((summary) => this._toProtocolSummary(entry, summary))
          } catch (err) {
            this._logger.warn(
              `mobile inbox snapshot window ${entry.windowId} failed: ${String(err)}`,
            )
            return []
          }
        }),
      )
      for (const list of lists) sessions.push(...list)
    } catch (err) {
      this._logger.warn(`mobile inbox snapshot failed: ${String(err)}`)
      state.inboxSnapshotPending = false
      return
    }
    if (!state.inbox) {
      state.inboxSnapshotPending = false
      return
    }
    for (const summary of sessions) {
      this._inboxState.set(sessionKey(summary.ref.windowId, summary.ref.localId), {
        windowId: summary.ref.windowId,
        summary,
      })
    }
    this._send(state.connection, { type: 'inbox_snapshot', seq: ++this._inboxSeq, sessions })
    state.inboxSnapshotPending = false
    const buffered = state.bufferedInbox
    state.bufferedInbox = []
    for (const delta of buffered) {
      this._send(state.connection, {
        type: 'inbox_delta',
        seq: ++this._inboxSeq,
        upserts: delta.upserts,
        removes: delta.removes,
      })
    }
  }

  private _resolveSession(
    ref: MobileSessionRef,
  ): { windowId: number; localId: string } | undefined {
    if (ref.durableId !== undefined) {
      for (const value of this._inboxState.values()) {
        if (value.summary.ref.durableId !== ref.durableId) continue
        return { windowId: value.windowId, localId: value.summary.ref.localId }
      }
    }
    if (!this._windows.has(ref.windowId)) return undefined
    return { windowId: ref.windowId, localId: ref.localId }
  }

  private _findSubscriptionKeyByDurable(
    state: HubConnectionState,
    durableId: string,
  ): string | undefined {
    for (const [key, subscription] of state.sessions) {
      if (subscription.ref.durableId === durableId) return key
    }
    return undefined
  }

  private _toProtocolSummary(
    entry: WindowEntry,
    summary: MobileBridgeSessionSummary,
  ): MobileSessionSummary {
    return {
      ref: {
        windowId: entry.windowId,
        localId: summary.localId,
        ...(summary.durableId !== undefined ? { durableId: summary.durableId } : {}),
      },
      agentId: clampText(summary.agentId, MAX_ID_LENGTH),
      ...(summary.agentName !== undefined
        ? { agentName: clampText(summary.agentName, MAX_TITLE_LENGTH) }
        : {}),
      title: clampText(summary.title, MAX_TITLE_LENGTH),
      status: clampText(summary.status, MAX_STATUS_LENGTH),
      displayStatus: clampText(summary.displayStatus, MAX_STATUS_LENGTH),
      bucket: summary.bucket,
      workspaceName: this._workspaceName(entry),
      ...(summary.cwd !== undefined
        ? { cwd: clampText(summary.cwd, MAX_WORKSPACE_NAME_LENGTH) }
        : {}),
      ...(summary.authority !== undefined
        ? { authority: clampText(summary.authority, MAX_WORKSPACE_NAME_LENGTH) }
        : {}),
      readOnly: summary.readOnly,
      hasPendingPermission: summary.hasPendingPermission,
      hasPendingElicitation: summary.hasPendingElicitation,
      backgroundTaskCount: summary.backgroundTaskCount,
      ...(summary.imageSupported !== undefined ? { imageSupported: summary.imageSupported } : {}),
      ...(summary.forkSupported === true ? { forkSupported: true } : {}),
      ...(summary.rewindSupported === true ? { rewindSupported: true } : {}),
      ...(summary.sideTaskOf !== undefined && summary.sideTaskOf.length > 0
        ? { sideTaskOf: clampText(summary.sideTaskOf, MAX_ID_LENGTH) }
        : {}),
      ...(summary.sideTaskChildCount !== undefined &&
      Number.isInteger(summary.sideTaskChildCount) &&
      summary.sideTaskChildCount > 0
        ? { sideTaskChildCount: summary.sideTaskChildCount }
        : {}),
      ...(summary.delivery !== undefined ? { delivery: summary.delivery } : {}),
      ...(summary.deliveryAvailable === true ? { deliveryAvailable: true } : {}),
      ...(summary.automation !== undefined ? { automation: summary.automation } : {}),
      updatedAt: summary.updatedAt,
    }
  }

  private _toProtocolEvent(
    entry: WindowEntry,
    event: MobileBridgeSessionEvent,
  ): MobileSessionEvent {
    if (event.type === 'summary_changed') {
      return { type: 'summary_changed', summary: this._toProtocolSummary(entry, event.summary) }
    }
    return event
  }

  private _workspaceName(entry: WindowEntry): string {
    try {
      return clampText(entry.workspaceName(), MAX_WORKSPACE_NAME_LENGTH)
    } catch {
      return ''
    }
  }

  private _fitSnapshot(session: MobileSessionSnapshot): MobileSessionSnapshot {
    let frame: SessionSnapshotFrame = { type: 'session_snapshot', seq: session.seq, session }
    if (serializedLength(frame) <= MAX_SERVER_FRAME_BYTES) return session
    const timeline = [...session.timeline]
    while (timeline.length > 0) {
      timeline.shift()
      const candidate: MobileSessionSnapshot = { ...session, timeline, truncated: true }
      frame = { type: 'session_snapshot', seq: candidate.seq, session: candidate }
      if (serializedLength(frame) <= MAX_SERVER_FRAME_BYTES) return candidate
    }
    const truncated: MobileSessionSnapshot = { ...session, timeline: [], truncated: true }
    if (serializedLength(truncated) > MAX_SERVER_FRAME_BYTES) {
      this._logger.warn('mobile session snapshot exceeds the server frame soft limit')
    }
    return truncated
  }

  private _handleAttention(windowId: number, event: MobileBridgeAttentionEvent): void {
    const cached = this._inboxState.get(sessionKey(windowId, event.localId))?.summary
    this._onAttention?.({
      kind: event.attentionKind,
      ref: {
        windowId,
        localId: event.localId,
        ...(event.durableId !== undefined ? { durableId: event.durableId } : {}),
      },
      title: cached?.title ?? event.title,
      ...(cached?.agentName !== undefined || event.agentName !== undefined
        ? { agentName: cached?.agentName ?? event.agentName }
        : {}),
      ...(event.permissionTitle !== undefined ? { permissionTitle: event.permissionTitle } : {}),
      ...(event.alwaysNotify === true ? { alwaysNotify: true } : {}),
    })
  }

  private _hasSubscribers(): boolean {
    for (const state of this._connections) {
      if (state.inbox || state.sessions.size > 0) return true
    }
    return false
  }

  private _updateStreaming(): void {
    const shouldStream = this._hasSubscribers()
    if (shouldStream === this._streaming) return
    this._streaming = shouldStream
    if (!shouldStream) this._inboxState.clear()
    for (const entry of this._windows.values()) this._syncWindow(entry)
  }

  /** Bring one window's bridge subscriptions in line with the two flags. */
  private _syncWindow(entry: WindowEntry): void {
    const active = this._streaming || this._attention
    if (!entry.rendererReady) {
      // Frames sent to a booting renderer are dropped and never replayed, so
      // hold the wiring until a ping proves the channel exists; the probe
      // re-runs this method on success.
      if (active) this._startReadyProbe(entry)
      return
    }
    if (active) {
      // Subscribe only when first needed, not at registerWindow: main registers
      // the window before the renderer has registered its IPC channel.
      entry.subscription ??= entry.bridge.onDidChange((event) =>
        this._handleBridgeEvent(entry.windowId, event),
      )
    } else if (entry.subscription !== undefined) {
      entry.subscription.dispose()
      entry.subscription = undefined
    }

    if (entry.streaming !== this._streaming) {
      entry.streaming = this._streaming
      const call = this._streaming ? entry.bridge.startStreaming() : entry.bridge.stopStreaming()
      void call.catch((err) => {
        this._logger.warn(`mobile bridge streaming toggle failed: ${String(err)}`)
      })
    }

    if (entry.attention !== this._attention) {
      entry.attention = this._attention
      const call = this._attention ? entry.bridge.startAttention() : entry.bridge.stopAttention()
      void call.catch((err) => {
        this._logger.warn(`mobile bridge attention toggle failed: ${String(err)}`)
      })
    }
  }

  private _disposeWindowWatch(entry: WindowEntry): void {
    entry.subscription?.dispose()
    entry.subscription = undefined
    if (entry.streaming) {
      entry.streaming = false
      void entry.bridge.stopStreaming().catch((err) => {
        this._logger.debug(`mobile bridge stop failed: ${String(err)}`)
      })
    }
    if (entry.attention) {
      entry.attention = false
      void entry.bridge.stopAttention().catch((err) => {
        this._logger.debug(`mobile bridge attention stop failed: ${String(err)}`)
      })
    }
  }
}

function serializedLength(frame: unknown): number {
  return JSON.stringify(frame).length
}

/** Retry shape without the draft payload; keeps snapshots and deltas deliverable. */
function stripDraft(frame: ServerFrame): ServerFrame | undefined {
  if (frame.type === 'session_snapshot' && frame.session.draft !== undefined) {
    const { draft: _draft, ...session } = frame.session
    return { ...frame, session }
  }
  if (frame.type === 'session_delta') {
    const events = frame.events.filter((event) => event.type !== 'draft_update')
    if (events.length !== frame.events.length) return { ...frame, events }
  }
  return undefined
}

function failOutcome(error: MobileErrorCode): CommandOutcome {
  return { ok: false, error }
}

function isBridgeNewSessionResult(value: unknown): value is MobileBridgeNewSessionResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const localId = record['localId']
  const durableId = record['durableId']
  return (
    typeof localId === 'string' &&
    localId.length > 0 &&
    (durableId === undefined || (typeof durableId === 'string' && durableId.length > 0))
  )
}

/** Rebuild the side-task rows so a malformed bridge value cannot poison a frame. */
function clampSideTaskSummaries(value: unknown): readonly MobileSideTaskSummary[] {
  if (!Array.isArray(value)) return []
  const rows: MobileSideTaskSummary[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = record['id']
    const title = record['title']
    if (typeof id !== 'string' || id.length === 0) continue
    const lastUsedAt = record['lastUsedAt']
    rows.push({
      id: clampText(id, MAX_ID_LENGTH),
      title: clampText(typeof title === 'string' ? title : '', MAX_TITLE_LENGTH),
      lastUsedAt: typeof lastUsedAt === 'number' && Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
      live: record['live'] === true,
    })
  }
  return rows
}

function permissionKey(windowId: number, localId: string, requestId: string): string {
  return `${windowId}:${localId}:${requestId}`
}

const HOST_PLATFORM = normalizePlatform(process.platform)

/**
 * True when `cwd` is the worktree root or lives under it. Remote authorities
 * carry POSIX paths on the server, so compare byte prefixes; local paths go
 * through the shared platform comparison (Windows casing/separators).
 */
function isPathInside(root: string, cwd: string, authority: string | undefined): boolean {
  if (authority !== undefined && authority.length > 0) {
    if (cwd === root) return true
    return cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
  }
  return relativePathUnder(root, cwd, HOST_PLATFORM) !== null
}

/** Shared ordering rule for duplicate history rows (pinned first, then freshest). */
function preferHistoryRow(
  candidate: MobileSessionHistoryEntry,
  existing: MobileSessionHistoryEntry,
): boolean {
  if (candidate.pinned === true && existing.pinned !== true) return true
  return candidate.pinned === existing.pinned && candidate.lastUsedAt > existing.lastUsedAt
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      await fn(item, index)
    }
  })
  await Promise.all(workers)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mobile command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Bound a bridge call and cancel it on timeout. Cancelling releases the channel
 * client's pending request instead of leaving it until the window closes; a
 * cancel after success is a no-op because the listener is already removed.
 */
function callWithToken<T>(
  call: (token: CancellationToken) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const cts = new CancellationTokenSource()
  return withTimeout(call(cts.token), timeoutMs).finally(() => {
    cts.cancel()
    cts.dispose()
  })
}
