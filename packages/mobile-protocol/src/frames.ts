import type { MobileMessageAttachment } from './attachments.js'
import type { DraftUpdateFrame, MobileDraftState } from './draft.js'
import type { MobileErrorCode } from './errors.js'
import type { MobileMessageImage } from './images.js'

export const MOBILE_SESSION_BUCKETS = [
  'input_needed',
  'in_progress',
  'failed',
  'completed',
] as const

export type MobileSessionBucket = (typeof MOBILE_SESSION_BUCKETS)[number]

/** Verdicts an automated trigger run can produce (mirrors the desktop contract). */
export const MOBILE_TRIGGER_VERDICTS = ['auto-approve', 'escalate', 'reject', 'info'] as const
export type MobileTriggerVerdict = (typeof MOBILE_TRIGGER_VERDICTS)[number]

/** Terminal outcomes of an automated trigger run. */
export const MOBILE_TRIGGER_RUN_OUTCOMES = [
  'completed',
  'budget-exceeded',
  'timeout',
  'approval-timeout',
  'cancelled',
  'failed',
] as const
export type MobileTriggerRunOutcome = (typeof MOBILE_TRIGGER_RUN_OUTCOMES)[number]

/** Inbox-row provenance of a session started by an agent trigger. */
export interface MobileTriggerAutomationSummary {
  triggerName: string
  verdict?: MobileTriggerVerdict
  summary?: string
  outcome?: MobileTriggerRunOutcome
}

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
  /** Latest agent delivery for this session's worktree, when one exists. */
  delivery?: MobileDeliverySummary
  /** Idle, writable session whose worktree is dirty or holds commits main lacks. */
  deliveryAvailable?: boolean
  /** Present when an agent trigger started this session. */
  automation?: MobileTriggerAutomationSummary
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
  /** ACP image blocks not represented by `attachments`; bytes are fetched over HTTP. */
  images?: readonly MobileMessageImage[]
  /** True when the message carries a non-text block not represented by attachments/images. */
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
  /** Select values, with the label the phone renders. */
  options?: readonly MobileConfigOptionValue[]
}

export interface MobileConfigOptionValue {
  value: string
  label: string
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

/** One slash command advertised by the agent. Display adds the leading `/`. */
export interface MobileAvailableCommand {
  /** Canonical name with leading slashes stripped; never contains whitespace. */
  name: string
  description: string
  /** ACP `input.hint`; rendered as `<hint>` after the command name. */
  inputHint?: string
}

/** Full read-only session snapshot. `seq` is the session scope sequence. */
export interface MobileSessionSnapshot {
  seq: number
  summary: MobileSessionSummary
  timeline: readonly MobileTimelineItem[]
  plan: readonly MobilePlanEntry[]
  configOptions: readonly MobileConfigOption[]
  availableCommands: readonly MobileAvailableCommand[]
  usage?: MobileUsage
  pendingPermission?: MobilePendingPermission
  pendingElicitation?: MobilePendingElicitation
  isReplayingHistory: boolean
  /** True when the gateway dropped the earliest timeline items to fit one frame. */
  truncated?: boolean
  /** Current unsent prompt draft; omitted when both ends are empty. */
  draft?: MobileDraftState
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
  'searchPromptRefs',
  'resolvePromptRef',
  'sendPrompt',
  'cancelTurn',
  'resolvePermission',
  'cancelPermission',
  'resolveElicitation',
  'setConfigOption',
  'getSessionSettings',
  'setSubagentModel',
  'restartAgentProcess',
  'setSessionMcpServers',
  'pauseAutoResolve',
  'resumeAutoResolve',
  'newSession',
  'renameSession',
  'closeSession',
  'deleteSession',
  'deleteHistorySession',
  'forkSession',
  'previewRewind',
  'rewindSession',
  'createSideTask',
  'listSideTasks',
  'openSideTask',
  'deleteSideTask',
  'listWorkspaces',
  'listDirectory',
  'getNewSessionOptions',
  'listAgents',
  'listSessionHistory',
  'openSession',
  'previewDelivery',
  'startDelivery',
  'getDelivery',
  'confirmDeliveryPush',
  'retryDelivery',
  'undoDelivery',
  'openDeliveryMainWorktree',
  'previewPushBranch',
  'pushBranch',
] as const
export type MobileCommandKind = (typeof MOBILE_COMMAND_KINDS)[number]

export interface GetToolCallDetailPayload {
  ref: MobileSessionRef
  toolCallId: string
}

export const MOBILE_PROMPT_REF_KINDS = [
  'file',
  'symbol',
  'scmChange',
  'openEditor',
  'docs',
  'commit',
  'chatContext',
] as const
export type MobilePromptRefKind = (typeof MOBILE_PROMPT_REF_KINDS)[number]

export const MOBILE_PROMPT_REF_TRIGGERS = ['@', '#'] as const
export type MobilePromptRefTrigger = (typeof MOBILE_PROMPT_REF_TRIGGERS)[number]

/** The trigger char a ref kind is authored with; file mentions use `@`. */
export function promptRefPrefix(kind: MobilePromptRefKind): MobilePromptRefTrigger {
  return kind === 'file' ? '@' : '#'
}

/** One `@` / `#` completion row. `label` is the text after the trigger. */
export interface MobilePromptRefSuggestion {
  kind: MobilePromptRefKind
  /** For `file` this is the workspace-relative path; otherwise the pill label. */
  label: string
  /** Absolute resource URI produced by the PC provider. */
  uri: string
  /** Display-only secondary line. */
  description?: string
  /** `symbol`: 1-based location. */
  line?: number
  column?: number
  symbolKind?: number
  /** `scmChange`: single status letter. */
  scmStatus?: string
  /** `docs`: native fs path of the locale directory. */
  dirPath?: string
  /** `commit`: full SHA of the picked commit (final item / send ref only). */
  commitHash?: string
  /** `chatContext`: extension provider handle (search entry only). */
  chatContextHandle?: number
  /**
   * Agent-facing body: `commit` = commit subject, `chatContext` = the text the
   * extension provider returned. Display-only `description` never reaches the agent.
   */
  text?: string
}

/** A suggestion placed at a character range in the prompt text. */
export interface MobilePromptRef extends MobilePromptRefSuggestion {
  /** Offset of the leading `@`/`#` (inclusive). */
  start: number
  /** One past the last label character (exclusive). */
  end: number
}

export interface SearchPromptRefsPayload {
  ref: MobileSessionRef
  trigger: MobilePromptRefTrigger
  /** Text after the trigger up to the first whitespace; may be empty. */
  query: string
  limit?: number
}

export interface MobilePromptRefSuggestionsResult {
  entries: readonly MobilePromptRefSuggestion[]
}

/** Kinds whose first row is only an entry point for a second selection step. */
export const MOBILE_PROMPT_REF_RESOLVE_KINDS = ['commit', 'chatContext'] as const
export type MobilePromptRefResolveKind = (typeof MOBILE_PROMPT_REF_RESOLVE_KINDS)[number]

/**
 * Second step of a `#` entry: `commit` lists history candidates; `chatContext`
 * asks the extension provider to run its own picker on the PC.
 */
export interface ResolvePromptRefRequest {
  kind: MobilePromptRefResolveKind
  /** Text after `#` when the entry was accepted; forwarded to extension providers. */
  query: string
  /** `commit`: max history entries (default 50). Not accepted for chatContext. */
  limit?: number
  /** `chatContext`: provider handle from the search entry. */
  handle?: number
  /** `chatContext`: entry label; guards against a reused handle after a host restart. */
  label?: string
}

export interface ResolvePromptRefPayload extends ResolvePromptRefRequest {
  ref: MobileSessionRef
}

/** `chatContext` without `entry` means the user cancelled or the provider is gone. */
export type ResolvePromptRefResult =
  | { kind: 'commit'; entries: readonly MobilePromptRefSuggestion[] }
  | { kind: 'chatContext'; entry?: MobilePromptRefSuggestion }

export interface SendPromptPayload {
  ref: MobileSessionRef
  /** Capped by MAX_PROMPT_LENGTH; may be empty when attachments are present. */
  text: string
  /** Attachment upload ids; the gateway resolves them for the authenticated device. */
  attachmentIds?: readonly string[]
  /** Draft image ids already materialized in the PC draft (PC paste or another phone). */
  draftImageIds?: readonly string[]
  /** Draft file ids already materialized in the PC draft (another phone's upload). */
  draftFileIds?: readonly string[]
  /** Structured `@` / `#` references whose ranges match tokens inside `text`. */
  refs?: readonly MobilePromptRef[]
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

/** On-demand session settings; the subagent value is an async file read, not a stream event. */
export interface GetSessionSettingsPayload {
  ref: MobileSessionRef
}

export const MAX_SUBAGENT_MODEL_CANDIDATES = 64
export const MAX_MCP_SERVERS = 100
export const MOBILE_MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const
export type MobileMcpTransport = (typeof MOBILE_MCP_TRANSPORTS)[number]

export interface SetSubagentModelPayload {
  ref: MobileSessionRef
  /** null = follow the session model (clears the model + force env pair). */
  model: string | null
}

export interface RestartAgentProcessPayload {
  ref: MobileSessionRef
}

export interface SetSessionMcpServersPayload {
  ref: MobileSessionRef
  /** null = follow the defaults (every pool entry that is not default-disabled). */
  servers: readonly string[] | null
}

export interface MobileSubagentModelSettings {
  /** True only for claude-code sessions. */
  supported: boolean
  /** Effective `env.CLAUDE_CODE_SUBAGENT_MODEL` on the session's host; null = inherit. */
  current: string | null
  /** The session's model catalogue plus the current value, deduped. */
  candidates: readonly string[]
}

export interface MobileMcpServerEntry {
  name: string
  transport: MobileMcpTransport
  /** Desktop `McpServerDefinition.disabled`: off by default, usable when pinned. */
  defaultDisabled: boolean
}

export interface MobileMcpServerLiveStatus {
  name: string
  /** Raw agent status string (`connected` / `failed` / `needs-auth` / `pending` …). */
  status: string
  transport?: MobileMcpTransport
}

export interface MobileMcpSessionSettings {
  /** Union pool narrowed to this session's agent. */
  pool: readonly MobileMcpServerEntry[]
  /** Session-level whitelist; null = follow the defaults. */
  selection: readonly string[] | null
  /** Names that would run now, in pool order. */
  enabled: readonly string[]
  /** Connection state reported by the agent; servers it never reported are absent. */
  live: readonly MobileMcpServerLiveStatus[]
}

export interface MobileSessionSettings {
  /** False for read-only sessions (side tasks); the phone hides every writer then. */
  canEdit: boolean
  subagentModel: MobileSubagentModelSettings
  mcp: MobileMcpSessionSettings
}

export interface AutoResolveControlPayload {
  ref: MobileSessionRef
  requestId: string
}

export interface NewSessionWorkspace {
  /** Workspace folder as a URI string (`file:///…` / `remote-ssh://…`). */
  folder: string
  authority?: string
  /** Workspace-relative session directory (`/`-separated); omitted = root. */
  relativePath?: string
}

export interface NewSessionPayload {
  agentId: string
  workspace: NewSessionWorkspace
  initialPrompt?: string
}

/** Read the remembered session directory and configured project roots for one workspace. */
export interface GetNewSessionOptionsPayload {
  /** Workspace root URI; must be an open or recent workspace on the PC. */
  folder: string
  authority?: string
}

/**
 * Cap for configured project roots returned by `getNewSessionOptions`. Keeps
 * the frame well below the gateway's wire limit even with pathological config.
 */
export const MAX_NEW_SESSION_PROJECT_ROOTS = 50

export interface MobileNewSessionOptions {
  /**
   * Workspace-relative directory of the last created session. Omitted when
   * unknown, outside the workspace, deleted, or equal to the workspace root.
   */
  lastRelativePath?: string
  /**
   * Configured project roots inside this workspace, in settings order.
   * Canonical `/`-separated workspace-relative paths.
   */
  projectRoots: readonly string[]
}

/** List the directories under a workspace-relative path (read-only). */
export interface ListDirectoryPayload {
  /** Workspace root URI; must be an open or recent workspace on the PC. */
  folder: string
  authority?: string
  /** Workspace-relative directory (`/`-separated); omitted = workspace root. */
  relativePath?: string
}

export interface MobileDirectoryEntry {
  name: string
  /** Canonical workspace-relative path of this directory. */
  relativePath: string
}

export interface MobileDirectoryListing {
  /** Canonical workspace-relative path that was listed (`''` = root). */
  relativePath: string
  /** Parent directory; omitted at the workspace root. `''` means the root. */
  parentRelativePath?: string
  entries: readonly MobileDirectoryEntry[]
  /** Set when entries were trimmed to the gateway's frame budget. */
  truncated?: boolean
}

export interface RenameSessionPayload {
  ref: MobileSessionRef
  title: string
}

export interface DeleteSessionPayload {
  ref: MobileSessionRef
}

/** Delete one catalog row that has no live ref (history rows carry only a durable id). */
export interface DeleteHistorySessionPayload {
  durableId: string
  /** Routing hint: the open PC window the phone listed the row from. */
  windowId?: number
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
  /**
   * Open PC window whose renderer owns this history bucket. Present for live
   * windows only; rows read from a closed workspace's storage omit it and
   * point at `folder` instead.
   */
  windowId?: number
  agentId: string
  agentName?: string
  title: string
  /** First content-bearing user prompt, capped for search / a secondary line. */
  firstPrompt?: string
  /** Main-owned display name of the owning workspace. */
  workspaceName: string
  /**
   * Workspace URI of a closed-workspace history row. Opening it lets the PC
   * open the workspace first, then resume the session.
   */
  folder?: string
  cwd?: string
  /** Remote authority of the workspace / session, when not local. */
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
  /**
   * Workspace URI for rows whose workspace is closed. When no live window owns
   * the row, the gateway opens this workspace (bringing it to the foreground)
   * and resumes the session there.
   */
  folder?: string
  /** Remote authority of `folder`; omitted for local workspaces. */
  authority?: string
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

// ---- Agent delivery ----------------------------------------------------------

export const MOBILE_DELIVERY_PHASES = [
  'preflighting',
  'committing',
  'cherry_picking',
  'resolving_conflict',
  'awaiting_push',
  'pushing',
  'syncing',
  'synced',
  'partial',
  'failed',
  'undoing',
  'undone',
] as const
export type MobileDeliveryPhase = (typeof MOBILE_DELIVERY_PHASES)[number]

export const MOBILE_DELIVERY_WORKTREE_STATUSES = [
  'synced',
  'up_to_date',
  'skipped_dirty',
  'skipped_in_progress',
  'skipped_diverged',
  'skipped_source_changed',
  'failed',
] as const
export type MobileDeliveryWorktreeStatus = (typeof MOBILE_DELIVERY_WORKTREE_STATUSES)[number]

export interface MobileDeliveryCommit {
  sha: string
  shortSha: string
  subject: string
  author: string
  authoredAt: string
}

export interface MobileDeliveryError {
  /** Git-extension error code (main_dirty, conflict, …) or a renderer code. */
  code: string
  message: string
  detail?: string
}

export interface MobileDeliverySyncSummary {
  synced: number
  upToDate: number
  skipped: number
  failed: number
}

export interface MobileDeliveryWorktreeResult {
  /** Worktree directory name; absolute paths never reach the phone. */
  name: string
  branch?: string
  status: MobileDeliveryWorktreeStatus
  error?: string
}

export interface MobileDeliverySummary {
  deliveryId: string
  phase: MobileDeliveryPhase
  commitCount: number
  dirtySource: boolean
  mainBranch: string
  /** Epoch milliseconds. */
  updatedAt: number
  error?: MobileDeliveryError
  canConfirmPush: boolean
  canRetry: boolean
  canUndo: boolean
  sync: MobileDeliverySyncSummary
}

export interface MobileDeliveryUndoResult {
  /** Epoch milliseconds. */
  at: number
  revertedShas: readonly string[]
  mainHead: string
}

/** Detail for the phone's delivery sheet. Worktree names only, never paths. */
export interface MobileDeliveryDetail {
  summary: MobileDeliverySummary
  source: {
    worktreeName: string
    branch?: string
    head: string
    dirty: boolean
  }
  target: {
    mainWorktreeName: string
    mainBranch: string
    remote: string
    remoteBranch: string
    upstreamRef: string
    baseSha: string
    mainHead: string
  }
  commits: readonly MobileDeliveryCommit[]
  generatedMessage?: string
  conflictFiles: readonly string[]
  conflictedCommit?: MobileDeliveryCommit
  pushedSha?: string
  remoteRef?: string
  syncResults: readonly MobileDeliveryWorktreeResult[]
  undo?: MobileDeliveryUndoResult
}

/** Heads pinned by the preview; `startDelivery` echoes them back for re-check. */
export interface MobileDeliveryExpectation {
  mainHead: string
  mainBranch: string
  targetBranch: string
  remote: string
  remoteBranch: string
  upstreamRef: string
  upstreamHead: string
  sourceHead: string
  baseSha: string
  commits: readonly string[]
}

export interface MobileDeliveryPreview {
  source: {
    worktreeName: string
    branch?: string
    head: string
    dirty: boolean
    changedFileCount: number
    untrackedCount: number
    pendingOperation?: string
    isMainWorktree: boolean
  }
  target: {
    mainWorktreeName: string
    mainBranch: string
    remote: string
    remoteBranch: string
    upstreamRef: string
    baseSha: string
    mainHead: string
    upstreamHead: string
    aheadOfUpstream: number
  }
  commits: readonly MobileDeliveryCommit[]
  blockers: readonly MobileDeliveryError[]
  warnings: readonly string[]
  forkSupported: boolean
  expectation: MobileDeliveryExpectation
}

export interface PreviewDeliveryPayload {
  ref: MobileSessionRef
}

export interface StartDeliveryPayload {
  ref: MobileSessionRef
  expectation: MobileDeliveryExpectation
}

export interface DeliveryCommandPayload {
  ref: MobileSessionRef
  deliveryId: string
}

/** Result of `startDelivery`. */
export interface MobileDeliveryStartResult {
  deliveryId: string
}

// ---- Push session branch -----------------------------------------------------

export interface MobilePushBranchSource {
  /** Worktree directory name; absolute paths never reach the phone. */
  worktreeName: string
  branch: string
  head: string
  dirty: boolean
  changedFileCount: number
  untrackedCount: number
  pendingOperation?: string
  isMainWorktree: boolean
}

export interface MobilePushBranchRemote {
  name: string
  branch: string
  exists: boolean
  head?: string
  ahead: number
  behind: number
}

/** Heads pinned by the preview; `pushBranch` echoes them back for re-check. */
export interface MobilePushBranchExpectation {
  branch: string
  head: string
  remote: string
  remoteBranch: string
  remoteHead?: string
}

export interface MobilePushBranchPreview {
  source: MobilePushBranchSource
  remote: MobilePushBranchRemote
  blockers: readonly MobileDeliveryError[]
  warnings: readonly string[]
  expectation: MobilePushBranchExpectation
}

export interface PreviewPushBranchPayload {
  ref: MobileSessionRef
}

export interface PushBranchPayload {
  ref: MobileSessionRef
  expectation: MobilePushBranchExpectation
}

export interface MobilePushBranchResult {
  branch: string
  remote: string
  remoteBranch: string
  head: string
  published: boolean
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
  | DraftUpdateFrame
export type ClientFrameType = ClientFrame['type']

// Server → client

export interface HelloOkFrame {
  type: 'hello_ok'
  protocolVersion: number
  serverVersion: string
  deviceId: string
  serverTime: number
  capabilities: string[]
  /** Entry script the gateway currently serves; lets a stale PWA prompt for reload. */
  webBuildId?: string
  /** VAPID public key (`base64url`), present when Web Push is configured. */
  vapidPublicKey?: string
  /** Notification preferences saved for this device; absent when never set. */
  notificationPrefs?: MobileNotificationPrefs
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
  /** Full replacement; omitted means unchanged, `[]` clears. */
  images?: readonly MobileMessageImage[]
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

/** Full replacement; the agent can refresh its command list mid-session. */
export interface MobileAvailableCommandsSnapshotEvent {
  type: 'available_commands_snapshot'
  commands: readonly MobileAvailableCommand[]
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

/** Full replacement of the shared draft; `clientUpdateId` only echoes to the sender. */
export interface MobileDraftUpdateEvent {
  type: 'draft_update'
  draft: MobileDraftState
  clientUpdateId?: string
}

export type MobileSessionEvent =
  | MobileMessageUpsertEvent
  | MobileToolCallUpsertEvent
  | MobileTimelineItemAddedEvent
  | MobileTimelineItemRemovedEvent
  | MobilePlanSnapshotEvent
  | MobileConfigOptionsSnapshotEvent
  | MobileAvailableCommandsSnapshotEvent
  | MobileSummaryChangedEvent
  | MobilePermissionUpsertEvent
  | MobilePermissionClearedEvent
  | MobileElicitationUpsertEvent
  | MobileElicitationClearedEvent
  | MobileDraftUpdateEvent

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

export type ServerFrameType = ServerFrame['type']
