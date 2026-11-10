import type { MobileMessageAttachment } from './attachments.js'
import type { MobileErrorCode } from './errors.js'

export const MOBILE_SESSION_BUCKETS = [
  'input_needed',
  'in_progress',
  'failed',
  'completed',
] as const

export type MobileSessionBucket = (typeof MOBILE_SESSION_BUCKETS)[number]

/** Stable session key: prefer `durableId` once the agent has attached. */
export interface MobileSessionRef {
  windowId: number
  localId: string
  durableId?: string
}

/**
 * Inbox row. `windowId` / `workspaceName` are filled by the main gateway; a
 * renderer bridge summary omits them (see the shared `MobileBridgeSessionSummary`).
 */
export interface MobileSessionSummary {
  ref: MobileSessionRef
  agentId: string
  agentName?: string
  title: string
  /** Raw `AcpSessionStatus` (idle / connecting / running / errored / closed). */
  status: string
  /** `computeSessionDisplayStatus` — the status the PC UI renders. */
  displayStatus: string
  bucket: MobileSessionBucket
  workspaceName: string
  cwd?: string
  authority?: string
  readOnly: boolean
  hasPendingPermission: boolean
  hasPendingElicitation: boolean
  backgroundTaskCount: number
  /** Whether the agent accepts `image` content blocks for prompts. */
  imageSupported?: boolean
  /** Agent advertised `sessionCapabilities.fork`. */
  forkSupported?: boolean
  /** Agent advertised the universe rewind ext-method capability. */
  rewindSupported?: boolean
  /** Durable id of the parent session when this row is a side task. */
  sideTaskOf?: string
  /** Number of direct side-task children (parent rows only). */
  sideTaskChildCount?: number
  /** Epoch milliseconds. */
  updatedAt: number
}

export const MOBILE_MESSAGE_ROLES = ['user', 'agent', 'thought'] as const
export type MobileMessageRole = (typeof MOBILE_MESSAGE_ROLES)[number]

export const MOBILE_TIMELINE_ITEM_KINDS = ['message', 'toolCall', 'notice'] as const
export type MobileTimelineItemKind = (typeof MOBILE_TIMELINE_ITEM_KINDS)[number]

export const MOBILE_NOTICE_KINDS = ['compaction', 'resurrection'] as const
export type MobileNoticeKind = (typeof MOBILE_NOTICE_KINDS)[number]

export const MOBILE_NOTICE_PHASES = ['running', 'success', 'failed'] as const
export type MobileNoticePhase = (typeof MOBILE_NOTICE_PHASES)[number]

export interface MobileToolCallDiffStat {
  path: string
  added: number
  removed: number
}

export interface MobileToolCallLocation {
  path: string
  line?: number
}

export interface MobileTimelineMessageItem {
  kind: 'message'
  id: string
  role: MobileMessageRole
  text: string
  streaming: boolean
  memoryTrimmed?: boolean
  /** Attachments projected from the user message's mobile metadata. */
  attachments?: readonly MobileMessageAttachment[]
  /** True when the message carries a non-text block not represented by `attachments`. */
  hasNonText?: boolean
  /** Agent-side user-turn anchor; only user messages with a client messageId. */
  messageId?: string
  /** Whether fork may target this turn (first user turn is rewind-only). */
  canFork?: boolean
}

export interface MobileTimelineToolCallItem {
  kind: 'toolCall'
  id: string
  title: string
  /** ACP tool kind (read / edit / execute / fetch / other / …). */
  toolKind: string
  status: string
  /** First 1KB of the card body; the full body is fetched with `getToolCallDetail`. */
  preview?: string
  hasDetail: boolean
  diffs?: readonly MobileToolCallDiffStat[]
  locations?: readonly MobileToolCallLocation[]
  memoryTrimmed?: boolean
  /** This call spawned a sub-agent timeline. Kept by the phone's only-message mode. */
  subagent?: boolean
  /** This call asked the user for a decision. Kept by the phone's only-message mode. */
  requiresUserDecision?: boolean
  /** PC epoch ms when the call started; anchors the phone's running stopwatch. */
  startedAt?: number
  /** Frozen PC-computed elapsed ms once the call settled. */
  durationMs?: number
  /** Why the card settled locally (cancelled / orphaned), as the PC recorded it. */
  settleReason?: string
  /** The failed result is a CLI-synthesized denial; show it as an upstream interruption. */
  syntheticDenial?: boolean
}

export interface MobileTimelineNoticeItem {
  kind: 'notice'
  id: string
  noticeKind: MobileNoticeKind
  phase: MobileNoticePhase
  text?: string
}

export type MobileTimelineItem =
  | MobileTimelineMessageItem
  | MobileTimelineToolCallItem
  | MobileTimelineNoticeItem

export const MOBILE_PLAN_ENTRY_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type MobilePlanEntryStatus = (typeof MOBILE_PLAN_ENTRY_STATUSES)[number]

export interface MobilePlanEntry {
  content: string
  status: MobilePlanEntryStatus
  priority?: string
}

export const MOBILE_CONFIG_OPTION_TYPES = ['select', 'boolean'] as const
export type MobileConfigOptionType = (typeof MOBILE_CONFIG_OPTION_TYPES)[number]

/** Read-only display projection of one ACP session config option. */
export interface MobileConfigOption {
  id: string
  name: string
  category?: string
  type: MobileConfigOptionType
  /** Human-readable label of the current value (never the raw value for selects). */
  currentValue: string
  /**
   * False when every value of a select would trip the high-risk policy (the
   * phone cannot change the option at all). Boolean options are always true.
   */
  allowedOnMobile: boolean
  /** Select values, with the label the phone renders and whether it may pick it. */
  options?: readonly MobileConfigOptionValue[]
}

export interface MobileConfigOptionValue {
  value: string
  label: string
  allowedOnMobile: boolean
}

/** Session usage, pruned to what a phone header needs. */
export interface MobileUsage {
  used: number
  size: number
  cost?: { amount: number; currency: string }
  costEstimated?: boolean
}

export interface MobilePermissionOption {
  optionId: string
  name: string
  kind?: string
  /** False for `allow_always` and other durable / bypass grants (§7). */
  allowedOnMobile: boolean
}

export interface MobileAutoResolve {
  optionId: string
  /** Epoch milliseconds while the countdown runs; absent when paused/cancelled. */
  deadlineAt?: number
  paused: boolean
}

export interface MobilePendingPermission {
  requestId: string
  toolCallId: string
  title: string
  kind?: string
  options: readonly MobilePermissionOption[]
  autoResolve?: MobileAutoResolve
}

export const MOBILE_ELICITATION_FIELD_KINDS = [
  'string',
  'number',
  'boolean',
  'enum',
  'enum-multi',
] as const
export type MobileElicitationFieldKind = (typeof MOBILE_ELICITATION_FIELD_KINDS)[number]

export interface MobileElicitationEnumOption {
  value: string
  title: string
  description?: string
}

/**
 * Flat, serializable subset of an ACP elicitation form. Mirrors
 * `acpElicitationForm.ts`'s supported property kinds so the phone can render the
 * same inputs without shipping the editor's schema normalizer.
 */
export interface MobileElicitationField {
  name: string
  title?: string
  description?: string
  required: boolean
  kind: MobileElicitationFieldKind
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  integer?: boolean
  minimum?: number
  maximum?: number
  options?: readonly MobileElicitationEnumOption[]
  minItems?: number
  maxItems?: number
  default?: string | number | boolean | readonly string[]
}

/** Display projection of a pending elicitation. */
export interface MobilePendingElicitation {
  requestId: string
  mode: string
  message: string
  title?: string
  toolCallId?: string
  /** Form mode only. */
  fields?: readonly MobileElicitationField[]
  /** URL mode only. */
  url?: string
}

/** Full read-only session snapshot. `seq` is the session scope sequence. */
export interface MobileSessionSnapshot {
  seq: number
  summary: MobileSessionSummary
  timeline: readonly MobileTimelineItem[]
  plan: readonly MobilePlanEntry[]
  configOptions: readonly MobileConfigOption[]
  usage?: MobileUsage
  pendingPermission?: MobilePendingPermission
  pendingElicitation?: MobilePendingElicitation
  isReplayingHistory: boolean
  /** True when the gateway dropped the earliest timeline items to fit one frame. */
  truncated?: boolean
}

export interface MobileToolCallDiffDetail {
  path: string
  oldText: string
  newText: string
}

export interface MobileToolCallDetail {
  id: string
  title: string
  kind: string
  status: string
  /** Full body, bounded by the editor's tool-call content caps. */
  text: string
  diffs: readonly MobileToolCallDiffDetail[]
  locations?: readonly MobileToolCallLocation[]
  memoryTrimmed?: boolean
}

export const MOBILE_ATTENTION_KINDS = ['permission', 'question', 'completed', 'errored'] as const
export type MobileAttentionKind = (typeof MOBILE_ATTENTION_KINDS)[number]

/** Browser PushSubscription, flattened for the wire. */
export interface MobilePushSubscription {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

/** Per-device notification preferences. Kinds absent means "all four". */
export interface MobileNotificationPrefs {
  enabled: boolean
  kinds?: readonly MobileAttentionKind[]
  /** Also notify while a PC window is focused. */
  alwaysNotify: boolean
}

// Client → server

export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
  /** Sent in this first frame rather than a URL query to keep it out of logs. */
  token: string
  clientVersion: string
  capabilities: string[]
}

export interface PingFrame {
  type: 'ping'
  t: number
}

export interface SubscribeInboxFrame {
  type: 'subscribe_inbox'
  /** Optimization only: reconnects always start from a snapshot. */
  afterSeq?: number
}

export interface UnsubscribeInboxFrame {
  type: 'unsubscribe_inbox'
}

export interface SubscribeSessionFrame {
  type: 'subscribe_session'
  ref: MobileSessionRef
  /** Optimization only: M2 always answers with a full snapshot. */
  afterSeq?: number
}

export interface UnsubscribeSessionFrame {
  type: 'unsubscribe_session'
  ref: MobileSessionRef
}

/**
 * Commands travel as one frame shape so a newer client can ask for a kind this
 * server does not implement and receive `not_supported` rather than a parse error.
 */
export const MOBILE_COMMAND_KINDS = [
  'getToolCallDetail',
  'sendPrompt',
  'cancelTurn',
  'resolvePermission',
  'cancelPermission',
  'resolveElicitation',
  'setConfigOption',
  'pauseAutoResolve',
  'resumeAutoResolve',
  'newSession',
  'renameSession',
  'closeSession',
  'deleteSession',
  'forkSession',
  'previewRewind',
  'rewindSession',
  'createSideTask',
  'listSideTasks',
  'openSideTask',
  'deleteSideTask',
  'listWorkspaces',
  'listAgents',
  'listSessionHistory',
  'openSession',
] as const
export type MobileCommandKind = (typeof MOBILE_COMMAND_KINDS)[number]

export interface GetToolCallDetailPayload {
  ref: MobileSessionRef
  toolCallId: string
}

export interface SendPromptPayload {
  ref: MobileSessionRef
  /** Capped by MAX_PROMPT_LENGTH; may be empty when attachments are present. */
  text: string
  /** Attachment upload ids; the gateway resolves them for the authenticated device. */
  attachmentIds?: readonly string[]
}

export interface CancelTurnPayload {
  ref: MobileSessionRef
}

export interface ResolvePermissionPayload {
  ref: MobileSessionRef
  requestId: string
  optionId: string
  feedback?: string
}

export interface CancelPermissionPayload {
  ref: MobileSessionRef
  requestId: string
}

export const MOBILE_ELICITATION_ACTIONS = ['accept', 'decline', 'cancel'] as const
export type MobileElicitationAction = (typeof MOBILE_ELICITATION_ACTIONS)[number]

export type MobileElicitationContentValue = string | number | boolean | string[]

export interface ResolveElicitationPayload {
  ref: MobileSessionRef
  requestId: string
  action: MobileElicitationAction
  content?: Record<string, MobileElicitationContentValue>
}

export interface SetConfigOptionPayload {
  ref: MobileSessionRef
  configId: string
  value: string | boolean
}

export interface AutoResolveControlPayload {
  ref: MobileSessionRef
  requestId: string
}

export interface NewSessionWorkspace {
  /** Workspace folder as a URI string (`file:///…` / `remote-ssh://…`). */
  folder: string
  authority?: string
}

export interface NewSessionPayload {
  agentId: string
  workspace: NewSessionWorkspace
  initialPrompt?: string
}

export interface RenameSessionPayload {
  ref: MobileSessionRef
  title: string
}

export interface DeleteSessionPayload {
  ref: MobileSessionRef
}

export interface ForkSessionPayload {
  ref: MobileSessionRef
  /** User-turn anchor; omit to fork from the conversation tip. */
  messageId?: string
}

export interface PreviewRewindPayload {
  ref: MobileSessionRef
  messageId: string
}

export interface RewindSessionPayload {
  ref: MobileSessionRef
  messageId: string
  /** false keeps the agent-edited files; omitted/true rolls them back. */
  rewindFiles?: boolean
}

export interface CreateSideTaskPayload {
  ref: MobileSessionRef
  /** Whole-message quote; omitted for a blank side task. */
  quote?: string
}

export interface ListSideTasksPayload {
  ref: MobileSessionRef
}

export interface OpenSideTaskPayload {
  ref: MobileSessionRef
  sideTaskId: string
}

export interface DeleteSideTaskPayload {
  ref: MobileSessionRef
  sideTaskId: string
}

/**
 * One history row in the phone's session catalog. Live rows are merged on the
 * phone from the inbox mirror; this shape describes a session the PC window no
 * longer keeps resident but can `session/load` again.
 */
export interface MobileSessionHistoryEntry {
  /** Agent-issued durable id (`sessionIdOnAgent`). */
  durableId: string
  /** Open PC window whose renderer owns this history bucket. */
  windowId: number
  agentId: string
  agentName?: string
  title: string
  /** First content-bearing user prompt, capped for search / a secondary line. */
  firstPrompt?: string
  /** Main-owned display name of the owning window's workspace. */
  workspaceName: string
  cwd?: string
  authority?: string
  /** Epoch milliseconds. */
  createdAt: number
  /** Epoch milliseconds. */
  lastUsedAt: number
  pinned?: boolean
}

export interface OpenSessionPayload {
  /** Durable id from `MobileSessionHistoryEntry`. */
  durableId: string
  /**
   * Owning window from the catalog. A routing hint only: the gateway verifies
   * the window's history still contains the session before resuming.
   */
  windowId?: number
}

export interface CommandFrame {
  type: 'command'
  requestId: string
  kind: string
  payload: unknown
  /**
   * Optional retry key for mutating commands. The gateway returns the first
   * result for five minutes so a client that lost the response cannot send a
   * prompt or create a session twice.
   */
  idempotencyKey?: string
}

export interface PushSubscribeFrame {
  type: 'push_subscribe'
  subscription: MobilePushSubscription
  /** Absent keeps the previously stored preferences. */
  prefs?: MobileNotificationPrefs
}

export interface PushUnsubscribeFrame {
  type: 'push_unsubscribe'
}

export interface SetNotificationPrefsFrame {
  type: 'set_notification_prefs'
  enabled: boolean
  /** Absent means "all four kinds". */
  kinds?: readonly MobileAttentionKind[]
  alwaysNotify?: boolean
}

/** Foreground declaration; Web Push is only used when no visible socket exists. */
export interface ClientStateFrame {
  type: 'client_state'
  visible: boolean
}

/** Result of `newSession`. */
export interface MobileNewSessionResult {
  ref: MobileSessionRef
}

/** Result of `forkSession` / `createSideTask` / `openSideTask`. */
export type MobileSessionRefResult = MobileNewSessionResult

export interface MobileRewindPreview {
  canRewind: boolean
  error?: string
  /** Number of files the agent would touch; paths stay on the PC. */
  filesChanged: number
  insertions?: number
  deletions?: number
}

export interface MobileRewindResult {
  canRewind: boolean
  error?: string
  /** Original user text, returned only for the phone-side composer backfill. */
  text?: string
}

export interface MobileSideTaskSummary {
  /** Durable session id of the side task. */
  id: string
  title: string
  /** Epoch milliseconds. */
  lastUsedAt: number
  /** Resident in the owning window's session registry. */
  live: boolean
}

export interface MobileWorkspaceCandidate {
  folder: string
  name: string
  authority?: string
  isOpen: boolean
  /** Present for open workspaces; the phone joins inbox rows by window id. */
  windowId?: number
  /** true/false when known; omitted when unknown (non-repo / git missing / timeout). */
  gitDirty?: boolean
}

export interface MobileAgentCandidate {
  id: string
  name: string
  isDefault: boolean
}

export type ClientFrame =
  | HelloFrame
  | PingFrame
  | SubscribeInboxFrame
  | UnsubscribeInboxFrame
  | SubscribeSessionFrame
  | UnsubscribeSessionFrame
  | CommandFrame
  | PushSubscribeFrame
  | PushUnsubscribeFrame
  | SetNotificationPrefsFrame
  | ClientStateFrame
export type ClientFrameType = ClientFrame['type']

// Server → client

export interface HelloOkFrame {
  type: 'hello_ok'
  protocolVersion: number
  serverVersion: string
  deviceId: string
  /** Whether the PC has marked this device trusted for high-risk operations. */
  trusted: boolean
  serverTime: number
  capabilities: string[]
  /** VAPID public key (`base64url`), present when Web Push is configured. */
  vapidPublicKey?: string
}

export interface PongFrame {
  type: 'pong'
  t: number
}

export interface InboxSnapshotFrame {
  type: 'inbox_snapshot'
  seq: number
  sessions: readonly MobileSessionSummary[]
}

export interface InboxDeltaFrame {
  type: 'inbox_delta'
  seq: number
  upserts: readonly MobileSessionSummary[]
  removes: readonly MobileSessionRef[]
}

export interface SessionSnapshotFrame {
  type: 'session_snapshot'
  seq: number
  session: MobileSessionSnapshot
}

export interface MobileMessageUpsertEvent {
  type: 'message_upsert'
  id: string
  role: MobileMessageRole
  /** Only the newly appended suffix (streaming fast path). */
  textAppend?: string
  /** Full replacement (rewind / replay / prefix mismatch). */
  textReplace?: string
  streaming: boolean
  memoryTrimmed?: boolean
  /** Full replacement; omitted means unchanged, `[]` clears. */
  attachments?: readonly MobileMessageAttachment[]
  hasNonText?: boolean
  messageId?: string
  canFork?: boolean
}

export interface MobileToolCallUpsertEvent {
  type: 'tool_call_upsert'
  item: MobileTimelineToolCallItem
}

export interface MobileTimelineItemAddedEvent {
  type: 'timeline_item_added'
  item: MobileTimelineItem
}

export interface MobileTimelineItemRemovedEvent {
  type: 'timeline_item_removed'
  id: string
}

export interface MobilePlanSnapshotEvent {
  type: 'plan_snapshot'
  plan: readonly MobilePlanEntry[]
}

export interface MobileConfigOptionsSnapshotEvent {
  type: 'config_options_snapshot'
  options: readonly MobileConfigOption[]
}

export interface MobileSummaryChangedEvent {
  type: 'summary_changed'
  summary: MobileSessionSummary
}

export interface MobilePermissionUpsertEvent {
  type: 'permission_upsert'
  permission: MobilePendingPermission
}

export const MOBILE_PERMISSION_SETTLE_SOURCES = ['pc', 'mobile', 'auto'] as const
export type MobilePermissionSettleSource = (typeof MOBILE_PERMISSION_SETTLE_SOURCES)[number]

export const MOBILE_PERMISSION_SETTLE_REASONS = [
  'selected',
  'cancelled',
  'superseded',
  'auto',
] as const
export type MobilePermissionSettleReason = (typeof MOBILE_PERMISSION_SETTLE_REASONS)[number]

export interface MobilePermissionClearedEvent {
  type: 'permission_cleared'
  requestId: string
  reason: MobilePermissionSettleReason
  source: MobilePermissionSettleSource
}

export interface MobileElicitationUpsertEvent {
  type: 'elicitation_upsert'
  elicitation: MobilePendingElicitation
}

export interface MobileElicitationClearedEvent {
  type: 'elicitation_cleared'
}

export type MobileSessionEvent =
  | MobileMessageUpsertEvent
  | MobileToolCallUpsertEvent
  | MobileTimelineItemAddedEvent
  | MobileTimelineItemRemovedEvent
  | MobilePlanSnapshotEvent
  | MobileConfigOptionsSnapshotEvent
  | MobileSummaryChangedEvent
  | MobilePermissionUpsertEvent
  | MobilePermissionClearedEvent
  | MobileElicitationUpsertEvent
  | MobileElicitationClearedEvent

export interface SessionDeltaFrame {
  type: 'session_delta'
  seq: number
  ref: MobileSessionRef
  events: readonly MobileSessionEvent[]
}

export interface SessionRemovedFrame {
  type: 'session_removed'
  ref: MobileSessionRef
}

export interface CommandResultFrame {
  type: 'command_result'
  requestId: string
  ok: boolean
  result?: unknown
  error?: MobileErrorCode
}

export const MOBILE_RESYNC_SCOPES = ['inbox', 'session'] as const
export type MobileResyncScope = (typeof MOBILE_RESYNC_SCOPES)[number]

export interface ResyncRequiredFrame {
  type: 'resync_required'
  scope: MobileResyncScope
  reason: string
  /** Present for `scope: 'session'`. */
  ref?: MobileSessionRef
}

export interface ServerErrorFrame {
  type: 'server_error'
  code: MobileErrorCode
  message: string
  retryable: boolean
}

export interface DeviceRevokedFrame {
  type: 'device_revoked'
}

/**
 * PC changed this device's high-risk permission. The phone updates its settings
 * display; the gateway separately sends `resync_required` so open sessions get
 * the new `allowedOnMobile` projection.
 */
export interface DeviceTrustChangedFrame {
  type: 'device_trust_changed'
  trusted: boolean
}

/**
 * Foreground in-app notification. The body is built by the gateway and never
 * carries prompt text or tool output; Web Push uses the same fields.
 */
export interface NotificationFrame {
  type: 'notification'
  id: string
  kind: MobileAttentionKind
  ref: MobileSessionRef
  title: string
  body: string
  /** Epoch milliseconds. */
  at: number
}

export type ServerFrame =
  | HelloOkFrame
  | PongFrame
  | InboxSnapshotFrame
  | InboxDeltaFrame
  | SessionSnapshotFrame
  | SessionDeltaFrame
  | SessionRemovedFrame
  | CommandResultFrame
  | NotificationFrame
  | ResyncRequiredFrame
  | ServerErrorFrame
  | DeviceRevokedFrame
  | DeviceTrustChangedFrame

export type ServerFrameType = ServerFrame['type']
