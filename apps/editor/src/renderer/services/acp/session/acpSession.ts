/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSession — per-session view-model. Holds the streaming message + tool
 *  call + plan + permission state, owns one ACP `ClientSideConnection`, and
 *  exposes everything as observables for the React layer. The configOption
 *  push/echo state machine is delegated to a ConfigOptionStateMachine sub-object.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  autorun,
  estimateCostUSD,
  generateUuid,
  localize,
  observableValue,
  Emitter,
  TransactionImpl,
  type ITelemetryService,
  type IObservable,
  type ISettableObservable,
  type Event,
} from '@universe-editor/platform'
import type {
  AvailableCommand,
  ContentBlock,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { IAcpClientConnection } from '../acpClientService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import type { ISessionChangeTrackerService } from './sessionChangeTracker.js'
import type { IAcpSessionTitleService } from './acpSessionTitleService.js'
import { isPromptEchoTitle } from './acpSessionTitleEcho.js'
import type { IAcpCompactionStatsService } from './acpCompactionStats.js'
import type { IAcpMessageAttachmentStore } from './acpMessageAttachmentStore.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import { ConfigOptionStateMachine } from './acpSessionConfigOptions.js'
import { AcpSessionConnection, type QueuedPrompt } from './acpSessionConnection.js'
import { AcpConnectionError } from './acpErrors.js'
import { isAuthRequiredError } from './acpAuthError.js'
import { classifyAcpError } from './acpErrorClassify.js'
import { AcpPromptCancelledDraftStash } from './acpPromptCancelledDraftStash.js'
import {
  MAX_RECOVERY_ATTEMPTS,
  SessionRecovery,
  recoveryBackoffMs,
  type AcpRecoveryState,
} from './acpSessionRecovery.js'
import {
  composeContextBlocks,
  formatSelectionFallback,
  type SelectionContext,
} from '../promptContext.js'
import { composeImageBlocks, type PromptImage } from '../promptImage.js'
import { composePromptBlocksFromRefs, type PlacedRef } from '../promptRef.js'
import { getAgentCostStrategy, type AcpAgentCostStrategy } from './acpAgentCostStrategy.js'
import { repriceForeignModelBreakdown } from './acpSessionCost.js'
import { priceSessionModel, type IAcpSessionProviderContext } from './acpSessionProviderContext.js'
import {
  LIVE_INGESTION_BUDGET,
  MESSAGE_TEXT_REBUILD_AT,
  REPLAY_INGESTION_BUDGET,
  capContentBlock,
  capMessageBlocksTail,
  capRawInput,
  capTerminalOutputTail,
  capToolCallBlocks,
  estimateUpdateResidentBytes,
} from './acpContentLimits.js'
import {
  blocksToText,
  isBlankContentBlock,
  mergeStreamingBlock,
  readToolCallLocations,
  splitToolCallContent,
} from './acpSessionContent.js'
import {
  extractModelBreakdown,
  readFileChanges,
  readMcpServer,
  readMcpTool,
  readMessageId,
  readParentToolUseId,
  readSubagentStats,
  readTerminalOutput,
} from './acpSessionUpdateMeta.js'
import { ACP_CAPABILITIES_META_KEY, type AcpUniverseCapabilities } from './acpExtMethods.js'
import {
  AcpAbortError,
  REWIND_SESSION_METHOD,
  SET_SESSION_TITLE_METHOD,
  type AcpChildItem,
  type AcpMcpServerStatus,
  type AcpMessage,
  type AcpMessageRole,
  type AcpPendingPermission,
  type AcpPendingElicitation,
  type AcpPlanEntry,
  type AcpCompaction,
  type AcpCompactionPhase,
  type AcpResurrection,
  type AcpResurrectionPhase,
  type AcpSessionAwakeOutcome,
  type AcpSessionStatus,
  type AcpSubagentStats,
  type AcpToolCall,
  type AcpToolCallStatus,
  type AcpUsage,
  type IAcpSession,
  type IAcpSessionInitState,
  type RewindFilesResult,
  type TimelineItem,
} from './acpSessionModel.js'

// Re-export the view-model types + helpers that moved to sibling modules, so the
// many `from '.../acpSession.js'` import sites across the renderer keep working.
export {
  AcpAbortError,
  BACKGROUND_ACTIVITY_METHOD,
  COMPACTION_METHOD,
  LIVENESS_PING_METHOD,
  MCP_SERVER_STATUS_METHOD,
  PLAN_AUTO_EXECUTE_DELAY_MS,
  RESURRECTION_METHOD,
  REWIND_SESSION_METHOD,
  SET_SESSION_TITLE_METHOD,
} from './acpSessionModel.js'
export type {
  AcpChildItem,
  AcpCompaction,
  AcpCompactionPhase,
  AcpMcpServerStatus,
  AcpMessage,
  AcpMessageRole,
  AcpModelCost,
  AcpPendingPermission,
  AcpPendingElicitation,
  AcpUrlElicitationState,
  AcpPlanEntry,
  AcpPlanEntryStatus,
  AcpResurrection,
  AcpResurrectionPhase,
  AcpSessionAwakeOutcome,
  AcpSessionStatus,
  AcpSubagentStats,
  AcpToolCall,
  AcpToolCallDiff,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpUsage,
  IAcpSession,
  IAcpSessionInitState,
  RewindFilesResult,
  TimelineItem,
} from './acpSessionModel.js'
export type { AcpRecoveryPhase, AcpRecoveryState } from './acpSessionRecovery.js'
export {
  blocksToText,
  firstLineSummary,
  hasVisibleMessageContent,
  isBlankContentBlock,
  mergeStreamingBlock,
  splitToolCallContent,
  timelineItemToText,
  toolCallToText,
} from './acpSessionContent.js'

/** Provenance of a session title — see {@link AcpSession._pendingTitleKind}. */
type TitleKind = 'ai' | 'manual' | 'derived' | undefined

/**
 * Continuation prompt sent automatically after a hot-reconnect (or a retried
 * turn) when the interrupted turn had already produced output, so resending
 * the original prompt would duplicate the turn in the agent transcript.
 */
export const CONTINUE_PROMPT_TEXT = '继续'

/**
 * Function rather than a module constant: `localize` reads the NLS state at
 * call time, and module evaluation may run before `configureNls`.
 */
export function recoveryContinuePromptText(): string {
  return localize(
    'acp.recovery.continueAfterInterrupt',
    'Continue. Note: the previous turn was aborted by a connection interruption, not by me. If you had a question or confirmation waiting for my answer at that moment, do not treat it as answered, skipped, or declined — re-ask it now.',
  )
}

/**
 * Timeline notice appended when a history replay blew the ingestion budget and
 * the remaining updates were dropped. Function rather than a module constant:
 * `localize` reads the NLS state at call time.
 */
export function replayHistoryOverflowNotice(): string {
  return localize(
    'acp.session.historyOverflow',
    'Session history is too large; only the first part of the history was loaded.',
  )
}

/**
 * Body shown on a timeline card whose heavy content was released by the live
 * resident budget (oldest-first trimming) to protect the renderer from OOM.
 * Function rather than a module constant: `localize` reads the NLS state at call
 * time, and the trimmed card bakes the resolved text in at trim time.
 */
export function memoryTrimmedNotice(): string {
  return localize(
    'acp.session.memoryTrimmed',
    'Content released to protect memory; the newest output was kept.',
  )
}

/** UTF-16 byte size of a string (`length` code units × 2). */
function stringBytes(s: string): number {
  return s.length * 2
}

/** Heavy resident bytes a tool card holds: the `text` copy, its content blocks,
 * its diff sides, and the same for any sub-agent children — exactly what
 * trimming releases. Children must be counted: their content arrives as its own
 * updates (so it is charged to the budget), but it is retained nested on the
 * parent card, so a measure that skipped it would report 0 for a card still
 * holding megabytes and the trim loop would give up with the budget overrun. */
function toolCallHeavyBytes(call: AcpToolCall): number {
  let bytes = stringBytes(call.text)
  for (const b of call.blocks) {
    if (b.type === 'text') bytes += stringBytes(b.text)
    else if (b.type === 'image' || b.type === 'audio') bytes += stringBytes(b.data)
  }
  for (const d of call.diffs) bytes += stringBytes(d.oldText) + stringBytes(d.newText)
  for (const child of call.children ?? []) {
    bytes +=
      child.kind === 'toolCall' ? toolCallHeavyBytes(child.call) : messageHeavyBytes(child.message)
  }
  return bytes
}

/** Heavy resident bytes a message holds: the `text` copy plus its blocks. */
function messageHeavyBytes(message: AcpMessage): number {
  let bytes = stringBytes(message.text)
  for (const b of message.blocks) {
    if (b.type === 'text') bytes += stringBytes(b.text)
    else if (b.type === 'image' || b.type === 'audio') bytes += stringBytes(b.data)
  }
  return bytes
}

/** Release a tool card's heavy content, keeping the shell (title / status /
 * kind / locations / children) so the timeline still renders a recognisable
 * card marked `memoryTrimmed`. Children keep their own shells but are trimmed
 * too — `toolCallHeavyBytes` counts them, so leaving them intact would report
 * bytes the trim never actually released. */
function trimToolCall(call: AcpToolCall): AcpToolCall {
  const children = call.children?.map(
    (child): AcpChildItem =>
      child.kind === 'toolCall'
        ? { kind: 'toolCall', id: child.id, call: trimToolCall(child.call) }
        : { kind: 'message', id: child.id, message: trimMessage(child.message) },
  )
  return {
    id: call.id,
    title: call.title,
    kind: call.kind,
    status: call.status,
    blocks: [],
    diffs: [],
    text: '',
    memoryTrimmed: true,
    ...(call.mcpServer !== undefined ? { mcpServer: call.mcpServer } : {}),
    ...(call.mcpTool !== undefined ? { mcpTool: call.mcpTool } : {}),
    ...(call.locations !== undefined ? { locations: call.locations } : {}),
    ...(call.subagentStats !== undefined ? { subagentStats: call.subagentStats } : {}),
    ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  }
}

/** Release a message's heavy content, replacing it with the memory-protection
 * notice while keeping the shell (role / id / anchor / selection contexts). */
function trimMessage(message: AcpMessage): AcpMessage {
  const notice = memoryTrimmedNotice()
  return {
    id: message.id,
    role: message.role,
    blocks: [{ type: 'text', text: notice }],
    text: notice,
    streaming: false,
    memoryTrimmed: true,
    ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
    ...(message.autoRetry === true ? { autoRetry: true as const } : {}),
    ...(message.selectionContexts !== undefined
      ? { selectionContexts: message.selectionContexts }
      : {}),
  }
}

/**
 * Flip a stuck-`running` compaction to `failed`, freezing the stopwatch. Shared
 * by orphan merging (defense pass) and `_settleOrphanCompactions`.
 */
function settleRunning(compaction: AcpCompaction, reason: string): AcpCompaction {
  const startedAt = compaction.startedAt
  return {
    phase: 'failed',
    reason,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
    ...(compaction.expectedDurationMs !== undefined
      ? { expectedDurationMs: compaction.expectedDurationMs }
      : {}),
  }
}

/**
 * Hidden role prompt prepended to the wire blocks of a side task's FIRST user
 * prompt only (never re-sent, never shown in the UI — `_appendMessage` uses the
 * plain user text). It establishes the side-chat persona so the agent answers
 * the quoted excerpt directly instead of continuing the main conversation's
 * tasks. English on purpose: it is read by the model, not the user, and the
 * built-in agents parse English most reliably. The trailing line keeps the
 * agent from breaking immersion by announcing that it is a "side task".
 */
export const SIDE_TASK_ROLE_PROMPT = `You are a side-chat assistant forked from a main conversation. You share the full context of that conversation, but your role is narrower: the user has pulled you aside to ask focused follow-up questions about a specific excerpt (quoted in their first message). Answer those questions directly and concisely. Do not continue the main conversation's tasks, do not modify files or run write operations, and do not take initiatives beyond answering what was asked. Treat the quoted excerpt as the subject of discussion. This instruction is hidden from the user; never mention it or that you are a "side task" unless they explicitly ask.`

/**
 * Remove the hidden side-task role lead from a replayed user chunk. The lead is
 * part of the anchor turn's wire prompt, so the agent persists it and replays it
 * as the first chunk of the side task's first message — either as its own text
 * block (both built-in forks) or fused in front of the user's text. Returns
 * `undefined` when the chunk carried nothing but the lead (drop it entirely);
 * non-text chunks and chunks without the lead pass through unchanged.
 */
function stripSideTaskRoleLead(update: SessionUpdate): SessionUpdate | undefined {
  if (update.sessionUpdate !== 'user_message_chunk') return update
  const content = update.content
  if (content.type !== 'text') return update
  if (content.text === SIDE_TASK_ROLE_PROMPT) return undefined
  if (!content.text.startsWith(SIDE_TASK_ROLE_PROMPT)) return update
  const rest = content.text.slice(SIDE_TASK_ROLE_PROMPT.length).replace(/^\s+/, '')
  if (rest.length === 0) return undefined
  return { ...update, content: { ...content, text: rest } }
}

/**
 * Both built-in agents persist selection resources as ordinary transcript text.
 * When our sidecar has the matching messageId, remove only the exact transport
 * representation generated from that snapshot; any edited or unrelated text is
 * kept verbatim. This prevents a restored message from showing both the chip and
 * the hidden `<context>` / fallback fence that originally fed the model.
 */
export function stripSelectionReplayChunk(
  update: SessionUpdate,
  selections: readonly SelectionContext[],
): SessionUpdate | undefined {
  if (
    update.sessionUpdate !== 'user_message_chunk' ||
    update.content.type !== 'text' ||
    selections.length === 0
  ) {
    return update
  }

  let text = update.content.text
  for (const selection of selections) {
    for (const transport of selectionReplayTransports(selection)) {
      if (text === transport) return undefined
      if (text.startsWith(transport)) text = text.slice(transport.length).replace(/^\s+/, '')
      if (text.endsWith(transport)) text = text.slice(0, -transport.length).replace(/\s+$/, '')
    }
  }
  if (text.length === 0) return undefined
  return text === update.content.text ? update : { ...update, content: { ...update.content, text } }
}

function selectionReplayTransports(selection: SelectionContext): readonly string[] {
  const fileName = selection.uri.split('/').pop() || selection.uri
  const link = `[@${fileName}](${selection.uri})`
  const context = `<context ref="${selection.uri}">\n${selection.text}\n</context>`
  return [link, `\n${context}`, context, `${link}\n${context}`, formatSelectionFallback(selection)]
}

/** Why the session's connection was lost — drives the service's recovery path. */
export interface AcpConnectionLostEvent {
  /**
   * `crash`: process exited. `stalled`: alive but silent past the watchdog
   * threshold. `restart`: the user asked for a fresh process (the sub-agent
   * model is spawn env, so it only changes on respawn). `wake`: the process was
   * stopped by the idle reaper and an operation needs it back (see
   * {@link AcpSession.ensureAwake}) — like `crash` the process is already gone,
   * so the reconnect must NOT evict the pool entry.
   */
  readonly reason: 'crash' | 'stalled' | 'restart' | 'wake'
}

/** Snapshot of one dispatched prompt, kept so a failed/interrupted turn can be re-sent. */
interface PromptSnapshot {
  readonly text: string
  readonly refs: readonly PlacedRef[]
  readonly contexts: readonly SelectionContext[]
  readonly images: readonly PromptImage[]
  readonly messageId: string
  /**
   * The dispatch's own anchor id (never switched to a continuation id) — the
   * user message it appended, which cancelTurn retracts on restore.
   */
  readonly sentMessageId: string
  /**
   * `_agentOutputCount` when the prompt was dispatched — zero-output detection.
   * A turn still at this baseline produced no visible output: the retry /
   * reconnect paths resend the prompt verbatim, and cancelTurn retracts it
   * (restoring the draft). Once the agent has emitted any visible output the
   * turn is continued (`继续`) instead, and a cancel is a normal interruption.
   * Metadata updates (usage / config / session_info / available_commands)
   * deliberately don't move this counter — the reconnect handshake always
   * echoes a few of those, and they don't answer the user's prompt.
   */
  readonly outputBaseline: number
}

/**
 * Update kinds that surface as visible agent output. Feeds `_agentOutputCount`
 * — cancelTurn's "did the agent answer at all" signal. Metadata updates
 * (usage / config / session_info / available_commands) deliberately excluded:
 * they don't answer the user's prompt.
 */
const AGENT_OUTPUT_UPDATE_KINDS: ReadonlySet<SessionUpdate['sessionUpdate']> = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
])

/**
 * The marker the SDK appends to the transcript (as its own user row) when a
 * turn is interrupted mid-stream. The live ACP stream never delivers it, so
 * cancelTurn appends it locally on a normal interruption, and the replay
 * filter matches on it when skipping a retracted turn's trailing marker.
 */
const INTERRUPTED_MARKER_TEXT = '[Request interrupted by user]'

/**
 * How many superseded durable ids a session remembers (see
 * {@link AcpSession._priorAgentSessionIds}). Only ids a not-yet-re-persisted
 * editor tab could still hold need resolving, so a handful is plenty and the
 * set stays bounded across repeated restarts.
 */
const MAX_PRIOR_AGENT_SESSION_IDS = 4

// Built-in slash commands the agent handles locally (mirrors
// BUILT_IN_COMMANDS in vendor/claude-agent-acp/src/acp-agent.ts). Their args
// are command parameters (`/model opus`), not user prose, so a prompt that is
// one of these carries no title-worthy content. Custom skills like
// `/fix-ci-e2e-flake <the real task>` are NOT in this set — their args are the
// user's actual prompt and make perfectly good titles.
const LOCAL_COMMAND_NAMES: ReadonlySet<string> = new Set([
  '/model',
  '/compact',
  '/resume',
  '/effort',
  '/status',
  '/clear',
  '/context',
  '/heapdump',
  '/extra-usage',
])

/** True when the prompt is exactly an invocation of a locally-handled built-in command. */
function isLocalCommandPrompt(text: string): boolean {
  const m = /^\s*(\/\S+)/.exec(text)
  return m !== null && LOCAL_COMMAND_NAMES.has(m[1]!)
}

/**
 * Title source text: a leading markdown blockquote (e.g. the side-task prefill
 * quoting the source selection) is context, not the user's own words — strip it
 * so derived / generated titles reflect the question that follows. Returns ''
 * when the prompt is nothing but a quote.
 */
function stripLeadingBlockquote(text: string): string {
  return text.replace(/^(?:>[ \t]?.*(?:\n|$))+/, '').trim()
}

/** How many dispatched prompts to remember for the title-echo guard. */
const DISPATCHED_PROMPT_MEMORY = 8

export class AcpSession extends Disposable implements IAcpSession {
  readonly sessionIdOnAgent: ISettableObservable<string | undefined>
  /**
   * Durable ids this session used to carry, oldest-first, capped at
   * {@link MAX_PRIOR_AGENT_SESSION_IDS}. An EMPTY session rebuilt during a hot
   * reconnect (`session/new` — see AcpSessionService._reconnectSession) gets a
   * brand-new agent id, but editor tabs / session-list rows opened before the
   * rebuild still hold the old one. Keeping the aliases lets `getById` resolve
   * them instead of reporting the session as gone (which would silently close
   * the user's tab). Only the recent ones can still be referenced — a tab
   * serializes the live id on every layout persist — so the set is bounded
   * rather than growing once per restart for the window's whole lifetime.
   */
  private readonly _priorAgentSessionIds = new Set<string>()
  readonly messages: ISettableObservable<readonly AcpMessage[]>
  readonly toolCalls: ISettableObservable<readonly AcpToolCall[]>
  readonly plan: ISettableObservable<readonly AcpPlanEntry[]>
  readonly timeline: ISettableObservable<readonly TimelineItem[]>
  readonly status: ISettableObservable<AcpSessionStatus>
  readonly isReplayingHistory: ISettableObservable<boolean>
  readonly usage: ISettableObservable<AcpUsage | undefined>
  readonly pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  readonly pendingElicitation: ISettableObservable<AcpPendingElicitation | undefined>
  readonly availableCommands: ISettableObservable<readonly AvailableCommand[]>
  readonly mcpServers: ISettableObservable<readonly AcpMcpServerStatus[]>
  readonly mcpServerSelection: ISettableObservable<readonly string[] | null>
  readonly collapseMode: ISettableObservable<CollapseMode>
  readonly accumulatedRunningMs: ISettableObservable<number>
  readonly runningStartedAt: ISettableObservable<number | undefined>
  readonly backgroundTaskCount: ISettableObservable<number>

  /**
   * Backing store for {@link isDormant} — see that getter for the semantics and
   * for why this is an explicitly-set flag rather than a `derived(...)`.
   */
  private readonly _dormant: ISettableObservable<boolean>

  private readonly _onDidRequireAuth = this._register(new Emitter<void>())
  readonly onDidRequireAuth: Event<void> = this._onDidRequireAuth.event

  private readonly _onDidCancelForRestore = this._register(new Emitter<void>())
  readonly onDidCancelForRestore: Event<void> = this._onDidCancelForRestore.event

  private readonly _configOptions: ConfigOptionStateMachine

  private _messages: AcpMessage[] = []
  private _toolCalls: AcpToolCall[] = []
  private _timeline: TimelineItem[] = []
  private _msgCounter = 0

  /** Abort controllers for all in-flight `session/prompt` calls (concurrent steering). */
  private readonly _inFlight = new Set<AbortController>()
  /** Latches 'errored' once all in-flight settle if any of them failed. */
  private _sawError = false
  /**
   * True while the agent runs an autonomous follow-up turn (task-completion
   * wakeup) — such a turn occupies no prompt RPC, so it must keep the session
   * 'running' on its own. Reported via `_universe/background_activity`.
   */
  private _autonomousTurnActive = false

  // 16ms batching: collapse bursts of session/update chunks into one
  // observer notification per frame. Underlying values still update
  // synchronously (set(v, tx) writes _value before tx.finish()).
  private _pendingTx: TransactionImpl | undefined
  private _flushTimer: ReturnType<typeof setTimeout> | undefined

  private readonly _streamingIds = new Set<string>()

  /** True once the first `plan` update has been seen (drives one-time seal). */
  private _planSeen = false

  /**
   * Child items (sub-agent message / tool calls) that arrived before their
   * parent tool call landed on the timeline. Keyed by parentToolUseId; merged
   * into the parent's `children` when it appears. Defensive against out-of-order
   * delivery — agents normally emit the parent tool_call first.
   */
  private readonly _orphanChildren = new Map<string, readonly AcpChildItem[]>()

  /**
   * Remembers each tool call's parent on first sighting. Later updates that drop
   * `parentToolUseId` (notably the PostToolUse hook's `tool_call_update`) fall
   * back to this so they re-attach to the parent card instead of spawning an
   * orphan top-level slot that stays "pending" forever.
   */
  private readonly _toolCallParent = new Map<string, string>()

  /**
   * Accumulates terminal output per tool call. The codex-acp fork streams command
   * output out-of-band via `_meta.terminal_output_delta` (append) / `terminal_output`
   * (replace) rather than as `content` blocks — the `content` only carries a
   * `terminal` placeholder. We fold those deltas here, keyed by toolCallId, and
   * surface the result as the execute card's body.
   */
  private readonly _terminalOutput = new Map<string, string>()

  /** Guards one-shot AI title generation (see `_maybeGenerateTitle`). */
  private _titleGenerated = false

  /**
   * Latched once the user manually renames the session. Blocks both the
   * first-prompt-derived title and the AI title from overwriting the user's
   * choice on subsequent prompts.
   */
  private _titleLocked = false

  /** Latched once a first-prompt-derived title has been written. */
  private _titleDerived = false

  /** Latched once the full first prompt has been mirrored onto the history row. */
  private _firstPromptRecorded = false

  /**
   * Latest title derived/generated before the agent id existed. Re-applied to
   * the history row from {@link attachConnection} once the row is in place.
   */
  private _pendingTitle: string | undefined

  /**
   * Full first prompt recorded before the agent id existed (same pre-attach
   * gap as {@link _pendingTitle}). Re-applied from {@link attachConnection}.
   */
  private _pendingFirstPrompt: string | undefined

  /**
   * Provenance of {@link _pendingTitle}: `'ai'` (session-title model),
   * `'manual'` (user rename), or `'derived'` (first-prompt fallback). AI and
   * manual titles are flagged on the history row and pushed back to the agent so
   * they survive `/compact` + the next `session/list`; a derived title is flagged
   * locally only (see {@link _applyHistoryTitle}).
   */
  private _pendingTitleKind: TitleKind = undefined

  /**
   * Texts of the prompts this session actually dispatched, newest last (capped at
   * {@link DISPATCHED_PROMPT_MEMORY}). Without a session-title model the SDK
   * summary falls back to `lastPrompt`, so the agent re-reports the newest prompt
   * as the session title at every turn end — these let us recognize and drop that
   * echo. Replayed history messages are deliberately excluded: a legitimate old
   * title must not be mistaken for an echo on hydrate.
   */
  private readonly _dispatchedPromptTexts: string[] = []

  /**
   * Live connection, set by {@link attachConnection} once the agent handshake
   * completes. `undefined` while the session is still connecting (or after a
   * connection failure).
   */
  private get _conn(): IAcpClientConnection | undefined {
    return this._connection.conn
  }

  /**
   * Connection lifecycle state machine: owns the connecting → connected/failed/
   * closed phase, the `whenConnected` gate, and the prompts queued while
   * connecting (each carrying its caller's resolve/reject so a queued prompt is
   * dispatched exactly once on connect, or rejected on failure — never lost).
   */
  private readonly _connection = new AcpSessionConnection()

  /** Auto-recovery state (retry / reconnect progress) surfaced to the UI. Owned
   * by this session; the service drives the reconnect tier through it. */
  readonly recovery = new SessionRecovery()

  /**
   * Monotonic counter bumped only by updates that surface as visible agent
   * output (message / thought / tool call / plan). Compared against a prompt's
   * dispatch-time `outputBaseline` to tell "the turn produced no output" (safe
   * to auto-resend, and cancelTurn retracts the prompt + restores the draft)
   * from "partial output exists" (retry/reconnect continue with `继续` instead
   * so the agent transcript doesn't duplicate the turn, and a cancel is a
   * normal interruption keeping the partial turn on the timeline). Metadata
   * updates (usage / config / session_info / available_commands) don't move it.
   */
  private _agentOutputCount = 0

  /**
   * Wall-clock of the last activity on the turn — bumped by every inbound
   * `session/update` AND by each outbound prompt dispatch. Read by the
   * service's stall watchdog: measuring from dispatch too keeps the first
   * prompt after a long idle gap from being declared stalled instantly.
   */
  private _lastActivityAt = Date.now()

  /** True while a hot-reconnect is in progress (connection lost → reattached). */
  private _reconnecting = false

  /** Set when the connection died mid-turn; consumed by {@link continueInterruptedTurn}. */
  private _turnInterrupted = false

  /**
   * Set alongside {@link _turnInterrupted} when the lost connection had a
   * pending elicitation/permission card — the card is settled as cancelled on
   * disconnect, so the continuation prompt must tell the agent the question
   * was aborted (not skipped/declined) and should be re-asked.
   */
  private _interruptedWithPendingInteraction = false

  /** Last dispatched prompt + its output baseline, for zero-output resend after reconnect. */
  private _lastDispatch: PromptSnapshot | undefined

  /** Prompt whose automatic retries ran out — kept so the UI can offer a manual retry. */
  private _failedPrompt: PromptSnapshot | undefined

  private readonly _onDidLoseConnection = this._register(new Emitter<AcpConnectionLostEvent>())
  /**
   * Fired when the agent connection died unexpectedly (crash / watchdog stall)
   * and the session entered hot-reconnect. The service listens and re-handshakes.
   */
  readonly onDidLoseConnection: Event<AcpConnectionLostEvent> = this._onDidLoseConnection.event

  /**
   * Whether the connected agent advertised `promptCapabilities.embeddedContext`.
   * Resolved once from the pooled `initialize()` response on attach and cached so
   * `_dispatchPrompt` can pick the EmbeddedResource vs fenced-text wire shape for
   * attached selection contexts without awaiting per prompt. `false` until known.
   */
  private _embeddedContextSupported = false

  /**
   * Side-task gate: while set, replayed updates that would land on the timeline
   * (messages / tool calls / plan) — and their change-tracker side effects — are
   * dropped so the forked baseline stays invisible (the fork exists only as
   * agent-side context). Config / commands / usage updates still apply. Armed by
   * {@link suppressReplayToTimeline}, cleared by {@link endHistoryReplay}.
   */
  private _suppressReplayToTimeline = false

  /**
   * Replay ingestion accounting (session/load, rewind): tallies the resident
   * cost of replayed updates against `_replayIngestionBudget`. Past the budget
   * the remaining replayed updates are dropped (`_replayOverflow`) so a
   * multi-GB restored history cannot OOM the renderer; `endHistoryReplay`
   * marks the truncation with a timeline notice.
   */
  private _replayIngestedBytes = 0
  private _replayOverflow = false

  /**
   * Live-run resident accounting (the non-replay path): tallies the resident
   * cost of updates as they land, and once it passes `_liveIngestionBudget`
   * the oldest heavy content is trimmed in place instead of rejecting new
   * output. Unlike the replay gate (which drops the remaining history), a live
   * turn must always surface its newest output.
   */
  private _liveIngestedBytes = 0

  /**
   * Replay boundary paired with {@link _suppressReplayToTimeline}: the side
   * task's first own user prompt id. The replayed user chunk carrying this id
   * lifts the suppression so the side task's own turns (from that message on)
   * land on the timeline while the forked baseline before them stays dropped.
   * `undefined` = no turns sent yet → the whole replay is suppressed.
   */
  private _suppressAnchorMessageId: string | undefined

  /**
   * Anchor ids of user prompts retracted by {@link cancelTurn}'s restore. The
   * retraction is local-only — the agent transcript keeps the turn — so a
   * resume replay would resurface it. Replayed user chunks carrying one of
   * these ids are dropped instead (see the `user_message_chunk` case).
   * Hydrated from the history row on resume; appended on every retraction.
   */
  private readonly _retractedMessageIds = new Set<string>()

  /**
   * Set when a replayed user chunk is dropped via {@link _retractedMessageIds}:
   * the transcript's trailing `[Request interrupted by user]` marker (written
   * by the SDK as a separate user message right after the interrupted one) is
   * dropped with it. Consumed by the next user chunk either way.
   */
  private _skipInterruptedMarker = false

  /**
   * Whether the connected agent advertised `promptCapabilities.image`. Cached
   * from the same `initialize()` response so the UI can gate the paste/drop/pick
   * entry points. Observable because the capability arrives async after attach,
   * and the prompt input reacts to it. `false` until known.
   */
  readonly imageSupported: ISettableObservable<boolean>

  /**
   * Whether the connected agent advertised `sessionCapabilities.fork`. Cached
   * from the same `initialize()` response as {@link imageSupported}; observable
   * because it arrives async after attach. `false` until known.
   */
  readonly forkSupported: ISettableObservable<boolean>

  /**
   * Whether the connected agent advertised rewind (回退) support via its
   * `initialize` `_meta['universe-editor/capabilities'].rewind` block. Replaces
   * the old hardcoded `agentId === 'claude-code'|'codex'` white-list: any agent
   * (including user-defined) that declares the capability lights up the
   * affordance. Observable because it arrives async after attach; `false` until
   * known. See {@link _filesRolledBackByAgent} for the file-rollback semantics.
   */
  readonly rewindSupported: ISettableObservable<boolean>

  /**
   * Whether the agent rolls the working-tree edits back itself during a rewind
   * (claude: SDK file-checkpointing) or only truncates history and leaves file
   * rollback to the editor's change tracker (codex). Read from the same
   * capability block as {@link rewindSupported}; defaults to `true`. Drives the
   * file-rollback branch in {@link rewindTo}.
   */
  private readonly _filesRolledBackByAgent: ISettableObservable<boolean>

  /**
   * Local cost-estimation strategy for this agent, or `undefined` when the agent
   * reports authoritative cost itself (Claude). Replaces the inline
   * `agentId === 'codex'` cost branches — see acpAgentCostStrategy.ts.
   */
  private readonly _costStrategy: AcpAgentCostStrategy | undefined

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly title: string,
    private readonly _telemetry: ITelemetryService,
    initState?: IAcpSessionInitState,
    initialCollapseMode: CollapseMode = 'default',
    private readonly _history?: IAcpSessionHistoryService,
    private readonly _agentDefaults?: IAcpAgentDefaultsService,
    private readonly _changeTracker?: ISessionChangeTrackerService,
    private readonly _titleService?: IAcpSessionTitleService,
    readonly readOnly: boolean = false,
    private readonly _compactionStats?: IAcpCompactionStatsService,
    private readonly _messageAttachments?: IAcpMessageAttachmentStore,
    /**
     * Isolated sessions (AI Fix): config selections never write back to the
     * per-agent defaults. Threaded into the config-option state machine.
     */
    suppressConfigDefaults: boolean = false,
    /**
     * Resident-cost budget for one history replay (session/load, rewind).
     * Injectable so tests can exercise the overflow path with tiny payloads.
     */
    private readonly _replayIngestionBudget: number = REPLAY_INGESTION_BUDGET,
    /**
     * Resident-cost budget for the live (non-replay) view model. Injectable so
     * tests can exercise the trim path with tiny payloads.
     */
    private readonly _liveIngestionBudget: number = LIVE_INGESTION_BUDGET,
    /**
     * Provider-context resolver for cost estimation. The hot path (every usage
     * chunk) reads its synchronous cache to complete the three-segment model id
     * and pick up the gateway rate table. Absent in tests that don't price cost.
     */
    private readonly _providerContext?: IAcpSessionProviderContext,
    /**
     * Host this session's agent runs on (remote-ssh authority; undefined =
     * local). Cost attribution is per host — see IAcpSession.authority.
     */
    readonly authority: string | undefined = undefined,
  ) {
    super()
    this._costStrategy = getAgentCostStrategy(agentId)
    this.sessionIdOnAgent = observableValue<string | undefined>(
      `acp.session.sessionIdOnAgent.${id}`,
      undefined,
    )
    this.messages = observableValue<readonly AcpMessage[]>(`acp.session.messages.${id}`, [])
    this.toolCalls = observableValue<readonly AcpToolCall[]>(`acp.session.toolCalls.${id}`, [])
    this.plan = observableValue<readonly AcpPlanEntry[]>(`acp.session.plan.${id}`, [])
    this.timeline = observableValue<readonly TimelineItem[]>(`acp.session.timeline.${id}`, [])
    this.status = observableValue<AcpSessionStatus>(`acp.session.status.${id}`, 'connecting')
    this.isReplayingHistory = observableValue<boolean>(
      `acp.session.isReplayingHistory.${id}`,
      false,
    )
    this.usage = observableValue<AcpUsage | undefined>(`acp.session.usage.${id}`, undefined)
    this.pendingPermission = observableValue<AcpPendingPermission | undefined>(
      `acp.session.pendingPermission.${id}`,
      undefined,
    )
    this.pendingElicitation = observableValue<AcpPendingElicitation | undefined>(
      `acp.session.pendingElicitation.${id}`,
      undefined,
    )
    this.availableCommands = observableValue<readonly AvailableCommand[]>(
      `acp.session.availableCommands.${id}`,
      [],
    )
    this.mcpServers = observableValue<readonly AcpMcpServerStatus[]>(
      `acp.session.mcpServers.${id}`,
      [],
    )
    this.mcpServerSelection = observableValue<readonly string[] | null>(
      `acp.session.mcpServerSelection.${id}`,
      null,
    )
    this.collapseMode = observableValue<CollapseMode>(
      `acp.session.collapseMode.${id}`,
      initialCollapseMode,
    )
    this.accumulatedRunningMs = observableValue<number>(`acp.session.accumulatedRunningMs.${id}`, 0)
    this.runningStartedAt = observableValue<number | undefined>(
      `acp.session.runningStartedAt.${id}`,
      undefined,
    )
    this.backgroundTaskCount = observableValue<number>(`acp.session.backgroundTaskCount.${id}`, 0)
    this._dormant = observableValue<boolean>(`acp.session.dormant.${id}`, false)
    this.imageSupported = observableValue<boolean>(`acp.session.imageSupported.${id}`, false)
    this.forkSupported = observableValue<boolean>(`acp.session.forkSupported.${id}`, false)
    this.rewindSupported = observableValue<boolean>(`acp.session.rewindSupported.${id}`, false)
    this._filesRolledBackByAgent = observableValue<boolean>(
      `acp.session.filesRolledBackByAgent.${id}`,
      true,
    )
    this._configOptions = new ConfigOptionStateMachine({
      getConn: () => this._conn,
      telemetry: _telemetry,
      sessionInfo: {
        localId: id,
        agentId,
        getSessionId: () => this.sessionIdOnAgent.get(),
      },
      ...(_history !== undefined ? { history: _history } : {}),
      ...(_agentDefaults !== undefined ? { defaults: _agentDefaults } : {}),
      ...(suppressConfigDefaults ? { suppressDefaults: true } : {}),
    })
    if (initState) {
      this.applyInitState(initState)
    }
    if (this._history) {
      const h = this._history
      this._register(
        autorun((r) => {
          // History rows are keyed by the agent-issued id; while connecting it's
          // undefined and the setter no-ops. Reading it here re-fires the autorun
          // once attach lands so the persisted collapse mode catches up.
          const sid = this.sessionIdOnAgent.read(r)
          const mode = this.collapseMode.read(r)
          if (sid !== undefined) h.setHistoryCollapseMode(sid, mode)
        }),
      )
    }
    this._register({ dispose: () => this._conn?.dispose() })
  }

  /**
   * Bind the established connection + agent-issued session id. Flips the session
   * out of 'connecting', wires the connection-close → seal listener, and flushes
   * any prompts the user queued while connecting. Called once by the service
   * after `session/new` (or `session/load`) returns.
   */
  attachConnection(conn: IAcpClientConnection, sessionIdOnAgent: string): void {
    const drained = this._connection.open(conn)
    if (this._connection.phase !== 'connected') return
    // A fresh connection is bound: no longer asleep (see {@link isDormant}).
    this._dormant.set(false, undefined)
    // A successful (re)attach ends any hot-reconnect episode — including the
    // first attach, where the flag was never set.
    this._reconnecting = false
    // Cache the embeddedContext capability so _dispatchPrompt can shape attached
    // selection contexts without awaiting the initialize response per prompt.
    conn.initializeResult
      .then((res) => {
        const caps = res.agentCapabilities?.promptCapabilities
        this._embeddedContextSupported = caps?.embeddedContext === true
        this.imageSupported.set(caps?.image === true, undefined)
        this.forkSupported.set(res.agentCapabilities?.sessionCapabilities?.fork != null, undefined)
        // Rewind support + file-rollback semantics come from the fork's
        // `_meta['universe-editor/capabilities']` block (see acpExtMethods.ts).
        // Replaces the old agentId white-list so user-defined agents that declare
        // the capability also light up the affordance.
        const universeCaps = (
          res.agentCapabilities?._meta as
            | { [ACP_CAPABILITIES_META_KEY]?: AcpUniverseCapabilities }
            | undefined
        )?.[ACP_CAPABILITIES_META_KEY]
        this.rewindSupported.set(universeCaps?.rewind != null, undefined)
        this._filesRolledBackByAgent.set(
          universeCaps?.rewind?.filesRolledBackByAgent !== false,
          undefined,
        )
      })
      .catch(() => {})
    this.sessionIdOnAgent.set(sessionIdOnAgent, undefined)
    // Connection close → seal the session, unless it was unexpected: then the
    // hot-reconnect path takes over instead (see {@link _handleConnectionLost}).
    // `deadOnArrival` marks the one call made synchronously below for a lease
    // that was already aborted when we got it — a startup failure, not an idle
    // reclaim, so it must not be flagged dormant.
    const onClose = (deadOnArrival = false): void => {
      if (this._reconnecting) return // stale listener from the superseded connection
      // User-initiated close() seals the status before the lease disposal can
      // abort the connection, so a late abort landing here must not resurrect
      // the session into recovery.
      if (this.status.get() === 'closed') return
      // Only a connection lost mid-turn interrupts the user's work; an idle
      // session has nothing in flight, so seal it and let the next prompt
      // re-handshake on demand rather than churning a background reconnect.
      if (this._connection.phase === 'connected' && !this.readOnly && this._inFlight.size > 0) {
        this._handleConnectionLost('crash')
        return
      }
      this._commitBatchedTx()
      this._finalizeRunningSegment()
      // Sealed but revivable: flag it so every session operation can tell this
      // apart from a user-initiated close and wake the process on demand
      // (see {@link isDormant}). Excluded: `deadOnArrival` — the lease was
      // already dead when handed to us, which is a startup failure wearing a
      // 'connected' phase (open() flipped it before we could look), and a
      // read-only preview, which must never spawn against the foreign worktree
      // it is viewing. Neither can ever wake.
      if (
        !deadOnArrival &&
        this._connection.phase === 'connected' &&
        !this.readOnly &&
        this.sessionIdOnAgent.get() !== undefined
      ) {
        this._dormant.set(true, undefined)
      }
      this.status.set('closed', undefined)
      this._cancelPending()
      this._abortAllInFlight()
      this._resetBackgroundActivity()
    }
    if (conn.conn.signal.aborted) {
      // The pooled connection is already dead at attach time: a startup failure,
      // so seal without recovery and without the dormant flag. Prompts the user
      // queued while connecting were already drained out of the connection by
      // `open()` above, so reject them here — otherwise their callers hang.
      onClose(true)
      for (const q of drained) {
        q.reject(new AcpConnectionError('Agent connection died before it was ready'))
      }
      return
    }
    // Wrapped: the abort listener is called with an Event, which would land in
    // `deadOnArrival` as a truthy value and suppress the dormant flag on every
    // idle reclaim.
    const onAbort = (): void => onClose()
    conn.conn.signal.addEventListener('abort', onAbort, { once: true })
    this._register({
      dispose: () => conn.conn.signal.removeEventListener('abort', onAbort),
    })
    // Leave a terminal status (closed) untouched; otherwise settle to idle and
    // drain the queue.
    if (this.status.get() === 'connecting') this.status.set('idle', undefined)
    // Re-apply any title derived while connecting now that the history row exists.
    if (this._pendingTitle !== undefined) {
      this._applyHistoryTitle(sessionIdOnAgent, this._pendingTitle, this._pendingTitleKind)
    }
    // Same pre-attach gap for the recorded first prompt.
    if (this._pendingFirstPrompt !== undefined) {
      this._applyHistoryFirstPrompt(sessionIdOnAgent, this._pendingFirstPrompt)
    }
    // Push any configOption values overridden for display but not yet adopted by
    // the agent (notably a `plan` mode picked while connecting) BEFORE dispatching
    // queued prompts. Otherwise a prompt queued during connect races ahead of the
    // pending mode push and the agent runs it under the default mode — skipping
    // the plan-mode approval gate entirely.
    void this._configOptions.flushPendingPushes().then(() => {
      this._flushQueuedPrompts(drained)
    })
  }

  /**
   * Abort the connecting phase after a spawn/initialize/newSession failure.
   * Marks the session errored, surfaces the reason on the timeline, and rejects
   * any queued prompts so their callers don't hang (and so the dropped prompt is
   * observable instead of silently lost).
   */
  failConnection(message: string): void {
    if (!this._connection.fail(message)) return
    this._resetBackgroundActivity()
    if (this.status.get() === 'connecting') {
      this._appendMessage('agent', `[error] ${message}`)
      this.status.set('errored', undefined)
    }
  }

  whenConnected(): Promise<void> {
    return this._connection.whenSettled()
  }

  /**
   * True while this session sits in the "asleep but revivable" state the idle
   * reaper leaves behind: the agent process was stopped to free memory
   * (`acp.idleProcessTimeoutMs`), so the connection's abort signal fired and
   * `onClose` sealed `status` to `'closed'` — but the phase is still
   * `'connected'`, the session object is alive, and its durable id can be
   * resumed. Distinguishing this from a user-initiated `close()` is the whole
   * point: dormant sessions must stay operable (they wake on demand), closed
   * ones are gone for good.
   *
   * Every consumer that used to test `status === 'closed'` to mean "unusable"
   * should test `status === 'closed' && !isDormant` instead.
   *
   * Deliberately NOT a `derived(status === 'closed' && phase === 'connected')`:
   * `close()` sets the status before it moves the phase, and the phase is not
   * observable, so such a derived would latch `true` for that frame with
   * nothing left to ever invalidate it — the session would look dormant
   * forever. The four explicit write sites (idle seal sets it; attach, close and
   * the start of a reconnect clear it) keep the invariant locally checkable
   * instead.
   */
  get isDormant(): IObservable<boolean> {
    return this._dormant
  }

  /**
   * Bring a dormant session's agent process back if it is gone, without
   * waiting. The single source of truth for "is this connection dead?" —
   * {@link sendPrompt} and {@link ensureAwake} both route through it so the
   * detection never drifts into two copies.
   *
   * Recognises both dead-lease shapes: the idle seal (phase still `'connected'`
   * with an aborted signal) and an exhausted/cancelled recovery episode (phase
   * `'failed'`). Parking the session via `_handleConnectionLost` returns it to
   * `connecting` — prompts queue, the service re-handshakes, and the attach
   * flush dispatches them. A user-initiated `close()` (phase `'closed'`) is
   * never revived; a startup failure has no durable id to resume against and
   * keeps its existing behaviour.
   */
  private _wakeIfDormant(): void {
    if (this._reconnecting || this.readOnly) return
    if (this.sessionIdOnAgent.get() === undefined) return
    const phase = this._connection.phase
    if ((phase === 'connected' && this._conn?.conn.signal.aborted === true) || phase === 'failed') {
      this._handleConnectionLost('wake')
    }
  }

  /**
   * Ensure the agent process is up, awaiting the re-handshake when one is
   * needed. The entry point for every explicit user action that needs a live
   * connection (fork a side chat, rewind, switch model, redeem a reset
   * credit, …) — see the "wake tiers" table in this directory's CLAUDE.md for
   * which operations should call this and which deliberately must not.
   *
   * The four outcomes are all load-bearing:
   * - `ready`     — connected, go ahead.
   * - `closed`    — the user closed this session; fail silently.
   * - `failed`    — the wake itself failed (reconnect exhausted); surface it.
   * - `connecting`— a handshake is STILL in flight after the one we awaited,
   *                 i.e. the connection was lost again during the wake. Not a
   *                 failure: the caller should treat the operation as deferred
   *                 (its optimistic local effect stands and flushes on attach)
   *                 rather than reporting an error.
   *
   * A first handshake in flight IS awaited here, so callers that must never
   * block on a 10s spawn have to check before calling — `setConfigOption` keeps
   * a synchronous fast path for exactly that reason.
   *
   * Concurrent callers share one reconnect: the first parks the session, the
   * rest short-circuit on `_reconnecting` and await the same re-armed gate.
   */
  async ensureAwake(): Promise<AcpSessionAwakeOutcome> {
    this._wakeIfDormant()
    if (this._connection.phase === 'connecting') await this.whenConnected()
    switch (this._connection.phase) {
      case 'connected':
        return 'ready'
      case 'closed':
        return 'closed'
      case 'failed':
        // A wake that failed leaves the session `errored` with a manual-retry
        // affordance; a session closed mid-wake settled its gate through
        // close() and is simply gone.
        return this.status.get() === 'closed' ? 'closed' : 'failed'
      default:
        return 'connecting'
    }
  }

  /** Auto-recovery state (retry / reconnect progress) for the UI; undefined when healthy. */
  get recoveryState(): IObservable<AcpRecoveryState | undefined> {
    return this.recovery.state
  }

  /** True while a hot-reconnect is in progress — the service's recovery loop gates on this. */
  get isReconnecting(): boolean {
    return this._reconnecting
  }

  /** Wall-clock of the last inbound update or outbound dispatch — read by the stall watchdog. */
  get lastActivityAt(): number {
    return this._lastActivityAt
  }

  /**
   * True while a compaction card sits in its `running` phase. Read by the
   * stall watchdog: the fork reports compaction lifecycle through
   * ext-notifications (no streamed text on the wire while it runs), so a
   * compaction — however long — is expected silence, not a wedged turn.
   */
  get compactionInProgress(): boolean {
    return this._timeline.some(
      (it) => it.kind === 'compaction' && it.compaction.phase === 'running',
    )
  }

  /**
   * True while the agent runs an autonomous follow-up turn (background-task
   * wakeup). Read by the stall watchdog: such a turn occupies no prompt RPC,
   * so the watchdog's silence window must not fire on it.
   */
  get autonomousTurnActive(): boolean {
    return this._autonomousTurnActive
  }

  /**
   * Background-activity snapshot from the agent (`_universe/background_activity`).
   * Background tasks outlive the prompt RPC that spawned them; an autonomous
   * turn never has one. Both feed the status derivation so the session doesn't
   * read as "finished" while out-of-band work is still going. No-op once closed
   * (a snapshot landing after close() must not resurrect anything).
   */
  applyBackgroundActivity(params: { backgroundTasks: number; autonomousTurn: boolean }): void {
    if (this.status.get() === 'closed') return
    this._lastActivityAt = Date.now() // the notification itself is proof of life
    this.backgroundTaskCount.set(params.backgroundTasks, undefined)
    this._autonomousTurnActive = params.autonomousTurn
    this._recomputeStatus()
  }

  /** Drop the background-activity inputs on any connection teardown path. */
  private _resetBackgroundActivity(): void {
    this._autonomousTurnActive = false
    this.backgroundTaskCount.set(0, undefined)
  }

  /**
   * The agent process died (or was declared stalled, or threw internally
   * mid-turn) while this session was live. Instead of sealing, park the
   * session back in `connecting`: the timeline is kept, in-flight prompts are
   * aborted, new prompts queue, and the service is notified to re-handshake
   * in place.
   */
  private _handleConnectionLost(reason: 'crash' | 'stalled' | 'restart' | 'wake'): void {
    if (this._reconnecting) return
    this._reconnecting = true
    // Reconnecting IS activity. Without this bump a session woken from the idle
    // reaper carries a stale `lastActivityAt`, so the very next watchdog tick
    // (≤60s) reclaims it again — the user sees "I opened it and it went straight
    // back to sleep". Re-armed here, a woken session gets the full idle grace
    // period; with no further interaction it is reclaimed again as usual.
    this._lastActivityAt = Date.now()
    // Leaving the asleep state (see {@link isDormant}): from here on the session
    // is actively re-handshaking, not waiting to be woken.
    this._dormant.set(false, undefined)
    const deadLease = this._conn
    // Captured before _cancelPending settles the cards — after it, both
    // observables read undefined and the pending state is unrecoverable.
    const hadPendingInteraction =
      this.pendingElicitation.get() !== undefined || this.pendingPermission.get() !== undefined
    this._commitBatchedTx()
    this._finalizeRunningSegment()
    this._cancelPending()
    this._turnInterrupted = this._inFlight.size > 0
    this._interruptedWithPendingInteraction = hadPendingInteraction
    this._abortAllInFlight()
    this._resetBackgroundActivity()
    this._sawError = false
    this._connection.beginReconnect()
    // Return the dead lease to the pool. The pool entry is already evicted on
    // crash; on stall the service kills it explicitly before reconnecting.
    deadLease?.dispose()
    this.status.set('connecting', undefined)
    this.recovery.set({
      phase: 'reconnecting',
      attempt: 1,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
      reason,
    })
    this._telemetry.publicLog('acp.session_connection_lost', {
      agentId: this.agentId,
      reason,
      interrupted: this._turnInterrupted,
      pendingInteraction: hadPendingInteraction,
    })
    this._onDidLoseConnection.fire({ reason })
  }

  /** Watchdog entry point: the turn went silent past the stall threshold. */
  handleStall(): void {
    if (this.status.get() === 'closed' || this.readOnly || this._reconnecting) return
    // A pending question/permission card means the silence is the user thinking,
    // not a wedged turn. The service-level watchdog already skips these; guard
    // here too so future callers can't bypass the exemption. A running
    // compaction is likewise expected silence (its lifecycle travels via
    // ext-notifications, never session/update) — and so is an autonomous
    // follow-up turn, which holds no in-flight prompt RPC at all.
    if (this.pendingElicitation.get() !== undefined) return
    if (this.pendingPermission.get() !== undefined) return
    if (this.compactionInProgress) return
    if (this._autonomousTurnActive && this._inFlight.size === 0) return
    this._handleConnectionLost('stalled')
  }

  /**
   * User-driven: respawn the agent process, keeping this session's history and
   * runtime config (the service resumes against the same durable id and pushes
   * the config back). Needed because the sub-agent model travels as spawn env —
   * a live process can never see a new value.
   *
   * The caller must have finished persisting whatever env change it wants
   * picked up; the fresh process reads settings.json as it spawns.
   */
  requestProcessRestart(): void {
    if (this.readOnly || this._reconnecting) return
    if (this.sessionIdOnAgent.get() === undefined) return
    // A dormant session restarts too: its process is already gone, so the
    // reconnect spawns a fresh one that reads the new setting — which is the
    // whole point of the request. Only a session the user actually closed
    // (phase 'closed') stays terminal.
    if (this.status.get() === 'closed' && !this._dormant.get()) return
    this._handleConnectionLost('restart')
  }

  /**
   * Service-driven: bind the fresh connection after a successful hot-reconnect
   * (`session/resume` against the same durable id — no history replay, the
   * timeline is already complete locally).
   *
   * `sessionIdOnAgent` re-keys the session onto a NEW durable id: an EMPTY
   * session (never messaged) has no agent-side transcript to resume, so the
   * service rebuilds it with `session/new` and the agent issues a fresh id. The
   * local session object — and therefore the editor tab, draft and React key —
   * is deliberately kept; only the protocol-side id moves.
   */
  reattachConnection(conn: IAcpClientConnection, sessionIdOnAgent?: string): void {
    const sid = sessionIdOnAgent ?? this.sessionIdOnAgent.get()
    if (sid === undefined || this.status.get() === 'closed') {
      conn.dispose()
      return
    }
    const prior = this.sessionIdOnAgent.get()
    if (prior !== undefined && prior !== sid) {
      this._priorAgentSessionIds.delete(prior)
      this._priorAgentSessionIds.add(prior)
      // Set iteration is insertion-ordered, so the first key is the oldest.
      while (this._priorAgentSessionIds.size > MAX_PRIOR_AGENT_SESSION_IDS) {
        const oldest = this._priorAgentSessionIds.values().next().value
        if (oldest === undefined) break
        this._priorAgentSessionIds.delete(oldest)
      }
    }
    this.attachConnection(conn, sid)
  }

  /** True when `sessionId` is a durable id this session used to be known by. */
  hasPriorAgentSessionId(sessionId: string): boolean {
    return this._priorAgentSessionIds.has(sessionId)
  }

  /** Durable ids this session carried before a rebuild (see {@link _priorAgentSessionIds}). */
  get priorAgentSessionIds(): ReadonlySet<string> {
    return this._priorAgentSessionIds
  }

  /**
   * Resolves once every queued configOption push-back has landed on the agent.
   * The hot-reconnect path awaits this before resuming the interrupted turn:
   * the rebuilt agent session starts from settings.json defaults, so the
   * re-asserted mode/model must be in effect before the continuation prompt
   * dispatches, or the turn runs under the reset config.
   */
  async whenConfigOptionsSettled(): Promise<void> {
    await this._configOptions.flushPendingPushes()
  }

  /**
   * Service-driven, after a successful reattach: resume the turn that was
   * in-flight when the connection died. Zero-output turns resend the original
   * prompt verbatim (nothing reached the agent's transcript, or the model
   * never saw it); turns with partial output get a continuation prompt so the
   * agent transcript isn't polluted with a duplicate user message.
   */
  async continueInterruptedTurn(): Promise<void> {
    if (!this._turnInterrupted) return
    this._turnInterrupted = false
    const withPendingInteraction = this._interruptedWithPendingInteraction
    this._interruptedWithPendingInteraction = false
    if (this.status.get() === 'closed') return
    const last = this._lastDispatch
    if (last !== undefined && this._agentOutputCount === last.outputBaseline) {
      await this._dispatchPrompt(last.text, last.refs, last.contexts, last.images, last.messageId)
      return
    }
    // A pending question/permission was settled as cancelled by the disconnect;
    // a bare "继续" reads as "the user skipped it", so tell the agent the card
    // was aborted by the interruption and it should re-ask instead.
    const text = withPendingInteraction ? recoveryContinuePromptText() : CONTINUE_PROMPT_TEXT
    const messageId = generateUuid()
    this._appendMessage('user', text, [], messageId, { autoRetry: true })
    await this._dispatchPrompt(text, [], [], [], messageId)
  }

  /**
   * Service-driven: automatic reconnect attempts ran out. Seal the (dead)
   * connection so queued prompts reject, surface the error, and park in
   * `errored` — the UI offers a manual reconnect via {@link retryRecovery}.
   */
  sealRecoveryFailure(message: string): void {
    this._reconnecting = false
    this._turnInterrupted = false
    this._interruptedWithPendingInteraction = false
    this._resetBackgroundActivity()
    this.recovery.set({
      phase: 'exhausted',
      attempt: MAX_RECOVERY_ATTEMPTS,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
      reason: 'reconnect',
    })
    this._connection.fail(message)
    this._appendMessage('agent', `[error] ${message}`)
    // Reconnect ran out — no restarted compaction is coming to merge the orphan.
    this._settleOrphanCompactions('reconnect failed')
    if (this.status.get() !== 'closed') this.status.set('errored', undefined)
  }

  /**
   * User cancelled the pending automatic attempt (RecoveryBar 取消). Wakes the
   * sleeping retry loop, which settles the turn as cancelled. When reconnecting,
   * seals the dead connection so the session settles to `errored` instead of
   * hanging in `connecting` forever.
   */
  cancelRecovery(): void {
    this.recovery.cancelPending()
    this.recovery.clear()
    if (this._reconnecting) {
      this._reconnecting = false
      this._turnInterrupted = false
      this._interruptedWithPendingInteraction = false
      this._resetBackgroundActivity()
      this._connection.fail('reconnect cancelled')
      this._settleOrphanCompactions('cancelled')
      if (this.status.get() !== 'closed') this.status.set('errored', undefined)
    }
  }

  /**
   * Manual retry from the `exhausted` state: re-dispatch the failed prompt when
   * the connection is alive, or re-run the reconnect when it is dead.
   */
  async retryRecovery(): Promise<void> {
    if (this.recovery.state.get()?.phase !== 'exhausted') return
    if (this._failedPrompt !== undefined) {
      // The connection may have died while the session sat in `exhausted`
      // (idle seal keeps the dead lease bound, phase still 'connected').
      // Re-dispatching onto it would reproduce the same dead-end this manual
      // retry was meant to escape, so hot-reconnect instead; the failed
      // prompt is `_lastDispatch`, and continueInterruptedTurn re-sends it
      // (same messageId when the turn produced no output).
      if (this._connection.phase === 'connected' && this._conn?.conn.signal.aborted === true) {
        this._failedPrompt = undefined
        this.recovery.clear()
        this._handleConnectionLost('crash')
        // Assigned AFTER the call: _handleConnectionLost derives the flag from
        // the (empty) in-flight set and would overwrite this with false.
        this._turnInterrupted = true
        return
      }
      const failed = this._failedPrompt
      this._failedPrompt = undefined
      this.recovery.clear()
      await this._dispatchPrompt(
        failed.text,
        failed.refs,
        failed.contexts,
        failed.images,
        failed.messageId,
      )
      return
    }
    this.recovery.clear()
    this._handleConnectionLost('crash')
  }

  beginHistoryReplay(): void {
    this.isReplayingHistory.set(true, undefined)
    this._replayIngestedBytes = 0
    this._replayOverflow = false
  }

  endHistoryReplay(): void {
    this._suppressReplayToTimeline = false
    this._suppressAnchorMessageId = undefined
    this.isReplayingHistory.set(false, undefined)
    if (this._replayOverflow) {
      this._replayOverflow = false
      this._appendMessage('agent', replayHistoryOverflowNotice())
    }
  }

  suppressReplayToTimeline(anchorMessageId?: string): void {
    this._suppressReplayToTimeline = true
    this._suppressAnchorMessageId = anchorMessageId
  }

  setRetractedMessageIds(ids: readonly string[] | undefined): void {
    this._retractedMessageIds.clear()
    for (const id of ids ?? []) this._retractedMessageIds.add(id)
  }

  private _flushQueuedPrompts(queued: readonly QueuedPrompt[]): void {
    for (const q of queued) {
      this._dispatchPrompt(q.text, q.refs, q.contexts, q.images, q.messageId).then(
        q.resolve,
        q.reject,
      )
    }
  }

  get configOptions(): IObservable<readonly SessionConfigOption[]> {
    return this._configOptions.configOptions
  }

  cycleCollapseMode(): void {
    const cur = this.collapseMode.get()
    const next: CollapseMode =
      cur === 'default' ? 'collapsed' : cur === 'collapsed' ? 'expanded' : 'default'
    this.collapseMode.set(next, undefined)
  }

  /**
   * Apply a bag of init state from `session/new` / `session/load`. Idempotent
   * — used by both the constructor and `resumeSession` after the load returns.
   */
  applyInitState(state: IAcpSessionInitState): void {
    if (state.configOptions) {
      this._configOptions.applyInitState(state.configOptions)
    }
    // Seed the usage arc from a restored snapshot, but never clobber a live
    // value already reported in this session.
    if (state.usage !== undefined && this.usage.get() === undefined) {
      this.usage.set(state.usage, undefined)
    }
    // Seed the plan bar from a restored snapshot, but never clobber a live
    // plan already emitted in this session (replay updates are last-wins).
    if (state.plan !== undefined && state.plan.length > 0 && this.plan.get().length === 0) {
      this.plan.set(state.plan, undefined)
    }
    // Seed the MCP server list from config (status `pending`) so the panel shows
    // configured servers before the SDK init snapshot arrives. Don't clobber a
    // snapshot already applied.
    if (state.mcpServers && state.mcpServers.length > 0 && this.mcpServers.get().length === 0) {
      this.mcpServers.set(
        state.mcpServers.map((s) => ({ name: s.name, status: 'pending', transport: s.transport })),
        undefined,
      )
    }
    if (state.accumulatedRunningMs !== undefined && this.accumulatedRunningMs.get() === 0) {
      this.accumulatedRunningMs.set(state.accumulatedRunningMs, undefined)
    }
    // Editor-local state (restored whitelist), not a protocol echo — always apply.
    if (state.mcpServerSelection !== undefined) {
      this.mcpServerSelection.set(
        state.mcpServerSelection === null ? null : [...state.mcpServerSelection],
        undefined,
      )
    }
  }

  /**
   * Refresh connection status from an agent status snapshot (claude: SDK
   * system-init `mcp_servers: { name, status }[]`; codex: the fork's
   * `_universe/mcp_server_status` notification). Merges onto the config-seeded
   * list, preserving the known transport; servers present only in the snapshot
   * are appended with no transport.
   */
  applyMcpServerSnapshot(servers: ReadonlyArray<{ name: string; status: string }>): void {
    const prev = this.mcpServers.get()
    const byName = new Map(prev.map((s) => [s.name, s]))
    const next: AcpMcpServerStatus[] = []
    const seen = new Set<string>()
    for (const s of servers) {
      seen.add(s.name)
      const existing = byName.get(s.name)
      next.push(
        existing?.transport !== undefined
          ? { name: s.name, status: s.status, transport: existing.transport }
          : { name: s.name, status: s.status },
      )
    }
    // Keep config-seeded servers the snapshot didn't mention (e.g. dropped by
    // capability gating, or an agent that doesn't report them).
    for (const s of prev) {
      if (!seen.has(s.name)) next.push(s)
    }
    this.mcpServers.set(next, undefined)
  }

  presentPermission(p: AcpPendingPermission): void {
    // Replace any prior pending request — only one card at a time per session.
    this._cancelPendingPermission()
    this.pendingPermission.set(p, undefined)
  }

  presentElicitation(e: AcpPendingElicitation): void {
    // Replace any prior pending elicitation — only one card at a time.
    this._cancelPendingElicitation()
    this.pendingElicitation.set(e, undefined)
  }

  private _cancelPendingPermission(): void {
    const cur = this.pendingPermission.get()
    if (cur) {
      this.pendingPermission.set(undefined, undefined)
      cur.cancel()
    }
  }

  private _cancelPendingElicitation(): void {
    const cur = this.pendingElicitation.get()
    if (cur) {
      this.pendingElicitation.set(undefined, undefined)
      cur.cancel()
    }
  }

  private _cancelPending(): void {
    this._cancelPendingPermission()
    this._cancelPendingElicitation()
  }

  async sendPrompt(
    text: string,
    refs?: readonly PlacedRef[],
    contexts?: readonly SelectionContext[],
    images?: readonly PromptImage[],
  ): Promise<void> {
    // Read-only preview session (foreign worktree): viewing only, no dispatch.
    if (this.readOnly) return
    // A fresh user prompt supersedes an exhausted recovery episode (its manual
    // retry is no longer relevant) — but never an in-flight retry/reconnect.
    if (this.recovery.state.get()?.phase === 'exhausted') {
      this._failedPrompt = undefined
      this.recovery.clear()
    }
    this._maybeDeriveTitleFromPrompt(text)
    this._maybeRecordFirstPrompt(text)
    this._rememberDispatchedPrompt(text)
    // Client-generated anchor for this user turn. Stamped on the local message
    // now (so rewind/fork can target it even before dispatch) and sent as
    // `_meta.messageId`; the agent echoes it back as `_meta.userMessageId`.
    const messageId = generateUuid()
    // Side tasks: pin this id as the replay boundary on the history row so a
    // later re-open can drop the forked baseline but keep the side task's own
    // turns (from this first prompt on). Write-once on the service side.
    const sidForAnchor = this.sessionIdOnAgent.get()
    let isSideTaskFirstTurn = false
    if (sidForAnchor !== undefined) {
      const row = this._history?.get(sidForAnchor)
      if (row?.sideTaskOf !== undefined) {
        if (row.sideTaskAnchorMessageId === undefined) {
          isSideTaskFirstTurn = true
          this._history?.setSideTaskAnchorMessageId(sidForAnchor, messageId)
        }
      }
    }
    // Always surface the user's message immediately, even while connecting, so
    // typing feels instant. The wire dispatch is deferred until the connection
    // is ready (queued) so the prompt is not lost.
    this._appendMessage('user', text, composeImageBlocks(images ?? []), messageId, {
      selectionContexts: contexts ?? [],
    })
    void this._maybeGenerateTitle(text)
    // Re-handshake on demand: the agent process died while the session sat
    // idle (the idle close path sealed the status but kept the dead lease
    // bound, phase still 'connected'), or an earlier reconnect exhausted / was
    // cancelled and the user typed a new prompt instead of the recovery bar's
    // Retry. The parked session queues this prompt; the service re-handshakes
    // and the attach flush dispatches it. Detection lives in one place so it
    // can't drift from the explicit-operation path (see {@link ensureAwake}).
    this._wakeIfDormant()
    // Still connecting — buffer the prompt; the returned promise settles when it
    // is eventually dispatched (on connect) or rejected (on connection failure).
    if (!this._connection.isSettled) {
      try {
        await this._connection.enqueue(text, refs ?? [], contexts ?? [], images ?? [], messageId)
      } catch {
        // Connection failed before this queued prompt could be dispatched. The
        // failure is already surfaced as an [error] timeline message by
        // failConnection; swallow here so fire-and-forget callers (PromptInput)
        // don't see an unhandled rejection.
      }
      return
    }
    // Connection failed during startup — nothing to dispatch onto.
    if (this._conn === undefined) return
    await this._dispatchPrompt(
      text,
      refs ?? [],
      contexts ?? [],
      images ?? [],
      messageId,
      isSideTaskFirstTurn ? SIDE_TASK_ROLE_PROMPT : undefined,
    )
  }

  /**
   * Send one prompt over the (already-attached) connection. Assumes
   * `this._conn` / `sessionIdOnAgent` are set — only called post-attach (direct
   * dispatch or queue flush). Does NOT append the user message; the caller
   * (`sendPrompt`) already did so the message shows immediately even while the
   * prompt was queued.
   *
   * `hiddenLeadBlock` is an instruction prepended to the wire blocks but never
   * shown in the UI — used to slip the side-task role prompt into its first
   * turn (see SIDE_TASK_ROLE_PROMPT). Left undefined for ordinary prompts and
   * for the auto-continue / queue-flush paths.
   */
  private async _dispatchPrompt(
    text: string,
    refs: readonly PlacedRef[],
    contexts: readonly SelectionContext[],
    images: readonly PromptImage[],
    messageId: string,
    hiddenLeadBlock?: string,
  ): Promise<void> {
    const conn = this._conn
    const sid = this.sessionIdOnAgent.get()
    if (conn === undefined || sid === undefined) return
    // Bump the history entry's lastUsedAt so the LRU order tracks user activity.
    // Synchronous on purpose: callers (and tests) observe the new order right
    // after sendPrompt returns, before any awaited persistence below.
    this._history?.touch(sid)
    this._history?.setHistoryHasMessages(sid)
    // The local message can be rendered while session/new is still pending.
    // Once a durable id exists, persist the same send-time snapshot so a later
    // session/load can attach it to the matching user message.
    try {
      await this._messageAttachments?.initialize()
      this._messageAttachments?.saveSelections(sid, messageId, contexts)
    } catch {
      // Best-effort persistence must never prevent the prompt from being sent.
    }
    const prompt = composePromptBlocksFromRefs(text, refs)
    // Attached selections lead the prompt as context blocks (EmbeddedResource
    // when the agent supports it, else a fenced-code text block).
    const contextBlocks = composeContextBlocks(contexts, this._embeddedContextSupported)
    // Attached images lead the prompt as `image` ContentBlocks (after any
    // selection context, before the user's text).
    const imageBlocks = composeImageBlocks(images)
    const body = prompt.length > 0 ? [...prompt] : [{ type: 'text' as const, text }]
    // A hidden role instruction (side task's first turn) leads everything so the
    // model reads it before any selection context, image, or user text.
    const hiddenBlocks: readonly ContentBlock[] =
      hiddenLeadBlock !== undefined ? [{ type: 'text' as const, text: hiddenLeadBlock }] : []
    const params: PromptRequest = {
      sessionId: sid,
      // The client-generated anchor for this user turn so rewind/fork can later
      // target this exact turn. Travels only in `_meta` — SDK 1.x dropped the
      // unstable top-level `messageId` from `PromptRequest`, and both built-in
      // forks read it from `_meta.messageId`.
      _meta: { messageId },
      // Fall back to a single text block for empty/no-mention prompts so we
      // keep the wire shape stable even for trivial cases.
      prompt: [...hiddenBlocks, ...contextBlocks, ...imageBlocks, ...body],
    }
    // Debug the exact block shapes sent to the agent — references (esp. symbols)
    // are lossy across the ACP boundary, so this makes context bugs diagnosable.
    console.debug(
      '[acp-prompt] dispatch',
      params.prompt.map((b) =>
        b.type === 'text' ? { type: 'text', text: b.text } : { type: b.type },
      ),
    )
    const abort = new AbortController()
    this._inFlight.add(abort)
    // Outbound dispatch counts as activity too: the stall watchdog measures
    // silence from here, not from the previous turn's last inbound update —
    // otherwise the first prompt after a >stall-timeout idle gap is declared
    // stalled on the next tick and the shared agent process gets killed.
    this._lastActivityAt = Date.now()
    // Status is derived from the in-flight set — never set directly per prompt,
    // so N concurrent steering prompts stay 'running' until the last settles.
    this._recomputeStatus()
    this._telemetry.publicLog('acp.prompt_sent', { sessionId: sid })
    const snapshot: PromptSnapshot = {
      text,
      refs,
      contexts,
      images,
      messageId,
      sentMessageId: messageId,
      outputBaseline: this._agentOutputCount,
    }
    this._lastDispatch = snapshot
    try {
      await this._sendWithRecovery(conn, params, abort, snapshot)
    } finally {
      this._inFlight.delete(abort)
      // Only flush once the last in-flight prompt settles — flushing mid-turn
      // would clear the streaming caret while another prompt is still emitting
      // chunks, splitting its output into a fresh card.
      if (this._inFlight.size === 0) this._flushStream()
      // All prompts settled without a cancel — the stashed submitted draft is
      // stale (its turn completed), drop it so it can't resurface on a later
      // cancel. Aborted prompts keep the stash for cancelTurn's restore event.
      if (this._inFlight.size === 0 && !abort.signal.aborted) {
        AcpPromptCancelledDraftStash.clear(this.id)
      }
      this._recomputeStatus()
    }
  }

  /**
   * Send one wire prompt with automatic retry on transient failures (429 /
   * overloaded / 5xx / dropped stream — see classifyAcpError). Between attempts
   * the prompt stays in-flight (status keeps `running`) and the recovery state
   * counts down for the UI. A turn that produced partial output is continued
   * (`继续`) rather than resent, so the agent transcript never duplicates the
   * user turn; a zero-output turn is resent verbatim with the same messageId.
   * An agent-internal crash (`agent_crash`) cannot be retried in place — it
   * diverts to the hot-reconnect path, which resumes this turn after reattach.
   * Non-transient errors and exhausted retries fall back to the classic
   * `[error]` timeline message (+ `errored` status), keeping the prompt
   * snapshot for the UI's manual-retry affordance.
   */
  private async _sendWithRecovery(
    conn: IAcpClientConnection,
    params: PromptRequest,
    abort: AbortController,
    snapshot: PromptSnapshot,
  ): Promise<void> {
    const sid = params.sessionId
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new AcpAbortError())
      if (abort.signal.aborted) onAbort()
      else abort.signal.addEventListener('abort', onAbort, { once: true })
    })
    let attempt = 1
    let continued = false
    let currentMessageId = snapshot.messageId
    for (;;) {
      let failure: Error | undefined
      try {
        const response = await Promise.race([conn.conn.prompt(params), abortPromise])
        this._reconcileUserMessageId(currentMessageId, response)
        this._ingestPromptResponse(response)
        // A success after automatic retries ends the recovery episode.
        if (this.recovery.state.get()?.phase === 'retrying') this.recovery.clear()
        // The compaction settle notification precedes turn completion in the
        // vendor's stream, so a slot still running here lost its settle — stop
        // the card from spinning forever.
        this._settleOrphanCompactions('interrupted')
        return
      } catch (err) {
        if (err instanceof AcpAbortError) {
          this._telemetry.publicLog('acp.prompt_cancelled', { sessionId: sid })
          // A reconnect aborts in-flight prompts too, but that path is an
          // interruption, not a cancellation: the orphan compaction must stay
          // `running` so the restarted compaction's `start` can merge it.
          if (!this._reconnecting) this._settleOrphanCompactions('cancelled')
          return
        }
        failure = err as Error
      }
      const verdict = classifyAcpError(failure)
      const retryable =
        verdict.cls === 'transient' &&
        attempt < MAX_RECOVERY_ATTEMPTS &&
        // The connection must be the one this dispatch started on: a crash
        // mid-backoff swaps `_conn`, and the reconnect path owns continuation.
        this._conn === conn &&
        !this._reconnecting
      if (retryable) {
        attempt++
        if (!continued && this._agentOutputCount !== snapshot.outputBaseline) {
          continued = true
          const continueId = generateUuid()
          currentMessageId = continueId
          this._appendMessage('user', CONTINUE_PROMPT_TEXT, [], continueId, { autoRetry: true })
          params = {
            sessionId: sid,
            _meta: { messageId: continueId },
            prompt: [{ type: 'text', text: CONTINUE_PROMPT_TEXT }],
          }
        }
        const delay = recoveryBackoffMs(attempt)
        this.recovery.set({
          phase: 'retrying',
          attempt,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          reason: verdict.kind ?? 'transient',
          nextAttemptAt: Date.now() + delay,
        })
        this._telemetry.publicLog('acp.prompt_retry', {
          sessionId: sid,
          attempt,
          kind: verdict.kind ?? 'transient',
        })
        try {
          // Aborts (Stop / cancelTurn) and recovery cancels both wake the sleep.
          await Promise.race([this.recovery.sleep(delay), abortPromise])
        } catch {
          this._telemetry.publicLog('acp.prompt_cancelled', { sessionId: sid })
          // Same guard as the abort branch above: a mid-backoff reconnect owns
          // the orphan compaction, don't settle it here.
          if (!this._reconnecting) this._settleOrphanCompactions('cancelled')
          return
        }
        continue
      }
      if (
        verdict.cls === 'agent_crash' &&
        this._conn === conn &&
        !this._reconnecting &&
        this.status.get() !== 'closed'
      ) {
        // The agent threw internally (SDK-wrapped bare exception) but the
        // connection survived — the close listener therefore never fires, and
        // `_abortAllInFlight` below has already settled this prompt, so nothing
        // else would ever start recovery. A crashed agent's session state is
        // untrustworthy: hot-reconnect (fresh spawn + session/resume) like a
        // process death, then continueInterruptedTurn resumes this turn.
        this._appendMessage('agent', `[error] ${failure.message}`)
        this._telemetry.publicLogError('acp.prompt_agent_crash', {
          sessionId: sid,
          error: failure.message,
        })
        this._handleConnectionLost('crash')
        return
      }
      this._sawError = true
      this._appendMessage('agent', `[error] ${failure.message}`)
      if (verdict.cls === 'transient') {
        // Retries exhausted — keep the (possibly continuation-switched) prompt
        // so the UI can offer a manual retry from the recovery bar.
        this._failedPrompt = {
          text: continued ? CONTINUE_PROMPT_TEXT : snapshot.text,
          refs: continued ? [] : snapshot.refs,
          contexts: continued ? [] : snapshot.contexts,
          images: continued ? [] : snapshot.images,
          messageId: currentMessageId,
          sentMessageId: snapshot.sentMessageId,
          outputBaseline: this._agentOutputCount,
        }
        this.recovery.set({
          phase: 'exhausted',
          attempt,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          reason: verdict.kind ?? 'transient',
        })
      }
      this._telemetry.publicLogError('acp.prompt_failed', {
        sessionId: sid,
        error: failure.message,
      })
      this._settleOrphanCompactions('turn failed')
      if (isAuthRequiredError(failure)) this._onDidRequireAuth.fire()
      return
    }
  }

  async cancelTurn(options?: { readonly restorePrompt?: boolean }): Promise<void> {
    const conn = this._conn
    const sid = this.sessionIdOnAgent.get()
    const had = this._inFlight.size > 0
    if (conn !== undefined && sid !== undefined) {
      try {
        await conn.conn.cancel({ sessionId: sid })
      } catch {
        // swallow — cancel is best-effort
      }
    }
    // Snapshot before aborting: abort() synchronously triggers each prompt's
    // finally, which deletes from the live set.
    for (const a of [...this._inFlight]) a.abort()
    // Zero-output turn: the stashed submitted draft survives the abort (the
    // catch branch in _sendWithRecovery never clears it); PromptInput drains it
    // on this event and restores it into the input box for edit-and-retry. The
    // just-sent user message leaves the timeline with it — keeping both would
    // show the prompt the user is about to edit as if it had already been
    // answered. Once the agent has streamed any visible output the cancel is a
    // normal interruption instead: the partial turn stays and nothing is
    // restored or retracted.
    if (had && options?.restorePrompt !== false) {
      if (
        this._lastDispatch === undefined ||
        this._agentOutputCount === this._lastDispatch.outputBaseline
      ) {
        const retractedId = this._retractLastDispatchedUserMessage()
        // Persist the retraction: the turn stays in the agent transcript, so the
        // resume replay filters it back out via _retractedMessageIds.
        if (retractedId !== undefined && sid !== undefined) {
          this._retractedMessageIds.add(retractedId)
          this._history?.addRetractedMessageId(sid, retractedId)
          this._messageAttachments?.removeMessages(sid, [retractedId])
        }
        this._onDidCancelForRestore.fire()
      } else {
        // Normal interruption: the SDK writes an interruption-marker user row
        // into the transcript after the partial output, but the live stream
        // never delivers it — append it locally so the running session shows
        // the same trace a later resume will replay.
        this._appendMessage('user', INTERRUPTED_MARKER_TEXT)
      }
    }
  }

  /**
   * Pull the user message of the last dispatched prompt back off the timeline.
   * Keyed by the dispatch's own anchor id (not a continuation prompt's), so an
   * automatic-retry cancel retracts the synthetic 继续 message while the original
   * prompt stays; concurrent steering prompts retract only the latest (matching
   * the last-wins restore stash). Returns the retracted anchor id, or undefined
   * when no matching user message exists.
   */
  private _retractLastDispatchedUserMessage(): string | undefined {
    const sentMessageId = this._lastDispatch?.sentMessageId
    if (sentMessageId === undefined) return undefined
    const idx = this._messages.findIndex((m) => m.role === 'user' && m.messageId === sentMessageId)
    const retracted = idx === -1 ? undefined : this._messages[idx]
    if (retracted === undefined) return undefined
    this._messages = [...this._messages.slice(0, idx), ...this._messages.slice(idx + 1)]
    this._timeline = this._timeline.filter(
      (it) => !(it.kind === 'message' && it.id === retracted.id),
    )
    const tx = this._batchedTx()
    this.messages.set(this._messages, tx)
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
    return sentMessageId
  }

  /**
   * Rewind to an earlier user message (回退): roll back the agent's file edits
   * since that message AND truncate the conversation past it. Two-phase:
   *   1. Cancel any in-flight turn — a rewind mid-turn is nonsensical.
   *   2. Ask the agent (`REWIND_SESSION_METHOD`) to `rewindFiles` + recreate its
   *      Query truncated at the message, then replay the shortened history.
   * We reset the local timeline right before the call so the agent's replay
   * (delivered as `session/update` notifications during the ext-method) rebuilds
   * it cleanly instead of appending onto the stale tail. A `dryRun` skips the
   * reset and the file/conversation mutation, returning only the impact preview
   * so the UI can confirm the destructive action first. Returns `undefined` when
   * there's no live connection / agent-side session id, or for read-only previews.
   */
  async rewindTo(
    messageId: string,
    options?: { dryRun?: boolean; rewindFiles?: boolean },
  ): Promise<RewindFilesResult | undefined> {
    if (this.readOnly) return undefined
    const conn = this._conn
    const sid = this.sessionIdOnAgent.get()
    // A dead lease (idle reclaim) would reject every ext-method below. The
    // facade wakes the session before delegating here; this guard catches any
    // caller that bypasses it, failing the same way an unconnected session does
    // instead of surfacing a protocol error.
    if (conn === undefined || conn.conn.signal.aborted || sid === undefined) return undefined
    const dryRun = options?.dryRun === true
    // Keep the working-tree edits when the caller opted out of the file rollback
    // (保留修改并回退). Defaults to rolling files back.
    const keepFiles = options?.rewindFiles === false
    // When the agent doesn't roll files back itself (codex's `thread/rollback`
    // only truncates history — the protocol makes file rollback the client's
    // job), we revert files renderer-side via the change tracker. claude's
    // ext-method does both itself. Sourced from the fork's advertised capability.
    const filesAreClientSide = !this._filesRolledBackByAgent.get()

    // Snapshot the tool calls issued AFTER the rewind anchor *before* any reset
    // clears the timeline — those are the edits a codex file rollback un-applies.
    const postAnchorToolCallIds = filesAreClientSide ? this._toolCallIdsAfterMessage(messageId) : []
    const attachmentMessageIds = dryRun ? [] : this._userMessageIdsFrom(messageId)

    if (filesAreClientSide && dryRun) {
      // Preview: ask the agent whether it can truncate, and compute file impact
      // from the tracker (no disk writes). Merge into the RewindFilesResult shape.
      const raw = await conn.conn.extMethod(REWIND_SESSION_METHOD, {
        sessionId: sid,
        messageId,
        dryRun: true,
      })
      const canRewind = (raw as { canRewind?: boolean }).canRewind !== false
      const impact = await (this._changeTracker?.previewRestore(sid, postAnchorToolCallIds) ??
        Promise.resolve(undefined))
      return {
        canRewind,
        ...(impact
          ? {
              filesChanged: impact.filesChanged,
              insertions: impact.insertions,
              deletions: impact.deletions,
            }
          : {}),
      }
    }

    if (!dryRun) await this.cancelTurn({ restorePrompt: false })

    if (filesAreClientSide) {
      // Real rewind: roll files back first (unless the user kept edits), then ask
      // the agent to truncate + replay the shortened history.
      if (!keepFiles && this._changeTracker) {
        try {
          await this._changeTracker.restore(sid, postAnchorToolCallIds)
        } catch (err) {
          this._telemetry.publicLogError('acp.rewind_files_failed', {
            sessionId: sid,
            error: (err as Error).message,
          })
        }
      }
      this._resetForReplay()
      this.beginHistoryReplay()
      try {
        const raw = await conn.conn.extMethod(REWIND_SESSION_METHOD, {
          sessionId: sid,
          messageId,
        })
        const canRewind = (raw as { canRewind?: boolean }).canRewind !== false
        this._telemetry.publicLog('acp.rewind', {
          sessionId: sid,
          dryRun: false,
          keepFiles,
          canRewind,
        })
        if (canRewind) this._messageAttachments?.removeMessages(sid, attachmentMessageIds)
        return { canRewind }
      } catch (err) {
        this._telemetry.publicLogError('acp.rewind_failed', {
          sessionId: sid,
          error: (err as Error).message,
        })
        throw err
      } finally {
        this.endHistoryReplay()
      }
    }

    if (!dryRun) {
      this._resetForReplay()
      this.beginHistoryReplay()
    }
    try {
      const raw = await conn.conn.extMethod(REWIND_SESSION_METHOD, {
        sessionId: sid,
        messageId,
        ...(dryRun ? { dryRun: true } : {}),
        ...(keepFiles ? { rewindFiles: false } : {}),
      })
      const result = raw as unknown as RewindFilesResult
      // Files were actually rolled back — the tracker's baseline is now stale.
      // When the user kept their edits the files still reflect those changes, so
      // the tracker must stay intact for session diff to remain accurate.
      if (!dryRun && !keepFiles && result.canRewind !== false) this._changeTracker?.clear(sid)
      if (!dryRun && result.canRewind !== false) {
        this._messageAttachments?.removeMessages(sid, attachmentMessageIds)
      }
      this._telemetry.publicLog('acp.rewind', {
        sessionId: sid,
        dryRun,
        keepFiles,
        canRewind: result.canRewind !== false,
      })
      return result
    } catch (err) {
      this._telemetry.publicLogError('acp.rewind_failed', {
        sessionId: sid,
        error: (err as Error).message,
      })
      throw err
    } finally {
      if (!dryRun) this.endHistoryReplay()
    }
  }

  /**
   * Collect the tool-call ids issued at or after the user message `messageId`,
   * in timeline order. Used by the codex rewind path to know which file edits to
   * un-apply (the anchor message and everything after it is being removed). When
   * the anchor isn't found we return [] (nothing to roll back) rather than guess.
   */
  private _toolCallIdsAfterMessage(messageId: string): string[] {
    const timeline = this._timeline
    const anchorIdx = timeline.findIndex(
      (item) => item.kind === 'message' && item.message.messageId === messageId,
    )
    if (anchorIdx < 0) return []
    const ids: string[] = []
    for (let i = anchorIdx; i < timeline.length; i++) {
      const item = timeline[i]
      if (item?.kind === 'toolCall') ids.push(item.call.id)
    }
    return ids
  }

  /** User attachment records removed by a rewind: the anchor and all later turns. */
  private _userMessageIdsFrom(messageId: string): string[] {
    const anchorIdx = this._timeline.findIndex(
      (item) => item.kind === 'message' && item.message.messageId === messageId,
    )
    if (anchorIdx < 0) return []
    const ids: string[] = []
    for (let i = anchorIdx; i < this._timeline.length; i++) {
      const item = this._timeline[i]
      if (item?.kind !== 'message' || item.message.role !== 'user') continue
      if (item.message.messageId !== undefined) ids.push(item.message.messageId)
    }
    return ids
  }

  /**
   * Clear all streamed timeline state so a fresh history replay can repopulate
   * it from scratch (rewind). Mirrors the field resets in {@link close} but
   * keeps the session live and pushes the emptied observables out immediately.
   */
  private _resetForReplay(): void {
    this._commitBatchedTx()
    this._messages = []
    this._toolCalls = []
    this._timeline = []
    this._orphanChildren.clear()
    this._toolCallParent.clear()
    this._terminalOutput.clear()
    this._streamingIds.clear()
    this._planSeen = false
    this._liveIngestedBytes = 0
    this._setImmediate(this.messages, this._messages)
    this._setImmediate(this.toolCalls, this._toolCalls)
    this._setImmediate(this.timeline, this._timeline)
    this._setImmediate(this.plan, [])
    // Rewind truncates the conversation; clear the persisted plan mirror too
    // so the pre-rewind plan doesn't resurrect on the next restart. If the
    // replay re-emits a plan, the applyUpdate mirror writes it back.
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._history?.setHistoryPlan(sid, null)
  }

  private _recomputeStatus(): void {
    if (this.status.get() === 'closed') return // closed is terminal
    // Mid hot-reconnect the status is pinned to 'connecting' by the recovery
    // path; aborted in-flight prompts settling must not flip it to idle.
    if (this._reconnecting) return
    const prev = this.status.get()
    if (this._inFlight.size > 0 || this._autonomousTurnActive) {
      if (prev !== 'running') this.runningStartedAt.set(Date.now(), undefined)
      this.status.set('running', undefined)
      return
    }
    if (prev === 'running') this._finalizeRunningSegment()
    this.status.set(this._sawError ? 'errored' : 'idle', undefined)
    this._sawError = false
  }

  private _finalizeRunningSegment(): void {
    const started = this.runningStartedAt.get()
    if (started === undefined) return
    const accumulated = this.accumulatedRunningMs.get() + (Date.now() - started)
    this.accumulatedRunningMs.set(accumulated, undefined)
    this.runningStartedAt.set(undefined, undefined)
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._history?.setHistoryRunningDuration(sid, accumulated)
  }

  private _abortAllInFlight(): void {
    for (const a of [...this._inFlight]) a.abort()
    this._inFlight.clear()
  }

  /**
   * User-initiated rename. Ranks above the AI title: it flags the history row
   * `manualTitle` (protecting it from hydrate) and latches `_titleGenerated` so
   * a pending/future AI title generation can no longer overwrite it. Buffered +
   * re-applied on attach like any other title. No-op for read-only previews and
   * blank input.
   */
  renameTitle(title: string): void {
    if (this.readOnly) return
    const trimmed = title.trim().replace(/\s+/g, ' ')
    if (trimmed.length === 0) return
    // Stop any (in-flight or future) auto title from clobbering the user's choice.
    this._titleGenerated = true
    this._titleLocked = true
    this._setHistoryTitle(trimmed, 'manual')
  }

  /**
   * Mirror a title onto the durable history entry, keyed by the agent-issued id.
   * While the session is still connecting that id is undefined and the row does
   * not exist yet, so we buffer the title and re-apply it from
   * {@link attachConnection} once the entry is in place.
   *
   * `kind` marks the title's provenance. `'ai'` (model-generated) and `'manual'`
   * (user rename) are authoritative: they are flagged on the history row (so the
   * hydrate sweep won't clobber them with the agent's `summary`) and pushed back
   * to the agent via the set-title ext-method, so the title survives `/compact`
   * and the next `session/list`. `'derived'` (first prompt) is flagged locally
   * only — never pushed (see {@link _applyHistoryTitle}).
   */
  private _setHistoryTitle(title: string, kind: TitleKind): void {
    this._pendingTitle = title
    this._pendingTitleKind = kind
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._applyHistoryTitle(sid, title, kind)
  }

  /** Write the title to the history row and, for AI/manual titles, push it to the agent. */
  private _applyHistoryTitle(sessionIdOnAgent: string, title: string, kind: TitleKind): void {
    // AI / manual titles are authoritative — they must land even on rows already
    // flagged aiTitle/manualTitle/derivedTitle (e.g. a rename after the AI title).
    // A derived title is not: it never overwrites a protected row.
    const overwriteProtectedTitle = kind === 'ai' || kind === 'manual'
    this._history?.updateInfo(sessionIdOnAgent, { title }, { overwriteProtectedTitle })
    if (kind === 'ai') {
      this._history?.setHistoryAiTitle(sessionIdOnAgent)
      this._pushTitleToAgent(sessionIdOnAgent, title)
    } else if (kind === 'manual') {
      this._history?.setHistoryManualTitle(sessionIdOnAgent)
      this._pushTitleToAgent(sessionIdOnAgent, title)
    } else if (kind === 'derived') {
      // Local flag only: pushing a 30-char prompt slice as the agent's
      // `customTitle` would impersonate a user rename and, since customTitle
      // outranks aiTitle in the SDK summary chain, permanently suppress the
      // agent's own background title.
      this._history?.setHistoryDerivedTitle(sessionIdOnAgent)
    }
  }

  /**
   * Persist an AI / manual title onto the agent's durable store so it survives
   * `/compact` and is reported by `session/list` from other workspaces. Both the
   * Claude and Codex forks back this ext-method (Claude via `renameSession`,
   * Codex via `thread/name/set`). Best-effort + fire-and-forget: an agent that
   * doesn't implement it rejects with methodNotFound and we keep the local-only
   * title, which the `aiTitle`/`manualTitle` history flag still protects from
   * hydrate overwrites.
   *
   * A dormant session is deliberately NOT woken for this: spawning an agent
   * process just to record a title would undo the memory the idle reaper freed.
   * The title is already buffered in `_pendingTitle`, and `attachConnection`
   * replays it on the next attach — so the push simply happens whenever the
   * session naturally wakes.
   */
  private _pushTitleToAgent(sessionIdOnAgent: string, title: string): void {
    const conn = this._conn
    if (conn === undefined || conn.conn.signal.aborted) return
    void conn.conn
      .extMethod(SET_SESSION_TITLE_METHOD, { sessionId: sessionIdOnAgent, title })
      .catch(() => {
        // best-effort — unsupported agent or transient failure; local title stands.
      })
  }

  /**
   * Ride along on this session's existing connection to call a custom
   * ext-method. Returns `undefined` when nothing is connected — callers poll
   * agent-side state opportunistically and a stopped agent process is expected,
   * not an error. Never opens a connection: the pool reclaims idle agents 30s
   * after the last lease is released, and waking one to read a status would
   * undo that.
   */
  async requestExtMethod<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    const conn = this._conn
    if (conn === undefined || conn.conn.signal.aborted) return undefined
    const sessionIdOnAgent = this.sessionIdOnAgent.get()
    // Every ext-method we route this way is session-scoped. Sending one without
    // the agent-side id would make the agent reject it, and a caller that treats
    // rejection as "this agent can't do it" would draw the wrong conclusion from
    // what is really just the connecting window.
    if (sessionIdOnAgent === undefined) return undefined
    return (await conn.conn.extMethod(method, { sessionId: sessionIdOnAgent, ...params })) as T
  }

  private _maybeDeriveTitleFromPrompt(text: string): void {
    // Resumed sessions carry no title service (factory withTitleService: false)
    // and already have a durable title — deriving from a post-resume prompt
    // would clobber it.
    if (!this._history || !this._titleService) return
    if (this._titleLocked || this._titleDerived) return
    // Local built-in commands (`/model opus`) are throwaway turns: deriving a
    // title from one would pin the session name to a command artifact.
    if (isLocalCommandPrompt(text)) return
    const derived = stripLeadingBlockquote(text).replace(/\s+/g, ' ').slice(0, 30)
    if (derived.length === 0) return
    this._titleDerived = true
    this._setHistoryTitle(derived, 'derived')
  }

  /** Keep the newest {@link DISPATCHED_PROMPT_MEMORY} prompt texts for the title-echo guard. */
  private _rememberDispatchedPrompt(text: string): void {
    this._dispatchedPromptTexts.push(text)
    if (this._dispatchedPromptTexts.length > DISPATCHED_PROMPT_MEMORY) {
      this._dispatchedPromptTexts.shift()
    }
  }

  /**
   * Mirror the first content-bearing prompt onto the history row in full so the
   * session list's hover tooltip can show it even after the title has been
   * replaced by an AI/manual one. Same gating as the title derivation (no
   * local-command prompts, no quote-only prefills); write-once per session.
   */
  private _maybeRecordFirstPrompt(text: string): void {
    if (!this._history || !this._titleService) return
    if (this._firstPromptRecorded) return
    if (isLocalCommandPrompt(text)) return
    const source = stripLeadingBlockquote(text)
    if (source.length === 0) return
    this._firstPromptRecorded = true
    this._pendingFirstPrompt = source
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._applyHistoryFirstPrompt(sid, source)
  }

  private _applyHistoryFirstPrompt(sessionIdOnAgent: string, text: string): void {
    this._history?.setHistoryFirstPrompt(sessionIdOnAgent, text)
  }

  /**
   * Ask the session-title model for a friendly title from the first
   * content-bearing prompt, and overwrite the first-prompt-derived one. Skips
   * local built-in command prompts (their "args" are command parameters, not
   * user prose) without consuming the attempt; a generation that yields nothing
   * re-arms so the next prompt retries. Degrades silently.
   */
  private async _maybeGenerateTitle(userText: string): Promise<void> {
    if (this._titleGenerated) return
    if (!this._history || !this._titleService) return
    if (isLocalCommandPrompt(userText)) return
    const source = stripLeadingBlockquote(userText)
    // A prompt that is only a quote (the side-task prefill sent untouched)
    // carries no user prose to title from — skip without latching so the next
    // prompt still gets the one-shot generation.
    if (source.length === 0) return
    this._titleGenerated = true
    const agentText = this._messages.find((m) => m.role === 'agent')?.text ?? ''
    // Side tasks: the quote the chat was forked from is the actual subject — a
    // title generated from the bare question ("why is this wrong?") misses what
    // "this" is, so feed the excerpt along as context.
    const sid = this.sessionIdOnAgent.get()
    const row = sid !== undefined ? this._history.get(sid) : undefined
    const quotedText = row?.sideTaskOf !== undefined ? row.sideTaskQuote : undefined
    const title = await this._titleService.generateTitle(source, agentText, {
      ...(quotedText !== undefined ? { context: { quotedText } } : {}),
    })
    if (title === undefined) {
      // No model configured / unavailable, or an unusable response — let the
      // next prompt retry instead of permanently losing the AI title.
      this._titleGenerated = false
      return
    }
    if (this.status.get() === 'closed') return
    this._setHistoryTitle(title, 'ai')
  }

  async close(): Promise<void> {
    this._commitBatchedTx()
    this._finalizeRunningSegment()
    // A user-initiated close is terminal: clear the dormant flag so a session
    // closed while asleep can never be revived by a wake (see {@link isDormant}).
    this._dormant.set(false, undefined)
    this.status.set('closed', undefined)
    // Cancel any pending recovery attempt so a service-side reconnect loop
    // observing this session bails instead of reattaching a closed session.
    this._reconnecting = false
    this._turnInterrupted = false
    this._interruptedWithPendingInteraction = false
    this._resetBackgroundActivity()
    this.recovery.dispose()
    // Unblock anyone awaiting the handshake and reject any still-queued prompts
    // — a session closed mid-connect never reaches attach/fail, so settle the
    // connection here to avoid a hang.
    this._connection.close()
    this._abortAllInFlight()
    this._cancelPending()
    this._messages = []
    this._toolCalls = []
    this._timeline = []
    this._orphanChildren.clear()
    this._toolCallParent.clear()
    this._terminalOutput.clear()
    this._liveIngestedBytes = 0
    this._setImmediate(this.messages, this._messages)
    this._setImmediate(this.toolCalls, this._toolCalls)
    this._setImmediate(this.timeline, this._timeline)
    this.dispose()
  }

  // -- ingestion ----------------------------------------------------------

  /**
   * Fold the codex-acp fork's out-of-band terminal output (carried on
   * `_meta.terminal_output*`) into the per-call accumulator and return the
   * running text, or undefined when this call has no terminal output at all.
   * `append` chunks concatenate; a `replace` snapshot overwrites.
   */
  private _accumulateTerminalOutput(toolCallId: string, update: SessionUpdate): string | undefined {
    const chunk = readTerminalOutput(update)
    if (chunk !== undefined) {
      const prev = this._terminalOutput.get(toolCallId) ?? ''
      const next = chunk.mode === 'append' ? prev + chunk.data : chunk.data
      this._terminalOutput.set(toolCallId, capTerminalOutputTail(next))
    }
    return this._terminalOutput.get(toolCallId)
  }

  /**
   * Release the oldest heavy content until the live resident tally is back under
   * the budget. Unlike the replay gate (which drops the rest of the history), a
   * live turn keeps every new update — only the oldest cards are slimmed, newest
   * first-wins. Each trim releases the card's `text` / blocks / diffs (and the
   * per-call terminal accumulator) while keeping the card shell on the timeline.
   */
  private _trimLiveResidentContent(): void {
    let released = 0
    // Bound the loop by the number of slots: a trim must strictly reduce the
    // remaining heavy content, but if a future measure/release pair ever
    // disagreed, an unbounded `while` would spin the main thread instead of
    // merely overrunning the budget.
    for (let guard = this._timeline.length + 1; guard > 0; guard--) {
      if (this._liveIngestedBytes <= this._liveIngestionBudget) break
      const freed = this._trimOldestHeavyItem()
      if (freed === 0) break
      released += freed
      this._liveIngestedBytes -= freed
    }
    if (released > 0) {
      const tx = this._batchedTx()
      this.messages.set(this._messages, tx)
      this.toolCalls.set(this._toolCalls, tx)
      this.timeline.set(this._timeline, tx)
      console.warn(
        `[acp] session ${this.id}: live content exceeded the resident budget, ` +
          `released ${released} bytes from the oldest cards to protect memory`,
      )
    }
  }

  /** Trim the oldest timeline slot that still holds heavy content, returning the
   * released byte count (0 when nothing left to release). */
  private _trimOldestHeavyItem(): number {
    for (let i = 0; i < this._timeline.length; i++) {
      const slot = this._timeline[i]
      if (slot === undefined) continue
      if (slot.kind === 'toolCall') {
        const freed = toolCallHeavyBytes(slot.call)
        if (freed === 0) continue
        this._replaceToolCall(slot.call.id, trimToolCall(slot.call))
        this._terminalOutput.delete(slot.call.id)
        return freed
      }
      if (slot.kind === 'message') {
        const freed = messageHeavyBytes(slot.message)
        if (freed === 0) continue
        this._replaceMessage(slot.message.id, trimMessage(slot.message))
        return freed
      }
    }
    return 0
  }

  /** Replace a tool card in both the lane array and the timeline slot (keeping
   * any sub-agent children already attached to the slot). */
  private _replaceToolCall(id: string, trimmed: AcpToolCall): void {
    const ci = this._toolCalls.findIndex((t) => t.id === id)
    if (ci !== -1) {
      this._toolCalls = [...this._toolCalls.slice(0, ci), trimmed, ...this._toolCalls.slice(ci + 1)]
    }
    const ti = this._timeline.findIndex((it) => it.kind === 'toolCall' && it.id === id)
    if (ti === -1) return
    const slot = this._timeline[ti]
    if (slot === undefined || slot.kind !== 'toolCall') return
    // Sub-agent children live on the timeline slot, not the lane entry, so they
    // are carried over — but only when the replacement doesn't already carry its
    // own. A trim replacement brings trimmed children; re-attaching the slot's
    // untrimmed ones would undo the release the trim loop just accounted for,
    // leaving the card heavy while the loop believes it freed those bytes (it
    // would then keep picking the same card forever).
    const children = trimmed.children ?? slot.call.children
    const merged =
      children !== undefined && children.length > 0 ? { ...trimmed, children } : trimmed
    this._timeline = [
      ...this._timeline.slice(0, ti),
      { kind: 'toolCall', id, call: merged },
      ...this._timeline.slice(ti + 1),
    ]
  }

  /** Replace a message in both the lane array and the timeline slot. */
  private _replaceMessage(id: string, trimmed: AcpMessage): void {
    const mi = this._messages.findIndex((m) => m.id === id)
    if (mi !== -1) {
      this._messages = [...this._messages.slice(0, mi), trimmed, ...this._messages.slice(mi + 1)]
    }
    const ti = this._timeline.findIndex((it) => it.kind === 'message' && it.id === id)
    if (ti !== -1) {
      this._timeline = [
        ...this._timeline.slice(0, ti),
        { kind: 'message', id, message: trimmed },
        ...this._timeline.slice(ti + 1),
      ]
    }
  }

  /**
   * Proof of life for the stall watchdog from the agent's liveness ping
   * (a content-free ext-notification): only resets the silence window — no
   * timeline entry, no observable churn.
   */
  applyLivenessPing(): void {
    this._lastActivityAt = Date.now()
  }

  applyUpdate(update: SessionUpdate): void {
    const sid = this.sessionIdOnAgent.get()
    // Liveness bookkeeping for the service's stall watchdog.
    this._lastActivityAt = Date.now()
    if (this._suppressReplayToTimeline) {
      // Side-task anchor: the replayed user chunk carrying the side task's
      // first own prompt id marks the end of the forked baseline — lift the
      // suppression so this message and the side task's own turns after it
      // land on the timeline.
      if (
        this._suppressAnchorMessageId !== undefined &&
        update.sessionUpdate === 'user_message_chunk' &&
        readMessageId(update) === this._suppressAnchorMessageId
      ) {
        this._suppressReplayToTimeline = false
        this._suppressAnchorMessageId = undefined
        // The anchor turn's wire prompt led with the hidden role instruction,
        // which the agent persists and therefore replays as this message's
        // first chunk. Strip it so the restored first message shows only the
        // user's own text, same as the live path.
        const stripped = stripSideTaskRoleLead(update)
        if (stripped === undefined) return
        update = stripped
      }
    }
    if (this._suppressReplayToTimeline) {
      switch (update.sessionUpdate) {
        case 'config_option_update':
        case 'available_commands_update':
        case 'session_info_update':
        case 'usage_update':
          break
        default:
          return
      }
    }
    const residentCost = estimateUpdateResidentBytes(update)
    if (this.isReplayingHistory.get()) {
      // Budget gate for history replays: updates suppressed above never reach
      // the timeline so they are not tallied; everything else counts against
      // the budget, and once it overflows the remaining replay is dropped
      // (only counted) instead of swelling the view model without bound.
      this._replayIngestedBytes += residentCost
      if (this._replayOverflow) return
      if (this._replayIngestedBytes > this._replayIngestionBudget) {
        this._replayOverflow = true
        console.warn(
          `[acp] session ${this.id}: history replay exceeded the ingestion budget ` +
            `(${this._replayIngestedBytes}/${this._replayIngestionBudget} bytes resident); ` +
            'dropping the remaining replayed updates',
        )
        return
      }
    }
    const liveCost = this.isReplayingHistory.get() ? 0 : residentCost
    const parentId = readParentToolUseId(update)
    if (AGENT_OUTPUT_UPDATE_KINDS.has(update.sessionUpdate)) this._agentOutputCount++
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      for (const change of readFileChanges(update)) {
        if (sid !== undefined) {
          this._changeTracker?.record(sid, change.path, update.toolCallId, change.hunks, {
            created: change.isCreate,
            ...(change.baseline !== undefined ? { baseline: change.baseline } : {}),
          })
        }
      }
    }
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const mid = readMessageId(update)
        // A prompt retracted by cancelTurn's restore stays in the transcript —
        // drop its replay (and the SDK's trailing interruption marker) so a
        // reloaded session shows the same timeline the user left.
        if (mid !== undefined && this._retractedMessageIds.has(mid)) {
          this._skipInterruptedMarker = true
          break
        }
        if (this._skipInterruptedMarker) {
          this._skipInterruptedMarker = false
          const text = update.content.type === 'text' ? update.content.text.trim() : ''
          if (text === INTERRUPTED_MARKER_TEXT) break
        }
        // Best-effort parity with the live path: a replayed user chunk whose
        // text is exactly one of the recovery continuation sentinels is the
        // automatic continuation the recovery machinery sent before the
        // session was reloaded — stamp it so it renders demoted like its live
        // counterpart. A chunk the user genuinely typed never matches here
        // (live sends skip this check).
        const trimmed = update.content.type === 'text' ? update.content.text.trim() : undefined
        const autoRetry =
          this.isReplayingHistory.get() &&
          trimmed !== undefined &&
          (trimmed === CONTINUE_PROMPT_TEXT || trimmed === recoveryContinuePromptText())
        const selectionContexts =
          sid !== undefined && mid !== undefined
            ? this._messageAttachments?.getSelections(sid, mid)
            : undefined
        const visibleUpdate = stripSelectionReplayChunk(update, selectionContexts ?? [])
        if (visibleUpdate === undefined) break
        const visibleContent = (
          visibleUpdate as Extract<SessionUpdate, { sessionUpdate: 'user_message_chunk' }>
        ).content
        this._appendChunk(
          'user',
          visibleContent,
          parentId,
          mid,
          autoRetry,
          selectionContexts !== undefined && selectionContexts.length > 0
            ? selectionContexts
            : undefined,
        )
        break
      }
      case 'agent_message_chunk':
        this._appendChunk('agent', update.content, parentId)
        break
      case 'agent_thought_chunk':
        this._appendChunk('thought', update.content, parentId)
        break
      case 'tool_call': {
        // A new top-level tool slot is about to land at the end of the timeline.
        // Seal any still-streaming message first so the next thought/message
        // chunk opens a fresh card at the end instead of merging back into the
        // message now buried above this tool. Child tool calls live inside a
        // parent card and never touch the top-level streaming chain.
        const effectiveParent = this._resolveParent(update.toolCallId, parentId)
        if (effectiveParent == null) this._sealStreamingMessages()
        const { blocks: splitBlocks, diffs } = splitToolCallContent(update.content ?? [])
        const blocks = capToolCallBlocks(splitBlocks)
        const locations = readToolCallLocations(update.locations)
        const mcpServer = readMcpServer(update)
        const mcpTool = readMcpTool(update)
        const terminalText = this._accumulateTerminalOutput(update.toolCallId, update)
        const rawInput = capRawInput(update.rawInput)
        // Stamp a wall-clock start on top-level cards so the UI can show a run
        // duration (settled at completion). Child tool calls run inside a parent
        // card and don't get their own timer.
        const startedAt = effectiveParent == null ? Date.now() : undefined
        const stats = readSubagentStats(update)
        this._upsertToolCall(
          {
            id: update.toolCallId,
            title: update.title,
            kind: update.kind ?? 'unknown',
            status: (update.status as AcpToolCallStatus | undefined) ?? 'pending',
            blocks,
            diffs,
            text: terminalText ?? blocksToText(blocks),
            ...(rawInput !== undefined ? { rawInput } : {}),
            ...(locations !== undefined ? { locations } : {}),
            ...(mcpServer !== undefined ? { mcpServer } : {}),
            ...(mcpTool !== undefined ? { mcpTool } : {}),
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(stats !== undefined ? { subagentStats: this._priceSubagentStats(stats) } : {}),
          },
          effectiveParent,
        )
        this._telemetry.publicLog('acp.tool_call_started', {
          sessionId: this.id,
          kind: update.kind ?? 'unknown',
        })
        break
      }
      case 'tool_call_update': {
        const effectiveParent = this._resolveParent(update.toolCallId, parentId)
        const existing =
          effectiveParent != null
            ? this._findChildToolCall(effectiveParent, update.toolCallId)
            : this._toolCalls.find((t) => t.id === update.toolCallId)
        const split = update.content != null ? splitToolCallContent(update.content) : undefined
        const blocks =
          split !== undefined ? capToolCallBlocks(split.blocks) : (existing?.blocks ?? [])
        const diffs = split?.diffs ?? existing?.diffs ?? []
        const mcpServer = readMcpServer(update) ?? existing?.mcpServer
        const mcpTool = readMcpTool(update) ?? existing?.mcpTool
        // `locations` is a full replacement when present (SDK "replace the
        // locations collection"); carry the last known set forward otherwise so
        // a late `_meta`-only update doesn't drop the clickable path.
        const locations = readToolCallLocations(update.locations) ?? existing?.locations
        const terminalText = this._accumulateTerminalOutput(update.toolCallId, update)
        // An oversized fresh raw input is dropped outright — no fallback to the
        // previously stored one (which was capped on the way in anyway); an
        // update that omits rawInput carries the existing value forward.
        const rawInput =
          update.rawInput !== undefined ? capRawInput(update.rawInput) : existing?.rawInput
        // Sub-agent stats ride on late `_meta`-only updates; merge the fresh tally
        // over the last one (carry it forward when this update omits it) so the
        // running readout doesn't blink off between chunks.
        const stats = readSubagentStats(update)
        const subagentStats =
          stats !== undefined ? this._priceSubagentStats(stats) : existing?.subagentStats
        // Carry the start timestamp forward and settle a frozen duration at the
        // terminal status. Only top-level cards carry a timer (see `tool_call`).
        const startedAt = existing?.startedAt
        const status =
          (update.status as AcpToolCallStatus | undefined) ?? existing?.status ?? 'pending'
        const settled = status === 'completed' || status === 'failed'
        const durationMs =
          settled && startedAt !== undefined
            ? (existing?.durationMs ?? Math.max(0, Date.now() - startedAt))
            : existing?.durationMs
        const next: AcpToolCall = {
          id: update.toolCallId,
          title: update.title != null ? update.title : (existing?.title ?? update.toolCallId),
          kind: update.kind != null ? update.kind : (existing?.kind ?? 'unknown'),
          status,
          blocks,
          diffs,
          text: terminalText ?? blocksToText(blocks),
          ...(rawInput !== undefined ? { rawInput } : {}),
          ...(locations !== undefined ? { locations } : {}),
          ...(mcpServer !== undefined ? { mcpServer } : {}),
          ...(mcpTool !== undefined ? { mcpTool } : {}),
          ...(subagentStats !== undefined ? { subagentStats } : {}),
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        }
        this._upsertToolCall(next, effectiveParent)
        if (update.status === 'failed') {
          this._telemetry.publicLogError('acp.tool_call_failed', {
            sessionId: this.id,
            kind: next.kind,
          })
        }
        break
      }
      case 'plan': {
        // Seal streaming only when the plan first appears. Plan no longer enters
        // the timeline (it renders as a sticky bar off the scroll), so we track
        // first appearance with a flag instead of scanning the timeline.
        if (!this._planSeen) {
          this._planSeen = true
          this._sealStreamingMessages()
        }
        const entries: readonly AcpPlanEntry[] = update.entries.map((e) => ({
          content: e.content,
          status: e.status,
          ...(e.priority !== undefined ? { priority: e.priority } : {}),
        }))
        this.plan.set(entries, this._batchedTx())
        // Mirror onto history so the plan bar survives resume — codex's
        // session/load replay does not re-emit plan. An empty snapshot clears
        // the mirror so a cleared plan doesn't resurrect on restart.
        if (sid !== undefined)
          this._history?.setHistoryPlan(sid, entries.length > 0 ? entries : null)
        break
      }
      case 'available_commands_update':
        this.availableCommands.set(update.availableCommands, undefined)
        this._telemetry.publicLog('acp.commands_advertised', {
          sessionId: this.id,
          count: update.availableCommands.length,
        })
        break
      case 'config_option_update':
        this._configOptions.ingestUpdate(update)
        break
      case 'session_info_update': {
        // Push title / updatedAt into the durable history entry so the sidebar
        // reflects renames and activity without waiting for the next hydrate.
        if (this._history) {
          const patch: { title?: string; updatedAt?: number } = {}
          if (typeof update.title === 'string' && update.title.length > 0) {
            // Without a session-title model the SDK summary falls back to
            // `lastPrompt`, so the agent re-reports the newest prompt as the
            // title at every turn end. Drop that echo (a genuine agent title
            // still lands); the derivedTitle flag is the second line of defence.
            if (isPromptEchoTitle(update.title, this._dispatchedPromptTexts)) {
              console.debug(
                `[acp-title] dropped session_info_update echoing a dispatched prompt: ${update.title.slice(0, 60)}`,
              )
            } else {
              patch.title = update.title
            }
          }
          if (typeof update.updatedAt === 'string') {
            const ts = Date.parse(update.updatedAt)
            if (Number.isFinite(ts)) patch.updatedAt = ts
          }
          if (Object.keys(patch).length > 0 && sid !== undefined) {
            this._history.updateInfo(sid, patch)
          }
        }
        break
      }
      case 'usage_update': {
        const tx = this._batchedTx()
        const prev = this.usage.get()
        const ctx = this._providerContext?.getProviderContext(this.agentId, this.authority)
        // Agents that don't report authoritative cost (Codex) estimate it locally
        // from the session-cumulative per-model token counts stamped on every
        // usage_update. Take the latest snapshot — it already folds in every call,
        // so no accumulation.
        const localCost = this._costStrategy?.fromUsageUpdate(
          (update as { _meta?: unknown })._meta,
          ctx,
        )
        if (localCost != null) {
          const next: AcpUsage = {
            used: update.used,
            size: update.size,
            models: localCost.models,
            costEstimated: true,
            ...(localCost.cost !== undefined ? { cost: localCost.cost } : {}),
          }
          this.usage.set(next, tx)
          if (sid !== undefined) this._history?.setHistoryUsage(sid, next)
          break
        }
        const models = extractModelBreakdown(update)
        // The Claude CLI prices cost against its Anthropic-only model catalog —
        // sessions running gateway models (kimi/deepseek/…) get silently billed
        // at the default flagship rate. Re-price through the provider context;
        // rows that resolve to no rate keep the CLI's own figure.
        // Not gated on `update.cost`: mid-turn breakdowns carry token counts
        // without a cost (only the turn-final `result` knows the CLI figure),
        // and pricing them locally is what makes the readout advance during a
        // turn instead of freezing until it ends.
        const repriced = models.length > 0 ? repriceForeignModelBreakdown(models, ctx) : undefined
        if (repriced != null) {
          // A mid-turn breakdown is `base ⊕ overlay` and only ever grows, so a
          // figure BELOW the last one means the agent's base is missing rather
          // than that the session got cheaper — the ledger lives in the fork's
          // per-session consumer, so after a reconnect or an agent restart the
          // first recovered turn reports only its own tokens. Freezing the
          // amount there (token detail still advances) beats dropping the wallet
          // from ¥50 to pennies until that turn ends. Turn-final updates carry
          // `cost` and always replace, so an authoritative correction — a rewind
          // truncating the transcript included — still lands.
          const midturn = update.cost == null
          const prevAmount = prev?.cost?.amount
          const regressed =
            midturn &&
            repriced.cost !== undefined &&
            prevAmount !== undefined &&
            repriced.cost.amount < prevAmount
          const cost = regressed ? prev?.cost : repriced.cost
          const next: AcpUsage = {
            used: update.used,
            size: update.size,
            models: repriced.models,
            costEstimated: true,
            ...(cost !== undefined ? { cost } : {}),
          }
          this.usage.set(next, tx)
          if (sid !== undefined) this._history?.setHistoryUsage(sid, next)
          break
        }
        // Reached when no row re-priced — either the update carries no
        // breakdown at all, or none of its models resolves a rate (an official
        // subscription session has no local rate table). Only the turn-final
        // usage_update carries `cost`, so carry the last known one forward
        // instead of replacing it — otherwise the cost readout flickers off for
        // the whole duration of every running turn.
        const cost =
          update.cost != null
            ? { amount: update.cost.amount, currency: update.cost.currency }
            : prev?.cost
        const nextModels = models.length > 0 ? models : prev?.models
        // Codex's own usage_update never carries cost — the estimate rides on
        // PromptResponse instead (see _ingestPromptResponse). Preserve the
        // estimated flag whenever we carry a prior cost forward.
        const costEstimated = update.cost != null ? undefined : prev?.costEstimated
        const next: AcpUsage = {
          used: update.used,
          size: update.size,
          ...(cost != null ? { cost } : {}),
          ...(nextModels != null ? { models: nextModels } : {}),
          ...(costEstimated ? { costEstimated: true } : {}),
        }
        this.usage.set(next, tx)
        // Mirror onto history so the arc survives resume — `session/load`
        // replay does not re-emit usage_update. Debounced + deduped downstream.
        if (sid !== undefined) this._history?.setHistoryUsage(sid, next)
        break
      }
      default:
        // unhandled SessionUpdate variants — ignored for now.
        break
    }
    if (liveCost > 0) {
      this._liveIngestedBytes += liveCost
      this._trimLiveResidentContent()
    }
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    // Read-only preview: never mutate the foreign session's agent-side config.
    if (this.readOnly) return
    // Switching model / mode / thought-level is an RPC, so a dormant session
    // needs its process back first — pushing onto the dead lease would reject
    // and roll the picked value back.
    this._wakeIfDormant()
    // Healthy connection (or the still-connecting / closed session that falls
    // through to the state machine's optimistic local path): reach the state
    // machine WITHOUT yielding first. It applies the value locally and arms the
    // same-id echo gate synchronously, and a `config_option_update` landing in
    // the same tick would otherwise overwrite the user's pick before the gate
    // exists.
    if (!this._reconnecting) return this._configOptions.setConfigOption(configId, value)
    const outcome = await this.ensureAwake()
    if (outcome === 'failed') {
      throw new AcpConnectionError(
        localize(
          'acp.session.wakeFailed',
          'Failed to wake the agent session before applying the change',
        ),
      )
    }
    return this._configOptions.setConfigOption(configId, value)
  }

  /**
   * Seed the saved configOption values (per-agent defaults + per-session
   * history) the state machine reconciles incoming bags against. Must be called
   * before `applyInitState` so the first bag is reconciled with no flicker.
   */
  setConfigDesired(desired: Readonly<Record<string, string>>): void {
    this._configOptions.setDesired(desired)
  }

  /**
   * Apply the optimistic seed bag before the handshake lands. Seeded options are
   * carried across the authoritative `session/new` bag so a late-surfacing,
   * model-dependent option (e.g. `effort`) does not disappear then reappear.
   */
  seedConfigOptions(opts: readonly SessionConfigOption[]): void {
    this._configOptions.seedConfigOptions(opts)
  }

  /**
   * Reconcile the user message's anchor with the id the agent echoed back. The
   * client generates the messageId and the agent SHOULD echo the same value, but
   * if it reports a different `userMessageId` we adopt the agent's — that is the
   * id its rewind/fork APIs actually recognise. Locates the local user message by
   * the id we sent and rewrites its `messageId` in place. No-op when the agent
   * echoes the same id (the common case) or reports none.
   */
  private _reconcileUserMessageId(sentId: string, response: PromptResponse): void {
    // SDK 1.x dropped the unstable top-level `userMessageId`; agents that echo
    // pass it through `_meta` (which the schema preserves untouched).
    const echoed = (response._meta as { userMessageId?: unknown } | null | undefined)?.userMessageId
    if (typeof echoed !== 'string' || echoed === sentId) return
    const idx = this._messages.findIndex((m) => m.role === 'user' && m.messageId === sentId)
    if (idx === -1) return
    const prev = this._messages[idx]
    if (prev === undefined) return
    const next: AcpMessage = { ...prev, messageId: echoed }
    this._messages = [...this._messages.slice(0, idx), next, ...this._messages.slice(idx + 1)]
    this._upsertMessageInTimeline(next)
    const tx = this._batchedTx()
    this.messages.set(this._messages, tx)
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
  }

  /**
   * Finalize a locally-estimated cost from the prompt response, for agents that
   * never report an authoritative cost (Codex). We estimate from the session-
   * cumulative per-model token counts the fork stamps on the response. This is a
   * safety net — `usage_update` already refreshes the estimate on every model
   * call (see the usage_update case); the response just confirms the final total.
   * No-op for agents that report real cost (Claude — no strategy registered).
   */
  private _ingestPromptResponse(response: PromptResponse): void {
    const ctx = this._providerContext?.getProviderContext(this.agentId, this.authority)
    const estimate = this._costStrategy?.fromPromptResponse(response, ctx)
    if (estimate == null) return

    const tx = this._batchedTx()
    const prev = this.usage.get()
    const next: AcpUsage = {
      used: prev?.used ?? 0,
      size: prev?.size ?? 0,
      models: estimate.models,
      costEstimated: true,
      ...(estimate.cost !== undefined ? { cost: estimate.cost } : {}),
    }
    this.usage.set(next, tx)
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._history?.setHistoryUsage(sid, next)
  }

  /**
   * Attach a locally-estimated USD cost to a sub-agent tally. The agent never
   * reports a per-sub-agent cost, so we price the tokens against the model's
   * published rates. Codex stats carry no model, so they are not priced here.
   * Leaves `costUSD` unset when no model is known or no rate resolves, so the UI
   * can hide the cost instead of showing a guessed number.
   */
  private _priceSubagentStats(stats: AcpSubagentStats): AcpSubagentStats {
    if (stats.model === undefined) return stats
    const ctx = this._providerContext?.getProviderContext(this.agentId, this.authority)
    const pricing = priceSessionModel(stats.model, ctx).pricing
    if (pricing === undefined) {
      console.debug(`[acp-cost] subagent model rate unknown: ${stats.model}`)
      return stats
    }
    const costUSD = estimateCostUSD(
      pricing,
      {
        input: stats.inputTokens,
        output: stats.outputTokens,
        cacheRead: stats.cacheReadTokens,
        cacheWrite: stats.cacheCreateTokens,
      },
      ctx?.cnyPerUsd,
    )
    return { ...stats, costUSD }
  }

  private _appendChunk(
    role: AcpMessageRole,
    block: ContentBlock,
    parentId?: string,
    messageId?: string,
    autoRetry?: boolean,
    selectionContexts?: readonly SelectionContext[],
  ): void {
    if (parentId != null) {
      this._appendChildChunk(role, block, parentId)
      return
    }
    const last = this._messages[this._messages.length - 1]
    let next: AcpMessage
    // Chunks merge into the open streaming message only when they belong to it:
    // same role AND same anchor. Replays stamp each persisted message with its
    // own messageId, so without the anchor check two adjacent replayed user
    // messages (e.g. an interruption marker followed by the re-sent prompt, once
    // any filtered chunks in between are dropped) would fuse into one card.
    // Anchorless chunks (agent/thought paths never pass one) keep the old
    // merge-anything behavior — undefined === undefined.
    if (last && last.role === role && this._isStreaming(last.id) && last.messageId === messageId) {
      const merged = mergeStreamingBlock(last.blocks, block)
      // Bound the text a single streaming message keeps resident (hysteresis:
      // only rebuild once past the threshold so per-chunk appends stay cheap).
      const blocks =
        last.text.length > MESSAGE_TEXT_REBUILD_AT ? capMessageBlocksTail(merged) : merged
      next = {
        id: last.id,
        role,
        blocks,
        text: blocksToText(blocks),
        streaming: true,
        ...(last.messageId !== undefined
          ? { messageId: last.messageId }
          : messageId !== undefined
            ? { messageId }
            : {}),
        ...(last.autoRetry === true || autoRetry === true ? { autoRetry: true as const } : {}),
        ...(last.selectionContexts !== undefined
          ? { selectionContexts: last.selectionContexts }
          : selectionContexts !== undefined && selectionContexts.length > 0
            ? { selectionContexts }
            : {}),
      }
      this._messages = [...this._messages.slice(0, -1), next]
      this._upsertMessageInTimeline(next)
    } else {
      // A blank chunk that would open a brand-new message is dropped: agents
      // emit empty/whitespace thought chunks as turn markers, which would
      // otherwise surface as an empty THOUGHT card. No streaming slot is closed
      // or opened — a pure no-op. The merge branch above is untouched, so a
      // blank chunk inside an active stream still preserves inter-word spacing.
      if (isBlankContentBlock(block)) return
      // Only the message currently receiving chunks should be marked streaming.
      // Close out any prior streaming slot (e.g. when agent transitions
      // thought → message) before opening a new one.
      const closed = this._closePriorStreaming()
      const id = `m${++this._msgCounter}`
      this._streamingIds.add(id)
      const blocks: readonly ContentBlock[] = [capContentBlock(block)]
      next = {
        id,
        role,
        blocks,
        text: blocksToText(blocks),
        streaming: true,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(autoRetry === true ? { autoRetry: true as const } : {}),
        ...(selectionContexts !== undefined && selectionContexts.length > 0
          ? { selectionContexts }
          : {}),
      }
      this._messages = [...this._messages, next]
      for (const c of closed) this._upsertMessageInTimeline(c)
      this._upsertMessageInTimeline(next)
    }
    const tx = this._batchedTx()
    this.messages.set(this._messages, tx)
    this.timeline.set(this._timeline, tx)
  }

  private _isStreaming(id: string): boolean {
    return this._streamingIds.has(id)
  }

  private _closePriorStreaming(): AcpMessage[] {
    if (this._streamingIds.size === 0) return []
    const closed: AcpMessage[] = []
    this._messages = this._messages.map((m) => {
      if (m.streaming) {
        const c = { ...m, streaming: false }
        closed.push(c)
        return c
      }
      return m
    })
    this._streamingIds.clear()
    return closed
  }

  /**
   * A new non-message slot (tool call / first plan) is about to be appended at
   * the end of the timeline. Seal any message still marked streaming so the next
   * thought/message chunk opens a fresh card at the end via `_appendChunk`'s new
   * branch, instead of merging back into the message now buried above the new
   * slot. Closed messages are re-upserted in place (their `streaming` flag flips)
   * and the messages observable is refreshed on the shared batched transaction.
   */
  private _sealStreamingMessages(): void {
    const closed = this._closePriorStreaming()
    if (closed.length === 0) return
    for (const c of closed) this._upsertMessageInTimeline(c)
    this.messages.set(this._messages, this._batchedTx())
  }

  private _flushStream(): void {
    this._streamingIds.clear()
    this._messages = this._messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    for (const m of this._messages) {
      this._upsertMessageInTimeline(m)
    }
    // Write both lanes on the batched tx then commit, so the streaming-flag
    // clear is observed atomically (one notification) instead of tearing
    // messages from timeline.
    const tx = this._batchedTx()
    this.messages.set(this._messages, tx)
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
  }

  private _appendMessage(
    role: AcpMessageRole,
    text: string,
    leadingBlocks: readonly ContentBlock[] = [],
    messageId?: string,
    opts?: {
      autoRetry?: boolean
      selectionContexts?: readonly SelectionContext[]
    },
  ): void {
    const id = `m${++this._msgCounter}`
    // Image (or other) blocks lead, then the text block. Skip an empty text
    // block so an image-only message doesn't carry a blank paragraph.
    const textBlocks: readonly ContentBlock[] = text.length > 0 ? [{ type: 'text', text }] : []
    const blocks: readonly ContentBlock[] = [...leadingBlocks, ...textBlocks]
    const message: AcpMessage = {
      id,
      role,
      blocks,
      text,
      streaming: false,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(opts?.selectionContexts !== undefined && opts.selectionContexts.length > 0
        ? { selectionContexts: opts.selectionContexts.map((context) => ({ ...context })) }
        : {}),
      ...(opts?.autoRetry === true ? { autoRetry: true as const } : {}),
    }
    this._messages = [...this._messages, message]
    this._upsertMessageInTimeline(message)
    // Atomic + synchronous: write both observables on the batched tx then commit
    // immediately. Folding in any chunk tx already pending keeps messages and
    // timeline from being observed in a torn intermediate state (e.g. a
    // mid-stream `[error]` sentinel landing between two chunks).
    const tx = this._batchedTx()
    this.messages.set(this._messages, tx)
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
  }

  /**
   * Surface a context-compaction lifecycle event on the timeline. The `running`
   * slot is appended when compaction starts; the terminal `success`/`failed`
   * event replaces it in place via the stable `id`, so a single compaction shows
   * as one card that settles rather than two stacked entries. Read-only preview
   * sessions ignore these (they never run turns).
   *
   * Orphan merging: when the agent dies mid-compaction the `running` slot's
   * settle notification is lost with the connection, and the compaction the
   * agent restarts after recovery reports under a fresh `id`. Without merging
   * that stacks a second card next to the stuck one — from the user's seat it
   * looks like two compactions. So a new event whose `id` has no slot silently
   * replaces the leftover `running` slot in place (resetting the stopwatch for
   * a start; reusing the orphan's `startedAt` for a terminal phase).
   */
  applyCompaction(id: string, phase: AcpCompactionPhase, reason?: string): void {
    if (this.readOnly) return
    // Proof of life for the stall watchdog: compaction lifecycle travels via
    // ext-notifications, which never touch `lastActivityAt` otherwise. The
    // terminal-phase bump matters most — without it, the silence after a long
    // compaction would be measured from BEFORE the compaction started and
    // stall the turn the moment the card settles.
    this._lastActivityAt = Date.now()
    const slotId = `compaction:${id}`
    const idx = this._timeline.findIndex((it) => it.kind === 'compaction' && it.id === slotId)
    const orphanIdx = this._timeline.findIndex(
      (it) => it.kind === 'compaction' && it.compaction.phase === 'running' && it.id !== slotId,
    )
    const targetIdx = idx !== -1 ? idx : orphanIdx
    const prev = targetIdx === -1 ? undefined : this._timeline[targetIdx]
    const prevStartedAt = prev?.kind === 'compaction' ? prev.compaction.startedAt : undefined
    const prevExpected =
      prev?.kind === 'compaction' ? prev.compaction.expectedDurationMs : undefined
    // The SDK compaction has no true progress; the card shows a live stopwatch
    // from `startedAt`. Stamp it when `running` begins, then settle a fixed
    // `durationMs` at the terminal phase so the elapsed time freezes. A start
    // that merges an orphan still resets the stopwatch: the card times the
    // retried compaction, not the interrupted attempt.
    const startedAt = phase === 'running' ? Date.now() : prevStartedAt
    const durationMs =
      phase !== 'running' && startedAt !== undefined
        ? Math.max(0, Date.now() - startedAt)
        : undefined
    // Seed the estimate from observed history when starting; record the real
    // duration back on success so subsequent compactions estimate more sharply.
    const expectedDurationMs =
      phase === 'running'
        ? this._compactionStats?.getExpectedDurationMs(this.agentId)
        : prevExpected
    if (phase === 'success' && durationMs !== undefined) {
      this._compactionStats?.record(this.agentId, durationMs)
    }
    const compaction: AcpCompaction = {
      phase,
      ...(reason != null ? { reason } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(expectedDurationMs !== undefined ? { expectedDurationMs } : {}),
    }
    const slot: TimelineItem = { kind: 'compaction', id: slotId, compaction }
    if (targetIdx === -1) {
      this._timeline = [...this._timeline, slot]
    } else {
      this._timeline = this._timeline.map((it, i) => {
        if (i === targetIdx) return slot
        // Defensive: at most one running slot is ever expected, but never leave
        // another stuck-running orphan behind the merged one.
        if (it.kind === 'compaction' && it.compaction.phase === 'running') {
          return {
            kind: 'compaction',
            id: it.id,
            compaction: settleRunning(it.compaction, 'superseded'),
          }
        }
        return it
      })
    }
    const tx = this._batchedTx()
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
  }

  /**
   * Settle any compaction slot still stuck in `running` as `failed`. A running
   * slot whose settle notification was lost (agent died mid-compaction and the
   * turn ended without a restart) would otherwise spin forever. Called only on
   * terminal turn/recovery paths — NOT on connection loss, where the
   * hot-reconnect flow expects a restarted compaction's `start` to silently
   * merge the orphan instead (see {@link applyCompaction}).
   */
  private _settleOrphanCompactions(reason: string): void {
    if (this.readOnly) return
    if (
      !this._timeline.some((it) => it.kind === 'compaction' && it.compaction.phase === 'running')
    ) {
      return
    }
    this._timeline = this._timeline.map((it) =>
      it.kind === 'compaction' && it.compaction.phase === 'running'
        ? { kind: 'compaction', id: it.id, compaction: settleRunning(it.compaction, reason) }
        : it,
    )
    const tx = this._batchedTx()
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
  }

  /**
   * Surface a wedged-session resurrection lifecycle event on the timeline. The
   * `running` slot is appended when the adapter starts the resume; the terminal
   * `success`/`failed` event replaces it in place via the stable `id`, so a
   * single resurrection shows as one card that settles. Unlike compaction there
   * is no progress estimate — a resume is spawn-plus-load, typically seconds —
   * so the card only renders a live stopwatch. Read-only preview sessions ignore
   * these (they never run turns).
   */
  applyResurrection(
    id: string,
    phase: AcpResurrectionPhase,
    opts: { replayCount?: number; reason?: string } = {},
  ): void {
    if (this.readOnly) return
    const slotId = `resurrection:${id}`
    const idx = this._timeline.findIndex((it) => it.kind === 'resurrection' && it.id === slotId)
    const prev = idx === -1 ? undefined : this._timeline[idx]
    const prevStartedAt = prev?.kind === 'resurrection' ? prev.resurrection.startedAt : undefined
    const startedAt = phase === 'running' ? Date.now() : prevStartedAt
    const durationMs =
      phase !== 'running' && startedAt !== undefined
        ? Math.max(0, Date.now() - startedAt)
        : undefined
    const resurrection: AcpResurrection = {
      phase,
      ...(opts.replayCount !== undefined ? { replayCount: opts.replayCount } : {}),
      ...(opts.reason != null ? { reason: opts.reason } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
    const slot: TimelineItem = { kind: 'resurrection', id: slotId, resurrection }
    if (idx === -1) {
      this._timeline = [...this._timeline, slot]
    } else {
      this._timeline = [...this._timeline.slice(0, idx), slot, ...this._timeline.slice(idx + 1)]
    }
    const tx = this._batchedTx()
    this.timeline.set(this._timeline, tx)
    this._commitBatchedTx()
  }

  private _upsertToolCall(call: AcpToolCall, parentId?: string): void {
    if (parentId != null) {
      this._upsertChildOfParent(parentId, { kind: 'toolCall', id: call.id, call })
      return
    }
    const idx = this._toolCalls.findIndex((t) => t.id === call.id)
    if (idx === -1) {
      this._toolCalls = [...this._toolCalls, call]
    } else {
      this._toolCalls = [...this._toolCalls.slice(0, idx), call, ...this._toolCalls.slice(idx + 1)]
    }
    this._upsertToolCallInTimeline(call)
    const tx = this._batchedTx()
    this.toolCalls.set(this._toolCalls, tx)
    this.timeline.set(this._timeline, tx)
  }

  // -- sub-agent (child) routing ------------------------------------------

  /**
   * Resolve a tool call's parent, remembering it on first sighting. Updates that
   * carry `parentToolUseId` set the mapping; ones that drop it (e.g. the
   * PostToolUse hook's `tool_call_update`) fall back to the remembered parent so
   * they re-attach to the parent card instead of becoming an orphan top-level
   * slot stuck at "pending".
   */
  private _resolveParent(toolCallId: string, parentId: string | undefined): string | undefined {
    if (parentId != null) {
      this._toolCallParent.set(toolCallId, parentId)
      return parentId
    }
    return this._toolCallParent.get(toolCallId)
  }

  /** Append a streaming sub-agent message chunk under its parent tool call. */
  private _appendChildChunk(role: AcpMessageRole, block: ContentBlock, parentId: string): void {
    const children = this._childrenOf(parentId)
    const last = children[children.length - 1]
    let next: readonly AcpChildItem[]
    if (last && last.kind === 'message' && last.message.role === role) {
      // Merge into the trailing child message. No streaming-flag bookkeeping:
      // an interleaved child tool call makes `last` a toolCall, which naturally
      // breaks the merge and opens a fresh message — same for a role switch.
      const merged = mergeStreamingBlock(last.message.blocks, block)
      const blocks =
        last.message.text.length > MESSAGE_TEXT_REBUILD_AT ? capMessageBlocksTail(merged) : merged
      const message: AcpMessage = {
        ...last.message,
        blocks,
        text: blocksToText(blocks),
      }
      next = [...children.slice(0, -1), { kind: 'message', id: message.id, message }]
    } else {
      if (isBlankContentBlock(block)) return
      const id = `m${++this._msgCounter}`
      const blocks: readonly ContentBlock[] = [capContentBlock(block)]
      // Child messages never show a streaming caret (folded by default), so they
      // stay out of `_streamingIds` and the top-level seal/flush machinery.
      const message: AcpMessage = { id, role, blocks, text: blocksToText(blocks), streaming: false }
      next = [...children, { kind: 'message', id, message }]
    }
    this._setChildren(parentId, next)
    this.timeline.set(this._timeline, this._batchedTx())
  }

  /** Upsert one child slot (message / toolCall) into its parent's children. */
  private _upsertChildOfParent(parentId: string, child: AcpChildItem): void {
    const children = this._childrenOf(parentId)
    const idx = children.findIndex((c) => c.kind === child.kind && c.id === child.id)
    const next =
      idx === -1
        ? [...children, child]
        : [...children.slice(0, idx), child, ...children.slice(idx + 1)]
    this._setChildren(parentId, next)
    this.timeline.set(this._timeline, this._batchedTx())
  }

  private _childrenOf(parentId: string): readonly AcpChildItem[] {
    const slot = this._timeline.find((it) => it.kind === 'toolCall' && it.id === parentId)
    if (slot && slot.kind === 'toolCall') return slot.call.children ?? []
    return this._orphanChildren.get(parentId) ?? []
  }

  private _findChildToolCall(parentId: string, id: string): AcpToolCall | undefined {
    const child = this._childrenOf(parentId).find((c) => c.kind === 'toolCall' && c.id === id)
    return child && child.kind === 'toolCall' ? child.call : undefined
  }

  /** Write a parent's children back to its timeline slot, or stash as orphan. */
  private _setChildren(parentId: string, children: readonly AcpChildItem[]): void {
    const idx = this._timeline.findIndex((it) => it.kind === 'toolCall' && it.id === parentId)
    if (idx === -1) {
      this._orphanChildren.set(parentId, children)
      return
    }
    const slot = this._timeline[idx]
    if (slot === undefined || slot.kind !== 'toolCall') return
    const call: AcpToolCall = { ...slot.call, children }
    this._timeline = [
      ...this._timeline.slice(0, idx),
      { kind: 'toolCall', id: call.id, call },
      ...this._timeline.slice(idx + 1),
    ]
  }

  private _upsertMessageInTimeline(message: AcpMessage): void {
    const idx = this._timeline.findIndex((it) => it.kind === 'message' && it.id === message.id)
    const slot: TimelineItem = { kind: 'message', id: message.id, message }
    if (idx === -1) {
      this._timeline = [...this._timeline, slot]
    } else {
      this._timeline = [...this._timeline.slice(0, idx), slot, ...this._timeline.slice(idx + 1)]
    }
  }

  private _upsertToolCallInTimeline(call: AcpToolCall): void {
    const idx = this._timeline.findIndex((it) => it.kind === 'toolCall' && it.id === call.id)
    // Preserve any sub-agent children already attached to this slot (tool_call_update
    // rebuilds the call from the wire without children) and absorb orphans that
    // arrived before this parent first landed.
    const existing = idx !== -1 ? this._timeline[idx] : undefined
    const existingChildren =
      existing && existing.kind === 'toolCall' ? (existing.call.children ?? []) : []
    const orphans = this._orphanChildren.get(call.id)
    if (orphans) this._orphanChildren.delete(call.id)
    const children = [...existingChildren, ...(orphans ?? [])]
    const merged: AcpToolCall = children.length > 0 ? { ...call, children } : call
    const slot: TimelineItem = { kind: 'toolCall', id: call.id, call: merged }
    if (idx === -1) {
      this._timeline = [...this._timeline, slot]
    } else {
      this._timeline = [...this._timeline.slice(0, idx), slot, ...this._timeline.slice(idx + 1)]
    }
  }

  /** Lazily open a 16ms-deadlined transaction for streaming bursts. */
  private _batchedTx(): TransactionImpl {
    if (!this._pendingTx) {
      this._pendingTx = new TransactionImpl(
        () => {},
        () => `acp.session.batch.${this.id}`,
      )
      this._flushTimer = setTimeout(() => this._commitBatchedTx(), 16)
    }
    return this._pendingTx
  }

  private _commitBatchedTx(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = undefined
    }
    if (this._pendingTx) {
      const tx = this._pendingTx
      this._pendingTx = undefined
      tx.finish()
    }
  }

  /**
   * Write an observable with an immediate (synchronous) notification. Guarded:
   * doing this while a batched tx is still pending would let observers see a
   * torn state (the immediate lane updated, the batched lane not yet flushed) —
   * exactly the streaming-jitter class the 16ms batcher exists to prevent. All
   * timeline/messages immediate writes must either commit the pending batch
   * first or route through here. In dev this throws so the mistake surfaces in
   * tests; in production it degrades to a plain set.
   */
  private _setImmediate<T>(o: ISettableObservable<T>, value: T): void {
    if (import.meta.env.DEV && this._pendingTx !== undefined) {
      throw new Error(
        `AcpSession: immediate set on ${o.debugName} while a batched tx is pending — ` +
          `commit the batch first to avoid a torn timeline (session ${this.id})`,
      )
    }
    o.set(value, undefined)
  }
}
