/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSession — per-session view-model. Holds the streaming message + tool
 *  call + plan + permission state, owns one ACP `ClientSideConnection`, and
 *  exposes everything as observables for the React layer. The configOption
 *  push/echo state machine is delegated to a ConfigOptionStateMachine sub-object.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  observableValue,
  TransactionImpl,
  type ITelemetryService,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  AvailableCommand,
  ContentBlock,
  PromptRequest,
  SessionConfigOption,
  SessionUpdate,
  ToolCallContent,
} from '@agentclientprotocol/sdk'
import type { IAcpClientConnection } from './acpClientService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import { ConfigOptionStateMachine } from './acpSessionConfigOptions.js'
import { composePromptBlocks, type PromptMention } from './promptMentions.js'
import { parseMcpToolName, type McpTransport } from './acpMcpServers.js'

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

/** Context-window usage reported by the agent via `usage_update`. */
export interface AcpUsage {
  /** Tokens currently in context. */
  readonly used: number
  /** Total context window size in tokens. */
  readonly size: number
  /** Cumulative session cost, if the agent reports it. */
  readonly cost?: { readonly amount: number; readonly currency: string }
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
}

export interface IAcpSession {
  /**
   * The session's canonical id is the agent-issued `sessionId` from
   * `session/new` (a.k.a. `sessionIdOnAgent`). It is durable across editor
   * restarts and is the single key used by every other ACP service.
   */
  readonly id: string
  readonly agentId: string
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

  private readonly _configOptions: ConfigOptionStateMachine

  private _messages: AcpMessage[] = []
  private _toolCalls: AcpToolCall[] = []
  private _timeline: TimelineItem[] = []
  private _msgCounter = 0

  /** Abort controller for the in-flight `session/prompt`. */
  private _activeAbort: AbortController | undefined

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

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly title: string,
    private readonly _conn: IAcpClientConnection,
    private readonly _telemetry: ITelemetryService,
    initState?: IAcpSessionInitState,
    private readonly _history?: IAcpSessionHistoryService,
    private readonly _agentDefaults?: IAcpAgentDefaultsService,
  ) {
    super()
    this.messages = observableValue<readonly AcpMessage[]>(`acp.session.messages.${id}`, [])
    this.toolCalls = observableValue<readonly AcpToolCall[]>(`acp.session.toolCalls.${id}`, [])
    this.plan = observableValue<readonly AcpPlanEntry[]>(`acp.session.plan.${id}`, [])
    this.timeline = observableValue<readonly TimelineItem[]>(`acp.session.timeline.${id}`, [])
    this.status = observableValue<AcpSessionStatus>(`acp.session.status.${id}`, 'idle')
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
    this._configOptions = new ConfigOptionStateMachine({
      conn: _conn,
      telemetry: _telemetry,
      sessionInfo: { sessionId: id, agentId },
      ...(_history !== undefined ? { history: _history } : {}),
      ...(_agentDefaults !== undefined ? { defaults: _agentDefaults } : {}),
    })
    if (initState) {
      this.applyInitState(initState)
    }
    this._register({ dispose: () => this._conn.dispose() })
    // Connection close → seal the session.
    const onClose = (): void => {
      this._commitBatchedTx()
      this.status.set('closed', undefined)
      this._cancelPending()
      this._activeAbort?.abort()
    }
    if (this._conn.conn.signal.aborted) {
      onClose()
    } else {
      this._conn.conn.signal.addEventListener('abort', onClose, { once: true })
    }
  }

  get configOptions(): IObservable<readonly SessionConfigOption[]> {
    return this._configOptions.configOptions
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
    // Bump the history entry's lastUsedAt so the LRU order tracks user activity.
    // Safe no-op when this session wasn't created with a history reference.
    this._history?.touch(this.id)
    // 顺序敏感：派生 title 必须发生在 _appendMessage 之前——它依赖 _messages 仍为空来识别首条 prompt。
    this._maybeDeriveTitleFromPrompt(text)
    this._appendMessage('user', text)
    this.status.set('running', undefined)
    const prompt = composePromptBlocks(text, mentions ?? [])
    const params: PromptRequest = {
      sessionId: this.id,
      // Fall back to a single text block for empty/no-mention prompts so we
      // keep the wire shape stable even for trivial cases.
      prompt: prompt.length > 0 ? [...prompt] : [{ type: 'text', text }],
    }
    const abort = new AbortController()
    this._activeAbort = abort
    this._telemetry.publicLog('acp.prompt_sent', { sessionId: this.id })
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new AcpAbortError())
      if (abort.signal.aborted) onAbort()
      else abort.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([this._conn.conn.prompt(params), abortPromise])
      this._flushStream()
      this.status.set('idle', undefined)
    } catch (err) {
      this._flushStream()
      if (err instanceof AcpAbortError) {
        this.status.set('idle', undefined)
        this._appendMessage('agent', '[cancelled]')
        this._telemetry.publicLog('acp.prompt_cancelled', { sessionId: this.id })
      } else {
        this.status.set('errored', undefined)
        this._appendMessage('agent', `[error] ${(err as Error).message}`)
        this._telemetry.publicLogError('acp.prompt_failed', {
          sessionId: this.id,
          error: (err as Error).message,
        })
      }
    } finally {
      if (this._activeAbort === abort) this._activeAbort = undefined
    }
  }

  async cancelTurn(): Promise<void> {
    try {
      await this._conn.conn.cancel({ sessionId: this.id })
    } catch {
      // swallow — cancel is best-effort
    }
    this._activeAbort?.abort()
  }

  private _maybeDeriveTitleFromPrompt(text: string): void {
    if (!this._history) return
    if (this._messages.length > 0) return
    const derived = text.trim().replace(/\s+/g, ' ').slice(0, 30)
    if (derived.length === 0) return
    this._history.updateInfo(this.id, { title: derived })
  }

  async close(): Promise<void> {
    this._commitBatchedTx()
    this.status.set('closed', undefined)
    this._activeAbort?.abort()
    this._cancelPending()
    this._messages = []
    this._toolCalls = []
    this._timeline = []
    this._orphanChildren.clear()
    this._toolCallParent.clear()
    this.messages.set(this._messages, undefined)
    this.toolCalls.set(this._toolCalls, undefined)
    this.timeline.set(this._timeline, undefined)
    this.dispose()
  }

  // -- ingestion ----------------------------------------------------------

  applyUpdate(update: SessionUpdate): void {
    const parentId = readParentToolUseId(update)
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
        this._upsertToolCall(
          {
            id: update.toolCallId,
            title: update.title,
            kind: update.kind ?? 'unknown',
            status: (update.status as AcpToolCallStatus | undefined) ?? 'pending',
            blocks,
            diffs,
            text: blocksToText(blocks),
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
        const next: AcpToolCall = {
          id: update.toolCallId,
          title: update.title != null ? update.title : (existing?.title ?? update.toolCallId),
          kind: update.kind != null ? update.kind : (existing?.kind ?? 'unknown'),
          status: (update.status as AcpToolCallStatus | undefined) ?? existing?.status ?? 'pending',
          blocks,
          diffs,
          text: blocksToText(blocks),
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
          if (Object.keys(patch).length > 0) {
            this._history.updateInfo(this.id, patch)
          }
        }
        break
      }
      case 'usage_update': {
        const tx = this._batchedTx()
        const next: AcpUsage = {
          used: update.used,
          size: update.size,
          ...(update.cost != null
            ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
            : {}),
        }
        this.usage.set(next, tx)
        // Mirror onto history so the arc survives resume — `session/load`
        // replay does not re-emit usage_update. Debounced + deduped downstream.
        this._history?.setHistoryUsage(this.id, next)
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
 * Split the SDK's ToolCallContent[] (a discriminated union of content / diff /
 * terminal wrappers) into a flat ContentBlock[] plus structured diff entries.
 * - `content` items are unwrapped into the block list.
 * - `diff` items are pulled out into `diffs` (so the UI can render a dedicated
 *   diff preview); they no longer leak into `blocks` as `[diff: path]`.
 * - `terminal` items become a labelled text placeholder for now.
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
        blocks.push({ type: 'text', text: `[terminal: ${item.terminalId}]` })
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
