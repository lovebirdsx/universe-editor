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
  generateUuid,
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
import type { IAcpClientConnection } from './acpClientService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import type { ISessionChangeTrackerService } from './sessionChangeTracker.js'
import type { IAcpSessionTitleService } from './acpSessionTitleService.js'
import type { IAcpCompactionStatsService } from './acpCompactionStats.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import { ConfigOptionStateMachine } from './acpSessionConfigOptions.js'
import { AcpSessionConnection, type QueuedPrompt } from './acpSessionConnection.js'
import { isAuthRequiredError } from './acpAuthError.js'
import { classifyAcpError } from './acpErrorClassify.js'
import {
  MAX_RECOVERY_ATTEMPTS,
  SessionRecovery,
  recoveryBackoffMs,
  type AcpRecoveryState,
} from './acpSessionRecovery.js'
import { composeContextBlocks, type SelectionContext } from './promptContext.js'
import { composeImageBlocks, type PromptImage } from './promptImage.js'
import { composePromptBlocksFromRefs, type PlacedRef } from './promptRef.js'
import { estimateClaudeCostUSD } from '../../../shared/ai/claudePricing.js'
import { getAgentCostStrategy, type AcpAgentCostStrategy } from './acpAgentCostStrategy.js'
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
  type AcpPendingQuestion,
  type AcpPlanEntry,
  type AcpCompaction,
  type AcpCompactionPhase,
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
  ASK_USER_QUESTION_METHOD,
  COMPACTION_METHOD,
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
  AcpPendingQuestion,
  AcpPlanEntry,
  AcpPlanEntryStatus,
  AcpSessionStatus,
  AcpSubagentStats,
  AcpToolCall,
  AcpToolCallDiff,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpUsage,
  AskUserQuestion,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  IAcpSession,
  IAcpSessionInitState,
  RewindFilesResult,
  TimelineItem,
} from './acpSessionModel.js'
export type { AcpRecoveryPhase, AcpRecoveryState } from './acpSessionRecovery.js'
export {
  blocksToText,
  hasVisibleMessageContent,
  isBlankContentBlock,
  mergeStreamingBlock,
  splitToolCallContent,
  timelineItemToText,
  toolCallToText,
} from './acpSessionContent.js'

/** Provenance of a session title — see {@link AcpSession._pendingTitleKind}. */
type TitleKind = 'ai' | 'manual' | undefined

/**
 * Continuation prompt sent automatically after a hot-reconnect (or a retried
 * turn) when the interrupted turn had already produced output, so resending
 * the original prompt would duplicate the turn in the agent transcript.
 */
export const CONTINUE_PROMPT_TEXT = '继续'

/** Why the session's connection was lost — drives the service's recovery path. */
export interface AcpConnectionLostEvent {
  /** `crash`: process exited. `stalled`: alive but silent past the watchdog threshold. */
  readonly reason: 'crash' | 'stalled'
}

/** Snapshot of one dispatched prompt, kept so a failed/interrupted turn can be re-sent. */
interface PromptSnapshot {
  readonly text: string
  readonly refs: readonly PlacedRef[]
  readonly contexts: readonly SelectionContext[]
  readonly images: readonly PromptImage[]
  readonly messageId: string
  /** `_applyUpdateCount` when the prompt was first dispatched — zero-output detection. */
  readonly baseline: number
}

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

export class AcpSession extends Disposable implements IAcpSession {
  readonly sessionIdOnAgent: ISettableObservable<string | undefined>
  readonly messages: ISettableObservable<readonly AcpMessage[]>
  readonly toolCalls: ISettableObservable<readonly AcpToolCall[]>
  readonly plan: ISettableObservable<readonly AcpPlanEntry[]>
  readonly timeline: ISettableObservable<readonly TimelineItem[]>
  readonly status: ISettableObservable<AcpSessionStatus>
  readonly isReplayingHistory: ISettableObservable<boolean>
  readonly usage: ISettableObservable<AcpUsage | undefined>
  readonly pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  readonly pendingQuestion: ISettableObservable<AcpPendingQuestion | undefined>
  readonly availableCommands: ISettableObservable<readonly AvailableCommand[]>
  readonly mcpServers: ISettableObservable<readonly AcpMcpServerStatus[]>
  readonly collapseMode: ISettableObservable<CollapseMode>
  readonly accumulatedRunningMs: ISettableObservable<number>
  readonly runningStartedAt: ISettableObservable<number | undefined>

  private readonly _onDidRequireAuth = this._register(new Emitter<void>())
  readonly onDidRequireAuth: Event<void> = this._onDidRequireAuth.event

  private readonly _configOptions: ConfigOptionStateMachine

  private _messages: AcpMessage[] = []
  private _toolCalls: AcpToolCall[] = []
  private _timeline: TimelineItem[] = []
  private _msgCounter = 0

  /** Abort controllers for all in-flight `session/prompt` calls (concurrent steering). */
  private readonly _inFlight = new Set<AbortController>()
  /** Latches 'errored' once all in-flight settle if any of them failed. */
  private _sawError = false

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

  /**
   * Latest title derived/generated before the agent id existed. Re-applied to
   * the history row from {@link attachConnection} once the row is in place.
   */
  private _pendingTitle: string | undefined

  /**
   * Provenance of {@link _pendingTitle}: `'ai'` (session-title model),
   * `'manual'` (user rename), or `undefined` (first-prompt fallback). AI and
   * manual titles are flagged on the history row and pushed back to the agent so
   * they survive `/compact` + the next `session/list`; the fallback is not.
   */
  private _pendingTitleKind: TitleKind = undefined

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
   * Monotonic counter bumped on every inbound `session/update`. Compared
   * against a prompt's dispatch-time baseline to tell "the turn produced no
   * output" (safe to auto-resend) from "partial output exists" (continue
   * instead, or the transcript duplicates the turn).
   */
  private _applyUpdateCount = 0

  /** Wall-clock of the last inbound update — read by the service's stall watchdog. */
  private _lastActivityAt = Date.now()

  /** True while a hot-reconnect is in progress (connection lost → reattached). */
  private _reconnecting = false

  /** Set when the connection died mid-turn; consumed by {@link continueInterruptedTurn}. */
  private _turnInterrupted = false

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
    this.pendingQuestion = observableValue<AcpPendingQuestion | undefined>(
      `acp.session.pendingQuestion.${id}`,
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
    this.collapseMode = observableValue<CollapseMode>(
      `acp.session.collapseMode.${id}`,
      initialCollapseMode,
    )
    this.accumulatedRunningMs = observableValue<number>(`acp.session.accumulatedRunningMs.${id}`, 0)
    this.runningStartedAt = observableValue<number | undefined>(
      `acp.session.runningStartedAt.${id}`,
      undefined,
    )
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
    const onClose = (): void => {
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
      this.status.set('closed', undefined)
      this._cancelPending()
      this._abortAllInFlight()
    }
    if (conn.conn.signal.aborted) {
      // The pooled connection is already dead at attach time. With a live phase
      // still 'connecting' this is a startup failure — seal, no recovery.
      onClose()
      return
    }
    conn.conn.signal.addEventListener('abort', onClose, { once: true })
    this._register({
      dispose: () => conn.conn.signal.removeEventListener('abort', onClose),
    })
    // Leave a terminal status (closed) untouched; otherwise settle to idle and
    // drain the queue.
    if (this.status.get() === 'connecting') this.status.set('idle', undefined)
    // Re-apply any title derived while connecting now that the history row exists.
    if (this._pendingTitle !== undefined) {
      this._applyHistoryTitle(sessionIdOnAgent, this._pendingTitle, this._pendingTitleKind)
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
    if (this.status.get() === 'connecting') {
      this._appendMessage('agent', `[error] ${message}`)
      this.status.set('errored', undefined)
    }
  }

  whenConnected(): Promise<void> {
    return this._connection.whenSettled()
  }

  /** Auto-recovery state (retry / reconnect progress) for the UI; undefined when healthy. */
  get recoveryState(): IObservable<AcpRecoveryState | undefined> {
    return this.recovery.state
  }

  /** True while a hot-reconnect is in progress — the service's recovery loop gates on this. */
  get isReconnecting(): boolean {
    return this._reconnecting
  }

  /** Wall-clock of the last inbound session/update — read by the stall watchdog. */
  get lastActivityAt(): number {
    return this._lastActivityAt
  }

  /**
   * The agent process died (or was declared stalled) while this session was
   * live. Instead of sealing, park the session back in `connecting`: the
   * timeline is kept, in-flight prompts are aborted, new prompts queue, and
   * the service is notified to re-handshake in place.
   */
  private _handleConnectionLost(reason: 'crash' | 'stalled'): void {
    if (this._reconnecting) return
    this._reconnecting = true
    const deadLease = this._conn
    this._commitBatchedTx()
    this._finalizeRunningSegment()
    this._cancelPending()
    this._turnInterrupted = this._inFlight.size > 0
    this._abortAllInFlight()
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
    })
    this._onDidLoseConnection.fire({ reason })
  }

  /** Watchdog entry point: the turn went silent past the stall threshold. */
  handleStall(): void {
    if (this.status.get() === 'closed' || this.readOnly || this._reconnecting) return
    this._handleConnectionLost('stalled')
  }

  /**
   * Service-driven: bind the fresh connection after a successful hot-reconnect
   * (`session/resume` against the same durable id — no history replay, the
   * timeline is already complete locally).
   */
  reattachConnection(conn: IAcpClientConnection): void {
    const sid = this.sessionIdOnAgent.get()
    if (sid === undefined || this.status.get() === 'closed') {
      conn.dispose()
      return
    }
    this.attachConnection(conn, sid)
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
    if (this.status.get() === 'closed') return
    const last = this._lastDispatch
    if (last !== undefined && this._applyUpdateCount === last.baseline) {
      await this._dispatchPrompt(last.text, last.refs, last.contexts, last.images, last.messageId)
      return
    }
    const messageId = generateUuid()
    this._appendMessage('user', CONTINUE_PROMPT_TEXT, [], messageId)
    await this._dispatchPrompt(CONTINUE_PROMPT_TEXT, [], [], [], messageId)
  }

  /**
   * Service-driven: automatic reconnect attempts ran out. Seal the (dead)
   * connection so queued prompts reject, surface the error, and park in
   * `errored` — the UI offers a manual reconnect via {@link retryRecovery}.
   */
  sealRecoveryFailure(message: string): void {
    this._reconnecting = false
    this._turnInterrupted = false
    this.recovery.set({
      phase: 'exhausted',
      attempt: MAX_RECOVERY_ATTEMPTS,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
      reason: 'reconnect',
    })
    this._connection.fail(message)
    this._appendMessage('agent', `[error] ${message}`)
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
      this._connection.fail('reconnect cancelled')
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
  }

  endHistoryReplay(): void {
    this.isReplayingHistory.set(false, undefined)
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
  }

  /**
   * Refresh connection status from the Claude SDK system-init snapshot
   * (`mcp_servers: { name, status }[]`). Merges onto the config-seeded list,
   * preserving the known transport; servers present only in the snapshot are
   * appended with no transport.
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

  presentQuestion(q: AcpPendingQuestion): void {
    // Replace any prior pending question — only one carousel at a time.
    this._cancelPendingQuestion()
    this.pendingQuestion.set(q, undefined)
  }

  private _cancelPendingPermission(): void {
    const cur = this.pendingPermission.get()
    if (cur) {
      this.pendingPermission.set(undefined, undefined)
      cur.cancel()
    }
  }

  private _cancelPendingQuestion(): void {
    const cur = this.pendingQuestion.get()
    if (cur) {
      this.pendingQuestion.set(undefined, undefined)
      cur.cancel()
    }
  }

  private _cancelPending(): void {
    this._cancelPendingPermission()
    this._cancelPendingQuestion()
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
    // Client-generated anchor for this user turn. Stamped on the local message
    // now (so rewind/fork can target it even before dispatch) and sent as
    // PromptRequest.messageId; the agent echoes it back as userMessageId.
    const messageId = generateUuid()
    // Always surface the user's message immediately, even while connecting, so
    // typing feels instant. The wire dispatch is deferred until the connection
    // is ready (queued) so the prompt is not lost.
    this._appendMessage('user', text, composeImageBlocks(images ?? []), messageId)
    void this._maybeGenerateTitle(text)
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
    await this._dispatchPrompt(text, refs ?? [], contexts ?? [], images ?? [], messageId)
  }

  /**
   * Send one prompt over the (already-attached) connection. Assumes
   * `this._conn` / `sessionIdOnAgent` are set — only called post-attach (direct
   * dispatch or queue flush). Does NOT append the user message; the caller
   * (`sendPrompt`) already did so the message shows immediately even while the
   * prompt was queued.
   */
  private async _dispatchPrompt(
    text: string,
    refs: readonly PlacedRef[],
    contexts: readonly SelectionContext[],
    images: readonly PromptImage[],
    messageId: string,
  ): Promise<void> {
    const conn = this._conn
    const sid = this.sessionIdOnAgent.get()
    if (conn === undefined || sid === undefined) return
    // Bump the history entry's lastUsedAt so the LRU order tracks user activity.
    this._history?.touch(sid)
    this._history?.setHistoryHasMessages(sid)
    const prompt = composePromptBlocksFromRefs(text, refs)
    // Attached selections lead the prompt as context blocks (EmbeddedResource
    // when the agent supports it, else a fenced-code text block).
    const contextBlocks = composeContextBlocks(contexts, this._embeddedContextSupported)
    // Attached images lead the prompt as `image` ContentBlocks (after any
    // selection context, before the user's text).
    const imageBlocks = composeImageBlocks(images)
    const body = prompt.length > 0 ? [...prompt] : [{ type: 'text' as const, text }]
    const params: PromptRequest = {
      sessionId: sid,
      // The client-generated anchor for this user turn so rewind/fork can later
      // target this exact turn. Sent BOTH as the standard top-level `messageId`
      // (for spec-compliant agents) and inside `_meta` — the built-in claude fork
      // runs an older ACP schema that strips unknown top-level fields in zod
      // validation, but passes `_meta` through untouched, so `_meta.messageId` is
      // what actually reaches it.
      messageId,
      _meta: { messageId },
      // Fall back to a single text block for empty/no-mention prompts so we
      // keep the wire shape stable even for trivial cases.
      prompt: [...contextBlocks, ...imageBlocks, ...body],
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
      baseline: this._applyUpdateCount,
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
        return
      } catch (err) {
        if (err instanceof AcpAbortError) {
          // '[cancelled]' is appended once by cancelTurn — appending here would
          // duplicate it when several concurrent prompts abort together.
          this._telemetry.publicLog('acp.prompt_cancelled', { sessionId: sid })
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
        if (!continued && this._applyUpdateCount !== snapshot.baseline) {
          continued = true
          const continueId = generateUuid()
          currentMessageId = continueId
          this._appendMessage('user', CONTINUE_PROMPT_TEXT, [], continueId)
          params = {
            sessionId: sid,
            messageId: continueId,
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
          return
        }
        continue
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
          baseline: this._applyUpdateCount,
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
      if (isAuthRequiredError(failure)) this._onDidRequireAuth.fire()
      return
    }
  }

  async cancelTurn(): Promise<void> {
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
    if (had) this._appendMessage('agent', '[cancelled]')
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
    if (conn === undefined || sid === undefined) return undefined
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

    if (!dryRun) await this.cancelTurn()

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
    this._setImmediate(this.messages, this._messages)
    this._setImmediate(this.toolCalls, this._toolCalls)
    this._setImmediate(this.timeline, this._timeline)
    this._setImmediate(this.plan, [])
  }

  private _recomputeStatus(): void {
    if (this.status.get() === 'closed') return // closed is terminal
    // Mid hot-reconnect the status is pinned to 'connecting' by the recovery
    // path; aborted in-flight prompts settling must not flip it to idle.
    if (this._reconnecting) return
    const prev = this.status.get()
    if (this._inFlight.size > 0) {
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
   * `kind` marks a non-fallback title (`'ai'` model-generated, `'manual'` user
   * rename): it is flagged on the history row (so the hydrate sweep won't clobber
   * it with the agent's first-prompt `summary`) and pushed back to the agent via
   * the set-title ext-method, so the title survives `/compact` and the next
   * `session/list`.
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
    // flagged aiTitle/manualTitle (e.g. a rename after the AI title). The
    // first-prompt-derived title (kind undefined) is not: it never overwrites a
    // protected row.
    const overwriteProtectedTitle = kind !== undefined
    this._history?.updateInfo(sessionIdOnAgent, { title }, { overwriteProtectedTitle })
    if (kind === 'ai') {
      this._history?.setHistoryAiTitle(sessionIdOnAgent)
      this._pushTitleToAgent(sessionIdOnAgent, title)
    } else if (kind === 'manual') {
      this._history?.setHistoryManualTitle(sessionIdOnAgent)
      this._pushTitleToAgent(sessionIdOnAgent, title)
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
   */
  private _pushTitleToAgent(sessionIdOnAgent: string, title: string): void {
    const conn = this._conn
    if (conn === undefined) return
    void conn.conn
      .extMethod(SET_SESSION_TITLE_METHOD, { sessionId: sessionIdOnAgent, title })
      .catch(() => {
        // best-effort — unsupported agent or transient failure; local title stands.
      })
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
    const derived = text.trim().replace(/\s+/g, ' ').slice(0, 30)
    if (derived.length === 0) return
    this._titleDerived = true
    this._setHistoryTitle(derived, undefined)
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
    this._titleGenerated = true
    const agentText = this._messages.find((m) => m.role === 'agent')?.text ?? ''
    const title = await this._titleService.generateTitle(userText, agentText)
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
    this.status.set('closed', undefined)
    // Cancel any pending recovery attempt so a service-side reconnect loop
    // observing this session bails instead of reattaching a closed session.
    this._reconnecting = false
    this._turnInterrupted = false
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
      this._terminalOutput.set(toolCallId, chunk.mode === 'append' ? prev + chunk.data : chunk.data)
    }
    return this._terminalOutput.get(toolCallId)
  }

  applyUpdate(update: SessionUpdate): void {
    const sid = this.sessionIdOnAgent.get()
    // Liveness bookkeeping: the counter backs zero-output detection for prompt
    // retry, the timestamp backs the service's stall watchdog.
    this._applyUpdateCount++
    this._lastActivityAt = Date.now()
    const parentId = readParentToolUseId(update)
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      for (const change of readFileChanges(update)) {
        if (sid !== undefined) {
          this._changeTracker?.record(
            sid,
            change.path,
            update.toolCallId,
            change.hunks,
            change.isCreate,
          )
        }
      }
    }
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this._appendChunk('user', update.content, parentId, readMessageId(update))
        break
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
        const { blocks, diffs } = splitToolCallContent(update.content ?? [])
        const locations = readToolCallLocations(update.locations)
        const mcpServer = readMcpServer(update)
        const mcpTool = readMcpTool(update)
        const terminalText = this._accumulateTerminalOutput(update.toolCallId, update)
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
            ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
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
        const blocks = split?.blocks ?? existing?.blocks ?? []
        const diffs = split?.diffs ?? existing?.diffs ?? []
        const mcpServer = readMcpServer(update) ?? existing?.mcpServer
        const mcpTool = readMcpTool(update) ?? existing?.mcpTool
        // `locations` is a full replacement when present (SDK "replace the
        // locations collection"); carry the last known set forward otherwise so
        // a late `_meta`-only update doesn't drop the clickable path.
        const locations = readToolCallLocations(update.locations) ?? existing?.locations
        const terminalText = this._accumulateTerminalOutput(update.toolCallId, update)
        const rawInput = update.rawInput !== undefined ? update.rawInput : existing?.rawInput
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
            patch.title = update.title
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
        // Agents that don't report authoritative cost (Codex) estimate it locally
        // from the session-cumulative per-model token counts stamped on every
        // usage_update. Take the latest snapshot — it already folds in every call,
        // so no accumulation.
        const localCost = this._costStrategy?.fromUsageUpdate((update as { _meta?: unknown })._meta)
        if (localCost != null) {
          const next: AcpUsage = {
            used: update.used,
            size: update.size,
            cost: localCost.cost,
            models: localCost.models,
            costEstimated: true,
          }
          this.usage.set(next, tx)
          if (sid !== undefined) this._history?.setHistoryUsage(sid, next)
          break
        }
        const models = extractModelBreakdown(update)
        // `cost` / `models` only ride on the turn-final usage_update (derived
        // from the SDK `result` message). Mid-stream updates emitted while a
        // turn runs carry only used/size, so carry the last known cost forward
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
  }

  setConfigOption(configId: string, value: string): Promise<void> {
    // Read-only preview: never mutate the foreign session's agent-side config.
    if (this.readOnly) return Promise.resolve()
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
    const echoed = (response as { userMessageId?: string | null }).userMessageId
    if (echoed == null || echoed === sentId) return
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
    const estimate = this._costStrategy?.fromPromptResponse(response)
    if (estimate == null) return

    const tx = this._batchedTx()
    const prev = this.usage.get()
    const next: AcpUsage = {
      used: prev?.used ?? 0,
      size: prev?.size ?? 0,
      cost: estimate.cost,
      models: estimate.models,
      costEstimated: true,
    }
    this.usage.set(next, tx)
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._history?.setHistoryUsage(sid, next)
  }

  /**
   * Attach a locally-estimated USD cost to a sub-agent tally. The agent never
   * reports a per-sub-agent cost, so we price the tokens against the model's
   * published rates (Claude only — codex reports no per-sub-agent tokens). Leaves
   * `costUSD` unset when no model is known, so the UI can hide the cost.
   */
  private _priceSubagentStats(stats: AcpSubagentStats): AcpSubagentStats {
    if (stats.model === undefined) return stats
    const costUSD = estimateClaudeCostUSD(stats.model, {
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheReadTokens: stats.cacheReadTokens,
      cacheCreateTokens: stats.cacheCreateTokens,
    })
    return { ...stats, costUSD }
  }

  private _appendChunk(
    role: AcpMessageRole,
    block: ContentBlock,
    parentId?: string,
    messageId?: string,
  ): void {
    if (parentId != null) {
      this._appendChildChunk(role, block, parentId)
      return
    }
    const last = this._messages[this._messages.length - 1]
    let next: AcpMessage
    if (last && last.role === role && this._isStreaming(last.id)) {
      const blocks = mergeStreamingBlock(last.blocks, block)
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
      const blocks: readonly ContentBlock[] = [block]
      next = {
        id,
        role,
        blocks,
        text: blocksToText(blocks),
        streaming: true,
        ...(messageId !== undefined ? { messageId } : {}),
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
    }
    this._messages = [...this._messages, message]
    this._upsertMessageInTimeline(message)
    // Atomic + synchronous: write both observables on the batched tx then commit
    // immediately. Folding in any chunk tx already pending keeps messages and
    // timeline from being observed in a torn intermediate state (e.g. a
    // mid-stream `[cancelled]`/`[error]` sentinel landing between two chunks).
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
   */
  applyCompaction(id: string, phase: AcpCompactionPhase, reason?: string): void {
    if (this.readOnly) return
    const slotId = `compaction:${id}`
    const idx = this._timeline.findIndex((it) => it.kind === 'compaction' && it.id === slotId)
    const prev = idx === -1 ? undefined : this._timeline[idx]
    const prevStartedAt = prev?.kind === 'compaction' ? prev.compaction.startedAt : undefined
    const prevExpected =
      prev?.kind === 'compaction' ? prev.compaction.expectedDurationMs : undefined
    // The SDK compaction has no true progress; the card shows a live stopwatch
    // from `startedAt`. Stamp it when `running` begins, then settle a fixed
    // `durationMs` at the terminal phase so the elapsed time freezes.
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
      const blocks = mergeStreamingBlock(last.message.blocks, block)
      const message: AcpMessage = {
        ...last.message,
        blocks,
        text: blocksToText(blocks),
      }
      next = [...children.slice(0, -1), { kind: 'message', id: message.id, message }]
    } else {
      if (isBlankContentBlock(block)) return
      const id = `m${++this._msgCounter}`
      const blocks: readonly ContentBlock[] = [block]
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
