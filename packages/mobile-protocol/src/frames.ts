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
  /** True when the message carries a non-text block (image / resource / audio). */
  hasNonText?: boolean
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
}

export interface MobilePendingPermission {
  /** Reserved for M3; absent until ACP exposes a request id. */
  requestId?: string
  toolCallId: string
  title: string
  kind?: string
  options: readonly MobilePermissionOption[]
  autoResolve?: { optionId: string; deadlineAt?: number }
}

/** Display projection of a pending elicitation (M2 is read-only). */
export interface MobilePendingElicitation {
  /** Reserved for M3; absent until ACP exposes a request id. */
  requestId?: string
  mode: string
  message: string
  title?: string
  toolCallId?: string
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
 * M2 only implements `getToolCallDetail`.
 */
export const MOBILE_COMMAND_KINDS = ['getToolCallDetail'] as const
export type MobileCommandKind = (typeof MOBILE_COMMAND_KINDS)[number]

export interface GetToolCallDetailPayload {
  ref: MobileSessionRef
  toolCallId: string
}

export interface CommandFrame {
  type: 'command'
  requestId: string
  kind: string
  payload: unknown
}

export type ClientFrame =
  | HelloFrame
  | PingFrame
  | SubscribeInboxFrame
  | UnsubscribeInboxFrame
  | SubscribeSessionFrame
  | UnsubscribeSessionFrame
  | CommandFrame
export type ClientFrameType = ClientFrame['type']

// Server → client

export interface HelloOkFrame {
  type: 'hello_ok'
  protocolVersion: number
  serverVersion: string
  deviceId: string
  serverTime: number
  capabilities: string[]
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
  hasNonText?: boolean
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

export interface MobilePermissionClearedEvent {
  type: 'permission_cleared'
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

export type ServerFrame =
  | HelloOkFrame
  | PongFrame
  | InboxSnapshotFrame
  | InboxDeltaFrame
  | SessionSnapshotFrame
  | SessionDeltaFrame
  | SessionRemovedFrame
  | CommandResultFrame
  | ResyncRequiredFrame
  | ServerErrorFrame
  | DeviceRevokedFrame

export type ServerFrameType = ServerFrame['type']
