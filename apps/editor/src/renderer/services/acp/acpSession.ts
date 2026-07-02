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
import type { CollapseMode } from './acpChatViewStateCache.js'
import { ConfigOptionStateMachine } from './acpSessionConfigOptions.js'
import { AcpSessionConnection, type QueuedPrompt } from './acpSessionConnection.js'
import { isAuthRequiredError } from './acpAuthError.js'
import { composePromptBlocks, type PromptMention } from './promptMentions.js'
import { composeContextBlocks, type SelectionContext } from './promptContext.js'
import { composeImageBlocks, type PromptImage } from './promptImage.js'
import { extractCodexModelUsage, extractCodexTurnUsage } from '../../../shared/ai/codexPricing.js'
import { estimateCodexCost } from './acpSessionCost.js'
import {
  blocksToText,
  isBlankContentBlock,
  mergeStreamingBlock,
  splitToolCallContent,
} from './acpSessionContent.js'
import {
  extractModelBreakdown,
  readFileChanges,
  readMcpServer,
  readParentToolUseId,
  readTerminalOutput,
} from './acpSessionUpdateMeta.js'
import {
  AcpAbortError,
  SET_SESSION_TITLE_METHOD,
  type AcpChildItem,
  type AcpMcpServerStatus,
  type AcpMessage,
  type AcpMessageRole,
  type AcpPendingPermission,
  type AcpPendingQuestion,
  type AcpPlanEntry,
  type AcpSessionStatus,
  type AcpToolCall,
  type AcpToolCallStatus,
  type AcpUsage,
  type IAcpSession,
  type IAcpSessionInitState,
  type TimelineItem,
} from './acpSessionModel.js'

// Re-export the view-model types + helpers that moved to sibling modules, so the
// many `from '.../acpSession.js'` import sites across the renderer keep working.
export {
  AcpAbortError,
  ASK_USER_QUESTION_METHOD,
  SET_SESSION_TITLE_METHOD,
} from './acpSessionModel.js'
export type {
  AcpChildItem,
  AcpMcpServerStatus,
  AcpMessage,
  AcpMessageRole,
  AcpModelCost,
  AcpPendingPermission,
  AcpPendingQuestion,
  AcpPlanEntry,
  AcpPlanEntryStatus,
  AcpSessionStatus,
  AcpToolCall,
  AcpToolCallDiff,
  AcpToolCallStatus,
  AcpUsage,
  AskUserQuestion,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  IAcpSession,
  IAcpSessionInitState,
  TimelineItem,
} from './acpSessionModel.js'
export {
  blocksToText,
  hasVisibleMessageContent,
  isBlankContentBlock,
  mergeStreamingBlock,
  splitToolCallContent,
  timelineItemToText,
  toolCallToText,
} from './acpSessionContent.js'

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
   * Latest title derived/generated before the agent id existed. Re-applied to
   * the history row from {@link attachConnection} once the row is in place.
   */
  private _pendingTitle: string | undefined

  /**
   * Whether {@link _pendingTitle} came from the AI title model (vs. the
   * first-prompt fallback). AI titles are flagged on the history row and pushed
   * back to the agent so they survive `/compact` + the next `session/list`.
   */
  private _pendingTitleIsAi = false

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
  ) {
    super()
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
    // Cache the embeddedContext capability so _dispatchPrompt can shape attached
    // selection contexts without awaiting the initialize response per prompt.
    conn.initializeResult
      .then((res) => {
        const caps = res.agentCapabilities?.promptCapabilities
        this._embeddedContextSupported = caps?.embeddedContext === true
        this.imageSupported.set(caps?.image === true, undefined)
      })
      .catch(() => {})
    this.sessionIdOnAgent.set(sessionIdOnAgent, undefined)
    // Connection close → seal the session.
    const onClose = (): void => {
      this._commitBatchedTx()
      this._finalizeRunningSegment()
      this.status.set('closed', undefined)
      this._cancelPending()
      this._abortAllInFlight()
    }
    if (conn.conn.signal.aborted) {
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
      this._applyHistoryTitle(sessionIdOnAgent, this._pendingTitle, this._pendingTitleIsAi)
    }
    this._flushQueuedPrompts(drained)
    // Now that the connection + sessionId exist, push any configOption values
    // that were overridden for display but not yet adopted by the agent.
    this._configOptions.flushPendingPushes()
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

  beginHistoryReplay(): void {
    this.isReplayingHistory.set(true, undefined)
  }

  endHistoryReplay(): void {
    this.isReplayingHistory.set(false, undefined)
  }

  private _flushQueuedPrompts(queued: readonly QueuedPrompt[]): void {
    for (const q of queued) {
      this._dispatchPrompt(q.text, q.mentions, q.contexts, q.images).then(q.resolve, q.reject)
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
    mentions?: readonly PromptMention[],
    contexts?: readonly SelectionContext[],
    images?: readonly PromptImage[],
  ): Promise<void> {
    // Read-only preview session (foreign worktree): viewing only, no dispatch.
    if (this.readOnly) return
    // 顺序敏感：派生 title 必须发生在 _appendMessage 之前——它依赖 _messages 仍为空来识别首条 prompt。
    this._maybeDeriveTitleFromPrompt(text)
    // Always surface the user's message immediately, even while connecting, so
    // typing feels instant. The wire dispatch is deferred until the connection
    // is ready (queued) so the prompt is not lost.
    this._appendMessage('user', text, composeImageBlocks(images ?? []))
    void this._maybeGenerateTitle(text)
    // Still connecting — buffer the prompt; the returned promise settles when it
    // is eventually dispatched (on connect) or rejected (on connection failure).
    if (!this._connection.isSettled) {
      try {
        await this._connection.enqueue(text, mentions ?? [], contexts ?? [], images ?? [])
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
    await this._dispatchPrompt(text, mentions ?? [], contexts ?? [], images ?? [])
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
    mentions: readonly PromptMention[],
    contexts: readonly SelectionContext[],
    images: readonly PromptImage[],
  ): Promise<void> {
    const conn = this._conn
    const sid = this.sessionIdOnAgent.get()
    if (conn === undefined || sid === undefined) return
    // Bump the history entry's lastUsedAt so the LRU order tracks user activity.
    this._history?.touch(sid)
    this._history?.setHistoryHasMessages(sid)
    const prompt = composePromptBlocks(text, mentions)
    // Attached selections lead the prompt as context blocks (EmbeddedResource
    // when the agent supports it, else a fenced-code text block).
    const contextBlocks = composeContextBlocks(contexts, this._embeddedContextSupported)
    // Attached images lead the prompt as `image` ContentBlocks (after any
    // selection context, before the user's text).
    const imageBlocks = composeImageBlocks(images)
    const body = prompt.length > 0 ? [...prompt] : [{ type: 'text' as const, text }]
    const params: PromptRequest = {
      sessionId: sid,
      // Fall back to a single text block for empty/no-mention prompts so we
      // keep the wire shape stable even for trivial cases.
      prompt: [...contextBlocks, ...imageBlocks, ...body],
    }
    const abort = new AbortController()
    this._inFlight.add(abort)
    // Status is derived from the in-flight set — never set directly per prompt,
    // so N concurrent steering prompts stay 'running' until the last settles.
    this._recomputeStatus()
    this._telemetry.publicLog('acp.prompt_sent', { sessionId: sid })
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new AcpAbortError())
      if (abort.signal.aborted) onAbort()
      else abort.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const response = await Promise.race([conn.conn.prompt(params), abortPromise])
      this._ingestPromptResponse(response)
    } catch (err) {
      if (err instanceof AcpAbortError) {
        // '[cancelled]' is appended once by cancelTurn — appending here would
        // duplicate it when several concurrent prompts abort together.
        this._telemetry.publicLog('acp.prompt_cancelled', { sessionId: sid })
      } else {
        this._sawError = true
        this._appendMessage('agent', `[error] ${(err as Error).message}`)
        this._telemetry.publicLogError('acp.prompt_failed', {
          sessionId: sid,
          error: (err as Error).message,
        })
        if (isAuthRequiredError(err)) this._onDidRequireAuth.fire()
      }
    } finally {
      this._inFlight.delete(abort)
      // Only flush once the last in-flight prompt settles — flushing mid-turn
      // would clear the streaming caret while another prompt is still emitting
      // chunks, splitting its output into a fresh card.
      if (this._inFlight.size === 0) this._flushStream()
      this._recomputeStatus()
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

  private _recomputeStatus(): void {
    if (this.status.get() === 'closed') return // closed is terminal
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
   * Mirror a title onto the durable history entry, keyed by the agent-issued id.
   * While the session is still connecting that id is undefined and the row does
   * not exist yet, so we buffer the title and re-apply it from
   * {@link attachConnection} once the entry is in place.
   *
   * `isAi` marks an AI-model-generated title: it is flagged on the history row
   * (so the hydrate sweep won't clobber it with the agent's first-prompt
   * `summary`) and pushed back to the agent via `renameSession`, so the title
   * survives `/compact` and the next `session/list`.
   */
  private _setHistoryTitle(title: string, isAi: boolean): void {
    this._pendingTitle = title
    this._pendingTitleIsAi = isAi
    const sid = this.sessionIdOnAgent.get()
    if (sid !== undefined) this._applyHistoryTitle(sid, title, isAi)
  }

  /** Write the title to the history row and, for AI titles, push it to the agent. */
  private _applyHistoryTitle(sessionIdOnAgent: string, title: string, isAi: boolean): void {
    this._history?.updateInfo(sessionIdOnAgent, { title })
    if (isAi) {
      this._history?.setHistoryAiTitle(sessionIdOnAgent)
      this._pushTitleToAgent(sessionIdOnAgent, title)
    }
  }

  /**
   * Persist an AI title onto the agent's durable store so it survives `/compact`
   * and is reported by `session/list` from other workspaces. Both the Claude and
   * Codex forks back this ext-method (Claude via `renameSession`, Codex via
   * `thread/name/set`). Best-effort + fire-and-forget: an agent that doesn't
   * implement it rejects with methodNotFound and we keep the local-only title,
   * which the `aiTitle` history flag still protects from hydrate overwrites.
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
    if (!this._history) return
    if (this._messages.length > 0) return
    const derived = text.trim().replace(/\s+/g, ' ').slice(0, 30)
    if (derived.length === 0) return
    this._setHistoryTitle(derived, false)
  }

  /**
   * Ask the session-title model for a friendly title as soon as the first user
   * message is sent, and overwrite the first-prompt-derived one. Runs at most
   * once per session and degrades silently. Fire-and-forget.
   */
  private async _maybeGenerateTitle(userText: string): Promise<void> {
    if (this._titleGenerated) return
    if (!this._history || !this._titleService) return
    this._titleGenerated = true
    const agentText = this._messages.find((m) => m.role === 'agent')?.text ?? ''
    const title = await this._titleService.generateTitle(userText, agentText)
    if (title === undefined || this.status.get() === 'closed') return
    this._setHistoryTitle(title, true)
  }

  async close(): Promise<void> {
    this._commitBatchedTx()
    this._finalizeRunningSegment()
    this.status.set('closed', undefined)
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
        this._appendChunk('user', update.content, parentId)
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
        const mcpServer = readMcpServer(update)
        const terminalText = this._accumulateTerminalOutput(update.toolCallId, update)
        this._upsertToolCall(
          {
            id: update.toolCallId,
            title: update.title,
            kind: update.kind ?? 'unknown',
            status: (update.status as AcpToolCallStatus | undefined) ?? 'pending',
            blocks,
            diffs,
            text: terminalText ?? blocksToText(blocks),
            ...(mcpServer !== undefined ? { mcpServer } : {}),
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
        const terminalText = this._accumulateTerminalOutput(update.toolCallId, update)
        const next: AcpToolCall = {
          id: update.toolCallId,
          title: update.title != null ? update.title : (existing?.title ?? update.toolCallId),
          kind: update.kind != null ? update.kind : (existing?.kind ?? 'unknown'),
          status: (update.status as AcpToolCallStatus | undefined) ?? existing?.status ?? 'pending',
          blocks,
          diffs,
          text: terminalText ?? blocksToText(blocks),
          ...(mcpServer !== undefined ? { mcpServer } : {}),
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
        // Codex estimates cost locally from the session-cumulative per-model token
        // counts it stamps on every usage_update (one per model call). Take the
        // latest snapshot — it already folds in every call, so no accumulation.
        const codexCost =
          this.agentId === 'codex'
            ? estimateCodexCost(extractCodexModelUsage((update as { _meta?: unknown })._meta))
            : undefined
        if (codexCost != null) {
          const next: AcpUsage = {
            used: update.used,
            size: update.size,
            cost: codexCost.cost,
            models: codexCost.models,
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
   * Finalize the locally-estimated Codex cost from the prompt response. Codex
   * never reports an authoritative cost, so we estimate from the session-
   * cumulative per-model token counts the fork stamps on the response. This is a
   * safety net — `usage_update` already refreshes the estimate on every model
   * call (see the usage_update case); the response just confirms the final total.
   * No-op for Claude, which reports real cost.
   */
  private _ingestPromptResponse(response: PromptResponse): void {
    if (this.agentId !== 'codex') return
    const usages = extractCodexTurnUsage(response)
    const estimate = estimateCodexCost(usages)
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

  private _appendChunk(role: AcpMessageRole, block: ContentBlock, parentId?: string): void {
    if (parentId != null) {
      this._appendChildChunk(role, block, parentId)
      return
    }
    const last = this._messages[this._messages.length - 1]
    let next: AcpMessage
    if (last && last.role === role && this._isStreaming(last.id)) {
      const blocks = mergeStreamingBlock(last.blocks, block)
      next = { id: last.id, role, blocks, text: blocksToText(blocks), streaming: true }
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
      next = { id, role, blocks, text: blocksToText(blocks), streaming: true }
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
  ): void {
    const id = `m${++this._msgCounter}`
    // Image (or other) blocks lead, then the text block. Skip an empty text
    // block so an image-only message doesn't carry a blank paragraph.
    const textBlocks: readonly ContentBlock[] = text.length > 0 ? [{ type: 'text', text }] : []
    const blocks: readonly ContentBlock[] = [...leadingBlocks, ...textBlocks]
    const message: AcpMessage = { id, role, blocks, text, streaming: false }
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
