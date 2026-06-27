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
  ToolCallContent,
} from '@agentclientprotocol/sdk'
import type { IAcpClientConnection } from './acpClientService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import type { ISessionChangeTrackerService } from './sessionChangeTracker.js'
import type { IAcpSessionTitleService } from './acpSessionTitleService.js'
import type { DiffHunk } from './diff/reconstructBaseline.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import { ConfigOptionStateMachine } from './acpSessionConfigOptions.js'
import { isAuthRequiredError } from './acpAuthError.js'
import { composePromptBlocks, type PromptMention } from './promptMentions.js'
import { parseMcpToolName, type McpTransport } from './acpMcpServers.js'
import {
  estimateCodexCostUSD,
  extractCodexModelUsage,
  extractCodexTurnUsage,
  type CodexModelUsage,
} from '../../../shared/ai/codexPricing.js'

// ---------------------------------------------------------------------------
// Public view model
// ---------------------------------------------------------------------------

export type AcpMessageRole = 'user' | 'agent' | 'thought'

export interface AcpMessage {
  readonly id: string
  readonly role: AcpMessageRole
  /** Plain-text view of `blocks`, computed via {@link blocksToText}. */
  readonly text: string
  /** Structured content blocks — used by the renderer for markdown / images / resource links. */
  readonly blocks: readonly ContentBlock[]
  /** True while this message is still receiving streaming chunks; the UI uses this to render a blinking caret. */
  readonly streaming: boolean
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface AcpToolCallDiff {
  readonly path: string
  /** Empty string when the agent reported `null` (i.e. file creation). */
  readonly oldText: string
  readonly newText: string
}

export interface AcpToolCall {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: AcpToolCallStatus
  /** Plain-text view of `blocks`. */
  readonly text: string
  /**
   * Tool call output normalized into ContentBlock[]. ToolCallContent variants
   * `content` are unwrapped; `terminal` is converted to a placeholder text block.
   * `diff` entries are *not* included here — they live in `diffs` so the UI can
   * render a dedicated diff preview.
   */
  readonly blocks: readonly ContentBlock[]
  /** Structured diff entries extracted from ToolCallContent.diff. */
  readonly diffs: readonly AcpToolCallDiff[]
  /**
   * Sub-agent timeline: message / tool_call updates the agent tagged with this
   * call's id via `_meta.claudeCode.parentToolUseId` (e.g. a Task tool spawning
   * a subagent). Nested one level deep — the UI folds these inside the parent
   * card so the subagent's chatter stays out of the main timeline.
   */
  readonly children?: readonly AcpChildItem[]
  /**
   * Source MCP server name when this tool call is an MCP tool. Derived from the
   * agent fork's `_meta.claudeCode.toolName` (`mcp__<server>__<tool>`). Absent
   * for built-in tools. Drives the "MCP · <server>" attribution badge.
   */
  readonly mcpServer?: string
}

/**
 * One slot inside a parent tool call's {@link AcpToolCall.children}. Structurally
 * identical to {@link TimelineItem} but named separately to make the nesting
 * explicit. Only one level of nesting is supported — a child tool call's own
 * `children` is never populated.
 */
export type AcpChildItem =
  | { readonly kind: 'message'; readonly id: string; readonly message: AcpMessage }
  | { readonly kind: 'toolCall'; readonly id: string; readonly call: AcpToolCall }

export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed'

export interface AcpPlanEntry {
  readonly content: string
  readonly status: AcpPlanEntryStatus
  readonly priority?: string
}

/**
 * Observable view of one configured/connected MCP server. `status` is the raw
 * string from the Claude SDK system-init snapshot (e.g. `connected` / `failed`
 * / `needs-auth` / `pending`). `transport` is seeded from the `acp.mcpServers`
 * config; servers that only appear in the init snapshot (agent-provided) have
 * no known transport.
 */
export interface AcpMcpServerStatus {
  readonly name: string
  readonly status: string
  readonly transport?: McpTransport
}

/**
 * A single slot on the unified chat timeline. The UI renders one ordered list
 * of these so message / tool_call cards interleave by arrival order, matching
 * Copilot-style agent chat layout. Plan is *not* a timeline slot — it lives on
 * the dedicated `plan` observable and is rendered as a sticky bar above the
 * scroll, so it stays pinned instead of being pushed out of view by later items.
 *
 * Slot identity rules:
 * - `kind: 'message'` reuses the underlying `message.id` so React keys are
 *   stable across chunk merges.
 * - `kind: 'toolCall'` reuses the agent-issued `toolCallId` so `tool_call_update`
 *   replaces the existing slot in place.
 */
export type TimelineItem =
  | { readonly kind: 'message'; readonly id: string; readonly message: AcpMessage }
  | { readonly kind: 'toolCall'; readonly id: string; readonly call: AcpToolCall }

export interface AcpPendingPermission {
  readonly toolCallId: string
  readonly title: string
  readonly kind?: string
  readonly options: readonly {
    readonly optionId: string
    readonly name: string
    readonly kind?: string
  }[]
  resolve(optionId: string): void
  cancel(): void
}

/**
 * ACP extension method carrying the `AskUserQuestion` round-trip. The built-in
 * agent (vendor/claude-agent-acp) sends questions over this method and expects
 * the user's answers back. The string is shared verbatim with the agent fork's
 * `interactive.ts` — keep both in sync.
 */
export const ASK_USER_QUESTION_METHOD = 'universe-editor/ask_user_question'

/**
 * Custom ACP request that persists an AI-generated session title onto the
 * agent's durable store (the fork backs it with `renameSession`). Shared
 * verbatim with the agent fork's `acp-agent.ts` (`SET_SESSION_TITLE_METHOD`) —
 * keep both in sync. Without this round-trip the title lives only client-side
 * and `session/list`'s `summary` clobbers it after `/compact`.
 */
export const SET_SESSION_TITLE_METHOD = 'universe-editor/set_session_title'

/** One selectable option of an {@link AskUserQuestion}. */
export interface AskUserQuestionOption {
  readonly label: string
  readonly description?: string
  /** Rich preview shown side-by-side when this option is focused. */
  readonly preview?: string
}

/** A single question in an `AskUserQuestion` tool call. */
export interface AskUserQuestion {
  readonly question: string
  readonly header: string
  readonly options: readonly AskUserQuestionOption[]
  readonly multiSelect?: boolean
}

/** Params the agent sends over {@link ASK_USER_QUESTION_METHOD}. */
export interface AskUserQuestionRequest {
  readonly sessionId: string
  readonly toolCallId: string
  readonly questions: readonly AskUserQuestion[]
}

/**
 * Response the client returns to the agent. `answers` is keyed by question
 * text with comma-joined selected labels (matching the SDK's AskUserQuestion
 * output contract); `cancelled` short-circuits to a tool denial.
 */
export interface AskUserQuestionResult {
  readonly cancelled?: boolean
  readonly answers?: Record<string, string>
  readonly annotations?: Record<string, { preview?: string; notes?: string }>
}

/** A pending question carousel awaiting the user's answers. */
export interface AcpPendingQuestion {
  readonly toolCallId: string
  readonly questions: readonly AskUserQuestion[]
  resolve(result: AskUserQuestionResult): void
  cancel(): void
}

export type AcpSessionStatus = 'idle' | 'connecting' | 'running' | 'errored' | 'closed'

/** Per-model cost/token breakdown for a session, reported by the agent. */
export interface AcpModelCost {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreateTokens: number
  /** Session-cumulative cost in USD for this model, as reported by the agent. */
  readonly costUSD: number
}

/** Context-window usage reported by the agent via `usage_update`. */
export interface AcpUsage {
  /** Tokens currently in context. */
  readonly used: number
  /** Total context window size in tokens. */
  readonly size: number
  /** Cumulative session cost, if the agent reports it. */
  readonly cost?: { readonly amount: number; readonly currency: string }
  /**
   * Per-model cost breakdown for the whole session (including sub-agent / Task
   * work), if the agent reports it. Drives the session cost popover.
   */
  readonly models?: readonly AcpModelCost[]
  /**
   * True when `cost`/`models` are locally estimated from token counts rather than
   * reported authoritatively by the agent. Codex sets this (it never reports a
   * real cost); Claude leaves it unset. The UI labels estimated costs as such.
   */
  readonly costEstimated?: boolean
}

/** Bag of normalized initial session state captured from `session/new`. */
export interface IAcpSessionInitState {
  readonly configOptions?: readonly SessionConfigOption[]
  /** Usage snapshot to seed the arc on resume (restored from history). */
  readonly usage?: AcpUsage
  /**
   * MCP servers forwarded on session/new, seeded into `mcpServers` with a
   * `pending` status before the SDK init snapshot arrives. Carries the known
   * transport from config.
   */
  readonly mcpServers?: ReadonlyArray<{ readonly name: string; readonly transport: McpTransport }>
  /** Cumulative running duration in ms, restored from history on resume. */
  readonly accumulatedRunningMs?: number
}

export interface IAcpSession {
  /**
   * The session's stable local id, generated up-front (a uuid for freshly
   * created sessions; the agent-issued id for resumed ones). It never changes
   * for the lifetime of the session, so it is safe to use as a React key /
   * runtime cache key even before the agent connection is established.
   *
   * For the durable, agent-issued protocol id (needed for `session/load`,
   * history, change-tracking, persistence) read {@link sessionIdOnAgent} — it
   * is `undefined` until the connection is attached.
   */
  readonly id: string
  readonly agentId: string
  /**
   * The agent-issued `sessionId` from `session/new` (a.k.a. `sessionIdOnAgent`).
   * `undefined` while the session is still connecting; set once
   * `attachConnection` runs. Durable across editor restarts and the key every
   * other ACP service (history, change tracker, persistence) talks in.
   */
  readonly sessionIdOnAgent: IObservable<string | undefined>
  readonly title: string
  readonly messages: IObservable<readonly AcpMessage[]>
  readonly toolCalls: IObservable<readonly AcpToolCall[]>
  readonly plan: IObservable<readonly AcpPlanEntry[]>
  /**
   * Unified chronological view: message / tool_call / plan slots ordered by
   * insertion. The canonical observable consumed by the chat UI; the three
   * lane-specific observables above remain for back-compat and selector reads.
   */
  readonly timeline: IObservable<readonly TimelineItem[]>
  readonly status: IObservable<AcpSessionStatus>
  /** Latest context-window usage reported by the agent, or undefined if never reported. */
  readonly usage: IObservable<AcpUsage | undefined>
  readonly pendingPermission: IObservable<AcpPendingPermission | undefined>
  /** Active `AskUserQuestion` carousel awaiting the user's answers, if any. */
  readonly pendingQuestion: IObservable<AcpPendingQuestion | undefined>
  /** Configuration options the agent has advertised for this session. */
  readonly configOptions: IObservable<readonly SessionConfigOption[]>
  /** Latest agent-advertised slash commands (may be empty). */
  readonly availableCommands: IObservable<readonly AvailableCommand[]>
  /**
   * Configured + connected MCP servers with their latest connection status.
   * Seeded from config on session/new, then refreshed from the Claude SDK
   * system-init snapshot. Empty when no MCP servers are involved.
   */
  readonly mcpServers: IObservable<readonly AcpMcpServerStatus[]>
  /** Current timeline collapse mode for this session. */
  readonly collapseMode: IObservable<CollapseMode>
  /** Cumulative milliseconds in 'running' status — does not include the current segment if still running. */
  readonly accumulatedRunningMs: IObservable<number>
  /** Timestamp (epoch ms) when the current running segment started, or undefined if not running. */
  readonly runningStartedAt: IObservable<number | undefined>
  /**
   * Fires when a prompt (or other agent call) fails because the agent has no
   * usable credentials. The session itself has no access to the notification /
   * command services, so AcpSessionService owns the user-facing guidance.
   */
  readonly onDidRequireAuth: Event<void>
  /**
   * Resolves once the connecting phase settles — i.e. {@link attachConnection}
   * or {@link failConnection} has run. Lets callers that genuinely need the live
   * agent connection (and tests injecting agent traffic) await the background
   * handshake without blocking the initial render. Resolves immediately if the
   * session is already settled.
   */
  whenConnected(): Promise<void>
  /** Cycle the timeline collapse mode: default → collapsed → expanded → default. */
  cycleCollapseMode(): void
  /** Internal — call site is the permission handler. */
  presentPermission(p: AcpPendingPermission): void
  /** Internal — call site is the AskUserQuestion sink. */
  presentQuestion(q: AcpPendingQuestion): void
  /**
   * Send a prompt. If `mentions` are provided, any `@<name>` in the text
   * whose `<name>` matches a recorded mention is rewritten into a
   * `resource_link` ContentBlock. Unmatched `@`-tokens stay as text.
   */
  sendPrompt(text: string, mentions?: readonly PromptMention[]): Promise<void>
  cancelTurn(): Promise<void>
  close(): Promise<void>
  /** Change one configuration option via `session/set_config_option`. */
  setConfigOption(configId: string, value: string): Promise<void>
}

/**
 * Local error type signalling "the in-flight prompt was cancelled locally
 * (via cancelTurn)". Distinct from RequestError so callers can map it to a
 * neutral status instead of an error UI.
 */
export class AcpAbortError extends Error {
  constructor(message = 'Aborted') {
    super(message)
    this.name = 'AcpAbortError'
  }
}

export class AcpSession extends Disposable implements IAcpSession {
  readonly sessionIdOnAgent: ISettableObservable<string | undefined>
  readonly messages: ISettableObservable<readonly AcpMessage[]>
  readonly toolCalls: ISettableObservable<readonly AcpToolCall[]>
  readonly plan: ISettableObservable<readonly AcpPlanEntry[]>
  readonly timeline: ISettableObservable<readonly TimelineItem[]>
  readonly status: ISettableObservable<AcpSessionStatus>
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
  private _conn: IAcpClientConnection | undefined

  /**
   * Prompts the user submitted before the connection was ready. Flushed in
   * order by {@link attachConnection}; dropped by {@link failConnection}. Each
   * carries the resolve/reject of the original `sendPrompt` promise so callers
   * still observe completion.
   */
  private readonly _queuedPrompts: Array<{
    readonly text: string
    readonly mentions: readonly PromptMention[]
  }> = []

  /** True once attach or fail has settled the connecting phase. */
  private _connectionSettled = false

  /** Resolved when the connecting phase settles; see {@link whenConnected}. */
  private _resolveConnected!: () => void
  private readonly _whenConnected = new Promise<void>((resolve) => {
    this._resolveConnected = resolve
  })

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
    if (this._connectionSettled) return
    this._connectionSettled = true
    this._resolveConnected()
    this._conn = conn
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
    this._flushQueuedPrompts()
  }

  /**
   * Abort the connecting phase after a spawn/initialize/newSession failure.
   * Marks the session errored, surfaces the reason on the timeline, and rejects
   * any queued prompts so their callers don't hang.
   */
  failConnection(message: string): void {
    if (this._connectionSettled) return
    this._connectionSettled = true
    this._resolveConnected()
    this._queuedPrompts.length = 0
    if (this.status.get() === 'connecting') {
      this._appendMessage('agent', `[error] ${message}`)
      this.status.set('errored', undefined)
    }
  }

  whenConnected(): Promise<void> {
    return this._whenConnected
  }

  private _flushQueuedPrompts(): void {
    if (this._queuedPrompts.length === 0) return
    const queued = this._queuedPrompts.splice(0, this._queuedPrompts.length)
    for (const q of queued) {
      void this._dispatchPrompt(q.text, q.mentions)
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

  async sendPrompt(text: string, mentions?: readonly PromptMention[]): Promise<void> {
    // 顺序敏感：派生 title 必须发生在 _appendMessage 之前——它依赖 _messages 仍为空来识别首条 prompt。
    this._maybeDeriveTitleFromPrompt(text)
    // Always surface the user's message immediately, even while connecting, so
    // typing feels instant. The wire dispatch is deferred until the connection
    // is ready (queued) so the prompt is not lost.
    this._appendMessage('user', text)
    void this._maybeGenerateTitle(text)
    if (!this._connectionSettled) {
      this._queuedPrompts.push({ text, mentions: mentions ?? [] })
      return
    }
    // Connection failed during startup — nothing to dispatch onto.
    if (this._conn === undefined) return
    await this._dispatchPrompt(text, mentions ?? [])
  }

  /**
   * Send one prompt over the (already-attached) connection. Assumes
   * `this._conn` / `sessionIdOnAgent` are set — only called post-attach (direct
   * dispatch or queue flush). Does NOT append the user message; the caller
   * (`sendPrompt`) already did so the message shows immediately even while the
   * prompt was queued.
   */
  private async _dispatchPrompt(text: string, mentions: readonly PromptMention[]): Promise<void> {
    const conn = this._conn
    const sid = this.sessionIdOnAgent.get()
    if (conn === undefined || sid === undefined) return
    // Bump the history entry's lastUsedAt so the LRU order tracks user activity.
    this._history?.touch(sid)
    this._history?.setHistoryHasMessages(sid)
    const prompt = composePromptBlocks(text, mentions)
    const params: PromptRequest = {
      sessionId: sid,
      // Fall back to a single text block for empty/no-mention prompts so we
      // keep the wire shape stable even for trivial cases.
      prompt: prompt.length > 0 ? [...prompt] : [{ type: 'text', text }],
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
   * Persist an AI title onto the agent's durable store so it survives `/compact`.
   * Best-effort + fire-and-forget: agents that don't implement the ext-method
   * (e.g. codex) reject with methodNotFound and we keep the local-only title,
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
    // Unblock anyone awaiting the handshake — a session closed mid-connect
    // never reaches attach/fail, so settle the gate here to avoid a hang.
    this._connectionSettled = true
    this._resolveConnected()
    this._abortAllInFlight()
    this._cancelPending()
    this._messages = []
    this._toolCalls = []
    this._timeline = []
    this._orphanChildren.clear()
    this._toolCallParent.clear()
    this._terminalOutput.clear()
    this.messages.set(this._messages, undefined)
    this.toolCalls.set(this._toolCalls, undefined)
    this.timeline.set(this._timeline, undefined)
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
            ? this._estimateCodexCost(extractCodexModelUsage((update as { _meta?: unknown })._meta))
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
    return this._configOptions.setConfigOption(configId, value)
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
    const estimate = this._estimateCodexCost(usages)
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
   * Price a snapshot of session-cumulative per-model Codex usage. Returns the
   * total cost plus the per-model breakdown, or undefined when there is nothing
   * to price. Token counts are cumulative (the fork reports a running total on
   * every model call), so callers overwrite rather than accumulate.
   */
  private _estimateCodexCost(
    usages: readonly CodexModelUsage[],
  ): { cost: { amount: number; currency: string }; models: AcpModelCost[] } | undefined {
    if (usages.length === 0) return undefined
    const models: AcpModelCost[] = []
    let totalUsd = 0
    for (const u of usages) {
      const costUSD = estimateCodexCostUSD(u.model, {
        inputTokens: u.inputTokens,
        cachedReadTokens: u.cachedReadTokens,
        outputTokens: u.outputTokens,
      })
      totalUsd += costUSD
      models.push({
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cachedReadTokens,
        cacheCreateTokens: 0,
        costUSD,
      })
    }
    return { cost: { amount: totalUsd, currency: 'USD' }, models }
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
    this.messages.set(this._messages, undefined)
    this.timeline.set(this._timeline, undefined)
    this._commitBatchedTx()
  }

  private _appendMessage(role: AcpMessageRole, text: string): void {
    const id = `m${++this._msgCounter}`
    const blocks: readonly ContentBlock[] = [{ type: 'text', text }]
    const message: AcpMessage = { id, role, blocks, text, streaming: false }
    this._messages = [...this._messages, message]
    this._upsertMessageInTimeline(message)
    this.messages.set(this._messages, undefined)
    this.timeline.set(this._timeline, undefined)
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
}

/** A text block whose content is empty or only whitespace carries nothing. */
export function isBlankContentBlock(block: ContentBlock): boolean {
  return block.type === 'text' && block.text.trim().length === 0
}

/**
 * Read the per-model cost breakdown our agent fork stamps onto `usage_update`
 * via `_meta._universe/modelBreakdown`. Values are session-cumulative and
 * already fold in sub-agent (Task) work. Returns [] when absent or malformed.
 */
function extractModelBreakdown(update: {
  _meta?: Record<string, unknown> | null | undefined
}): readonly AcpModelCost[] {
  const raw = update._meta?.['_universe/modelBreakdown']
  if (!Array.isArray(raw)) return []
  const out: AcpModelCost[] = []
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r['model'] !== 'string') continue
    out.push({
      model: r['model'],
      inputTokens: numberOr(r['inputTokens']),
      outputTokens: numberOr(r['outputTokens']),
      cacheReadTokens: numberOr(r['cacheReadTokens']),
      cacheCreateTokens: numberOr(r['cacheCreateTokens']),
      costUSD: numberOr(r['costUSD']),
    })
  }
  return out
}

function numberOr(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Read the vendor-specific sub-agent attribution our agent fork stamps onto each
 * SessionUpdate (`_meta.claudeCode.parentToolUseId`). Returns the id of the
 * parent tool call when this update belongs to a sub-agent, else undefined.
 */
function readParentToolUseId(update: SessionUpdate): string | undefined {
  const meta = (update as { _meta?: { claudeCode?: { parentToolUseId?: unknown } } | null })._meta
  const pid = meta?.claudeCode?.parentToolUseId
  return typeof pid === 'string' && pid.length > 0 ? pid : undefined
}

/**
 * Resolve the source MCP server for a tool_call(_update) from the agent fork's
 * `_meta.claudeCode.toolName` (`mcp__<server>__<tool>`). Returns undefined for
 * built-in tools or malformed names.
 */
function readMcpServer(update: SessionUpdate): string | undefined {
  const meta = (update as { _meta?: { claudeCode?: { toolName?: unknown } } | null })._meta
  const toolName = meta?.claudeCode?.toolName
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined
  return parseMcpToolName(toolName)?.server
}

/**
 * Read the codex-acp fork's out-of-band terminal output from a tool_call(_update).
 * The fork streams command output via `_meta.terminal_output_delta` (append-only
 * chunks) or `_meta.terminal_output` (a full snapshot), rather than as `content`
 * blocks. Returns the chunk plus whether it appends to or replaces the accumulator,
 * or undefined when this update carries no terminal output.
 */
function readTerminalOutput(
  update: SessionUpdate,
): { readonly data: string; readonly mode: 'append' | 'replace' } | undefined {
  const meta = (
    update as {
      _meta?: {
        terminal_output_delta?: { data?: unknown } | null
        terminal_output?: { data?: unknown } | null
      } | null
    }
  )._meta
  if (!meta) return undefined
  const delta = meta.terminal_output_delta?.data
  if (typeof delta === 'string') return { data: delta, mode: 'append' }
  const full = meta.terminal_output?.data
  if (typeof full === 'string') return { data: full, mode: 'replace' }
  return undefined
}

/**
 * Extract a whole-file change descriptor from the agent fork's PostToolUse hook
 * payload: `_meta.claudeCode.toolResponse.{filePath, structuredPatch, type,
 * originalFile}`, present only for `Edit`/`Write` tools. Returns undefined for
 * any other tool / shape.
 *
 * `isCreate` is derived from the authoritative SDK signals (`type: 'create'` or
 * `originalFile: null`); when set we keep the descriptor even with zero hunks,
 * because an empty-content Write reports an empty `structuredPatch` yet still
 * created a file the tracker must surface.
 */
interface FileChangeDescriptor {
  readonly path: string
  readonly hunks: readonly DiffHunk[]
  readonly isCreate: boolean
}

function readFileChanges(update: SessionUpdate): readonly FileChangeDescriptor[] {
  const structured = readStructuredPatch(update)
  if (structured) return [structured]
  return readDiffContentChanges(update)
}

function readStructuredPatch(update: SessionUpdate): FileChangeDescriptor | undefined {
  const meta = (
    update as {
      _meta?: {
        claudeCode?: {
          toolName?: unknown
          toolResponse?: {
            filePath?: unknown
            structuredPatch?: unknown
            type?: unknown
            originalFile?: unknown
          }
        }
      } | null
    }
  )._meta
  const cc = meta?.claudeCode
  if (cc?.toolName !== 'Edit' && cc?.toolName !== 'Write') return undefined
  const resp = cc?.toolResponse
  const path = resp?.filePath
  const patch = resp?.structuredPatch
  if (typeof path !== 'string' || path.length === 0 || !Array.isArray(patch)) return undefined
  const isCreate = resp?.type === 'create' || resp?.originalFile === null
  const hunks: DiffHunk[] = []
  for (const h of patch) {
    if (
      h &&
      typeof h.newStart === 'number' &&
      typeof h.newLines === 'number' &&
      typeof h.oldStart === 'number' &&
      typeof h.oldLines === 'number' &&
      Array.isArray(h.lines)
    ) {
      hunks.push({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines.filter((l: unknown): l is string => typeof l === 'string'),
      })
    }
  }
  if (hunks.length === 0 && !isCreate) return undefined
  return { path, hunks, isCreate }
}

function readDiffContentChanges(update: SessionUpdate): readonly FileChangeDescriptor[] {
  const content = (update as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const changes: FileChangeDescriptor[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const diff = item as { type?: unknown; path?: unknown; oldText?: unknown; newText?: unknown }
    if (diff.type !== 'diff') continue
    if (typeof diff.path !== 'string' || diff.path.length === 0) continue
    if (typeof diff.newText !== 'string') continue
    const isCreate = diff.oldText == null
    const oldText = typeof diff.oldText === 'string' ? diff.oldText : ''
    const hunks = wholeFileDiffHunks(oldText, diff.newText, isCreate)
    if (hunks.length === 0 && !isCreate) continue
    changes.push({ path: diff.path, hunks, isCreate })
  }
  return changes
}

function wholeFileDiffHunks(
  oldText: string,
  newText: string,
  isCreate: boolean,
): readonly DiffHunk[] {
  if (oldText === newText) return []
  const oldLines = isCreate ? [] : diffLines(oldText)
  const newLines = newText.length === 0 && isCreate ? [] : diffLines(newText)
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
    },
  ]
}

function diffLines(text: string): readonly string[] {
  return text.length === 0 ? [''] : text.split('\n')
}

/** True when at least one block would render visible content. */
export function hasVisibleMessageContent(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => (b.type === 'text' ? b.text.trim().length > 0 : true))
}
export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((b) =>
      b.type === 'text'
        ? b.text
        : b.type === 'resource'
          ? `[resource: ${b.resource.uri}]`
          : b.type === 'resource_link'
            ? `[resource: ${b.name ?? b.uri}]`
            : b.type === 'audio'
              ? `[audio: ${b.mimeType}]`
              : `[image: ${b.mimeType}]`,
    )
    .join('')
}

/**
 * Serialize a tool call into copyable plain text — title, diffs, output, and any
 * nested sub-agent items — so the right-click "Copy Message" works on tool-call
 * cards, not just plain messages (mirrors VSCode's chat tool-invocation repr).
 */
export function toolCallToText(call: AcpToolCall): string {
  const parts: string[] = []
  parts.push(call.mcpServer !== undefined ? `${call.title} (MCP · ${call.mcpServer})` : call.title)

  for (const d of call.diffs) {
    const label = d.oldText.length === 0 ? `[new file: ${d.path}]` : `[diff: ${d.path}]`
    parts.push(`${label}\n${d.newText}`)
  }

  const body = call.kind === 'execute' ? call.text : blocksToText(call.blocks)
  if (body.trim().length > 0) parts.push(body)

  for (const child of call.children ?? []) {
    const childText = timelineItemToText(child)
    if (childText.trim().length > 0) {
      parts.push(
        childText
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
      )
    }
  }

  return parts.join('\n\n')
}

/** Plain-text representation of any timeline slot, suitable for clipboard copy. */
export function timelineItemToText(item: TimelineItem | AcpChildItem): string {
  return item.kind === 'message' ? item.message.text : toolCallToText(item.call)
}

/**
 * Split the SDK's ToolCallContent[] (a discriminated union of content / diff /
 * terminal wrappers) into a flat ContentBlock[] plus structured diff entries.
 * - `content` items are unwrapped into the block list.
 * - `diff` items are pulled out into `diffs` (so the UI can render a dedicated
 *   diff preview); they no longer leak into `blocks` as `[diff: path]`.
 * - `terminal` items are dropped here: the codex-acp fork only sends them as a
 *   placeholder, streaming the real output out-of-band via `_meta.terminal_output*`
 *   (folded into the execute card's `text`; see `_accumulateTerminalOutput`).
 */
export function splitToolCallContent(content: readonly ToolCallContent[]): {
  readonly blocks: readonly ContentBlock[]
  readonly diffs: readonly AcpToolCallDiff[]
} {
  const blocks: ContentBlock[] = []
  const diffs: AcpToolCallDiff[] = []
  for (const item of content) {
    switch (item.type) {
      case 'content':
        blocks.push(item.content)
        break
      case 'diff':
        diffs.push({
          path: item.path,
          oldText: item.oldText ?? '',
          newText: item.newText,
        })
        break
      case 'terminal':
        break
    }
  }
  return { blocks, diffs }
}

/**
 * Merge an incoming streaming chunk into the existing blocks list. Consecutive
 * `text` blocks collapse into a single block so the markdown parser can see a
 * coherent document; non-text blocks (image / resource / resource_link / audio)
 * are appended as-is.
 */
export function mergeStreamingBlock(
  blocks: readonly ContentBlock[],
  chunk: ContentBlock,
): readonly ContentBlock[] {
  if (chunk.type === 'text') {
    const last = blocks[blocks.length - 1]
    if (last && last.type === 'text') {
      return [...blocks.slice(0, -1), { type: 'text', text: last.text + chunk.text }]
    }
  }
  return [...blocks, chunk]
}
