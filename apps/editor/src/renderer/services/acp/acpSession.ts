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
}

export interface AcpPlanEntry {
  readonly content: string
  readonly priority?: string
}

/**
 * A single slot on the unified chat timeline. The UI renders one ordered list
 * of these so message / tool_call / plan cards interleave by arrival order,
 * matching Copilot-style agent chat layout.
 *
 * Slot identity rules:
 * - `kind: 'message'` reuses the underlying `message.id` so React keys are
 *   stable across chunk merges.
 * - `kind: 'toolCall'` reuses the agent-issued `toolCallId` so `tool_call_update`
 *   replaces the existing slot in place.
 * - `kind: 'plan'` is a singleton lane — the literal `'plan'` id anchors the
 *   slot at first appearance and subsequent plan events replace `entries` in
 *   place rather than appending a new slot.
 */
export type TimelineItem =
  | { readonly kind: 'message'; readonly id: string; readonly message: AcpMessage }
  | { readonly kind: 'toolCall'; readonly id: string; readonly call: AcpToolCall }
  | { readonly kind: 'plan'; readonly id: 'plan'; readonly entries: readonly AcpPlanEntry[] }

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

export type AcpSessionStatus = 'idle' | 'connecting' | 'running' | 'errored' | 'closed'

/** Bag of normalized initial session state captured from `session/new`. */
export interface IAcpSessionInitState {
  readonly configOptions?: readonly SessionConfigOption[]
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
  readonly pendingPermission: IObservable<AcpPendingPermission | undefined>
  /** Configuration options the agent has advertised for this session. */
  readonly configOptions: IObservable<readonly SessionConfigOption[]>
  /** Latest agent-advertised slash commands (may be empty). */
  readonly availableCommands: IObservable<readonly AvailableCommand[]>
  /** Internal — call site is the permission handler. */
  presentPermission(p: AcpPendingPermission): void
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
  readonly pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  readonly availableCommands: ISettableObservable<readonly AvailableCommand[]>

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
    this.pendingPermission = observableValue<AcpPendingPermission | undefined>(
      `acp.session.pendingPermission.${id}`,
      undefined,
    )
    this.availableCommands = observableValue<readonly AvailableCommand[]>(
      `acp.session.availableCommands.${id}`,
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
  }

  presentPermission(p: AcpPendingPermission): void {
    // Replace any prior pending request — only one card at a time per session.
    this._cancelPending()
    this.pendingPermission.set(p, undefined)
  }

  private _cancelPending(): void {
    const cur = this.pendingPermission.get()
    if (cur) {
      this.pendingPermission.set(undefined, undefined)
      cur.cancel()
    }
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
    this.messages.set(this._messages, undefined)
    this.toolCalls.set(this._toolCalls, undefined)
    this.timeline.set(this._timeline, undefined)
    this.dispose()
  }

  // -- ingestion ----------------------------------------------------------

  applyUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this._appendChunk('user', update.content)
        break
      case 'agent_message_chunk':
        this._appendChunk('agent', update.content)
        break
      case 'agent_thought_chunk':
        this._appendChunk('thought', update.content)
        break
      case 'tool_call': {
        const { blocks, diffs } = splitToolCallContent(update.content ?? [])
        this._upsertToolCall({
          id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? 'unknown',
          status: (update.status as AcpToolCallStatus | undefined) ?? 'pending',
          blocks,
          diffs,
          text: blocksToText(blocks),
        })
        this._telemetry.publicLog('acp.tool_call_started', {
          sessionId: this.id,
          kind: update.kind ?? 'unknown',
        })
        break
      }
      case 'tool_call_update': {
        const existing = this._toolCalls.find((t) => t.id === update.toolCallId)
        const split = update.content != null ? splitToolCallContent(update.content) : undefined
        const blocks = split?.blocks ?? existing?.blocks ?? []
        const diffs = split?.diffs ?? existing?.diffs ?? []
        const next: AcpToolCall = {
          id: update.toolCallId,
          title: update.title != null ? update.title : (existing?.title ?? update.toolCallId),
          kind: update.kind != null ? update.kind : (existing?.kind ?? 'unknown'),
          status: (update.status as AcpToolCallStatus | undefined) ?? existing?.status ?? 'pending',
          blocks,
          diffs,
          text: blocksToText(blocks),
        }
        this._upsertToolCall(next)
        if (update.status === 'failed') {
          this._telemetry.publicLogError('acp.tool_call_failed', {
            sessionId: this.id,
            kind: next.kind,
          })
        }
        break
      }
      case 'plan': {
        const entries: readonly AcpPlanEntry[] = update.entries.map((e) => ({
          content: e.content,
          ...(e.priority !== undefined ? { priority: e.priority } : {}),
        }))
        this._upsertPlanInTimeline(entries)
        const tx = this._batchedTx()
        this.plan.set(entries, tx)
        this.timeline.set(this._timeline, tx)
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
      default:
        // usage_update etc. — ignored for now.
        break
    }
  }

  setConfigOption(configId: string, value: string): Promise<void> {
    return this._configOptions.setConfigOption(configId, value)
  }

  private _appendChunk(role: AcpMessageRole, block: ContentBlock): void {
    const last = this._messages[this._messages.length - 1]
    let next: AcpMessage
    if (last && last.role === role && this._isStreaming(last.id)) {
      const blocks = mergeStreamingBlock(last.blocks, block)
      next = { id: last.id, role, blocks, text: blocksToText(blocks), streaming: true }
      this._messages = [...this._messages.slice(0, -1), next]
      this._upsertMessageInTimeline(next)
    } else {
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

  private _upsertToolCall(call: AcpToolCall): void {
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
    const slot: TimelineItem = { kind: 'toolCall', id: call.id, call }
    if (idx === -1) {
      this._timeline = [...this._timeline, slot]
    } else {
      this._timeline = [...this._timeline.slice(0, idx), slot, ...this._timeline.slice(idx + 1)]
    }
  }

  private _upsertPlanInTimeline(entries: readonly AcpPlanEntry[]): void {
    const idx = this._timeline.findIndex((it) => it.kind === 'plan')
    const slot: TimelineItem = { kind: 'plan', id: 'plan', entries }
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
