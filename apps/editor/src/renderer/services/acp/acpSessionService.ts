/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionService — high-level multi-session state on top of AcpClientService.
 *
 *  Each Session owns one agent process (one ClientSideConnection). The service
 *  exposes observable arrays for the React layer to render:
 *    - sessions:      every open Session
 *    - activeSession: the one currently visible in the chat view
 *
 *  Session lifecycle: `createSession(agentId)` spawns the agent, performs
 *  ACP `initialize` + `session/new` under a timeout, then stays idle until
 *  `sendPrompt(text)` is called. `cancelTurn()` issues `session/cancel` AND
 *  locally aborts the in-flight prompt request so the local promise unblocks
 *  even if the agent never responds. `close()` disposes the connection (which
 *  kills the process via the host) and removes the session from the list.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  IConfigurationService,
  ILoggerService,
  INotificationService,
  IProgressService,
  ITelemetryService,
  IWorkspaceService,
  ProgressLocation,
  Severity,
  observableValue,
  transaction,
  TransactionImpl,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import {
  PROTOCOL_VERSION,
  type AvailableCommand,
  type ContentBlock,
  type InitializeRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionModeRequest,
  type ToolCallContent,
} from '@agentclientprotocol/sdk'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from './acpClientService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPermissionHandler } from './acpPermissionHandler.js'
import { IAcpSessionHistoryService } from './acpSessionHistory.js'
import { composePromptBlocks, type PromptMention } from './promptMentions.js'

export type { PromptMention }

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
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface AcpToolCall {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: AcpToolCallStatus
  /** Plain-text view of `blocks`. */
  readonly text: string
  /**
   * Tool call output normalized into ContentBlock[]. ToolCallContent variants
   * `content` are unwrapped; `diff` and `terminal` are converted to a placeholder
   * text block so the existing MessageContent renderer keeps working unchanged.
   */
  readonly blocks: readonly ContentBlock[]
}

export interface AcpPlanEntry {
  readonly content: string
  readonly priority?: string
}

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
  readonly modes?: SessionModeState
}

export interface IAcpSession {
  readonly id: string
  readonly agentId: string
  readonly title: string
  /**
   * Stable identifier from AcpSessionHistoryService — survives editor restarts.
   * Sessions created or resumed through AcpSessionService always carry one.
   */
  readonly historyId: string | undefined
  readonly messages: IObservable<readonly AcpMessage[]>
  readonly toolCalls: IObservable<readonly AcpToolCall[]>
  readonly plan: IObservable<readonly AcpPlanEntry[]>
  readonly status: IObservable<AcpSessionStatus>
  readonly pendingPermission: IObservable<AcpPendingPermission | undefined>
  /**
   * Unified configuration view. Legacy `modes` are normalized into a single
   * `category: 'mode'` ConfigOption so the UI can treat both protocol shapes
   * uniformly; see {@link AcpSessionService} for the conversion details.
   */
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
  /**
   * Change one configuration option. Falls back to `session/set_mode` for
   * legacy-only agents that didn't expose configOptions.
   */
  setConfigOption(configId: string, value: string): Promise<void>
}

export interface IAcpSessionService {
  readonly _serviceBrand: undefined
  readonly sessions: IObservable<readonly IAcpSession[]>
  readonly activeSessionId: IObservable<string | undefined>
  readonly activeSession: IObservable<IAcpSession | undefined>
  createSession(agentId?: string): Promise<IAcpSession>
  /**
   * Resume a previously-persisted session by its local history id.
   * Spawns a fresh agent process, validates `agentCapabilities.loadSession`,
   * replays the conversation via `session/load`, and registers the session
   * before issuing the load so streaming `session/update` notifications during
   * replay are routed correctly.
   */
  resumeSession(historyId: string): Promise<IAcpSession>
  setActive(sessionId: string): void
  closeSession(sessionId: string): Promise<void>
  getById(sessionId: string): IAcpSession | undefined
  /**
   * Look up a live session by its history id (the durable id from
   * AcpSessionHistoryService). Returns undefined if no live session matches —
   * the caller (e.g. AcpSessionEditor) can then issue `resumeSession(historyId)`.
   */
  getByHistoryId(historyId: string): IAcpSession | undefined
}

export const IAcpSessionService = createDecorator<IAcpSessionService>('acpSessionService')

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

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

class AcpSession extends Disposable implements IAcpSession {
  readonly messages: ISettableObservable<readonly AcpMessage[]>
  readonly toolCalls: ISettableObservable<readonly AcpToolCall[]>
  readonly plan: ISettableObservable<readonly AcpPlanEntry[]>
  readonly status: ISettableObservable<AcpSessionStatus>
  readonly pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  readonly configOptions: ISettableObservable<readonly SessionConfigOption[]>
  readonly availableCommands: ISettableObservable<readonly AvailableCommand[]>

  private _messages: AcpMessage[] = []
  private _toolCalls: AcpToolCall[] = []
  private _msgCounter = 0

  /** Abort controller for the in-flight `session/prompt`. */
  private _activeAbort: AbortController | undefined

  // 16ms batching: collapse bursts of session/update chunks into one
  // observer notification per frame. Underlying values still update
  // synchronously (set(v, tx) writes _value before tx.finish()).
  private _pendingTx: TransactionImpl | undefined
  private _flushTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Legacy modes state — kept around so we can keep emitting `session/set_mode`
   * for agents that haven't migrated. Also drives the synthetic mode
   * ConfigOption so the UI can use a single rendering path.
   */
  private _legacyModes: SessionModeState | undefined

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly title: string,
    private readonly _conn: IAcpClientConnection,
    private readonly _sessionIdOnAgent: string,
    private readonly _telemetry: ITelemetryService,
    initState?: IAcpSessionInitState,
    private readonly _historyId?: string,
    private readonly _history?: IAcpSessionHistoryService,
  ) {
    super()
    this.messages = observableValue<readonly AcpMessage[]>(`acp.session.messages.${id}`, [])
    this.toolCalls = observableValue<readonly AcpToolCall[]>(`acp.session.toolCalls.${id}`, [])
    this.plan = observableValue<readonly AcpPlanEntry[]>(`acp.session.plan.${id}`, [])
    this.status = observableValue<AcpSessionStatus>(`acp.session.status.${id}`, 'idle')
    this.pendingPermission = observableValue<AcpPendingPermission | undefined>(
      `acp.session.pendingPermission.${id}`,
      undefined,
    )
    this.configOptions = observableValue<readonly SessionConfigOption[]>(
      `acp.session.configOptions.${id}`,
      [],
    )
    this.availableCommands = observableValue<readonly AvailableCommand[]>(
      `acp.session.availableCommands.${id}`,
      [],
    )
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

  /**
   * Apply a bag of init state (modes / configOptions). Idempotent and safe to
   * call multiple times — used by both the constructor and by `resumeSession`
   * after `session/load` returns. Empty bags are a no-op.
   */
  applyInitState(state: IAcpSessionInitState): void {
    if (state.modes) {
      this._legacyModes = state.modes
    }
    if (state.configOptions || state.modes) {
      this.configOptions.set(this._materializeConfigOptions(state.configOptions), undefined)
    }
  }

  /** History id this session was minted with — undefined for sessions created without persistence. */
  get historyId(): string | undefined {
    return this._historyId
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
    // Safe no-op when this session wasn't created with a history id.
    if (this._history && this._historyId) {
      this._history.touch(this._historyId)
    }
    this._appendMessage('user', text)
    this.status.set('running', undefined)
    const prompt = composePromptBlocks(text, mentions ?? [])
    const params: PromptRequest = {
      sessionId: this._sessionIdOnAgent,
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
      await this._conn.conn.cancel({ sessionId: this._sessionIdOnAgent })
    } catch {
      // swallow — cancel is best-effort
    }
    this._activeAbort?.abort()
  }

  async close(): Promise<void> {
    this._commitBatchedTx()
    this.status.set('closed', undefined)
    this._activeAbort?.abort()
    this._cancelPending()
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
        const blocks = toolCallContentToBlocks(update.content ?? [])
        this._upsertToolCall({
          id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? 'unknown',
          status: (update.status as AcpToolCallStatus | undefined) ?? 'pending',
          blocks,
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
        const blocks =
          update.content != null
            ? toolCallContentToBlocks(update.content)
            : (existing?.blocks ?? [])
        const next: AcpToolCall = {
          id: update.toolCallId,
          title: existing?.title ?? update.toolCallId,
          kind: existing?.kind ?? 'unknown',
          status: (update.status as AcpToolCallStatus | undefined) ?? existing?.status ?? 'pending',
          blocks,
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
      case 'plan':
        this.plan.set(
          update.entries.map((e) => ({
            content: e.content,
            ...(e.priority !== undefined ? { priority: e.priority } : {}),
          })),
          undefined,
        )
        break
      case 'available_commands_update':
        this.availableCommands.set(update.availableCommands, undefined)
        this._telemetry.publicLog('acp.commands_advertised', {
          sessionId: this.id,
          count: update.availableCommands.length,
        })
        break
      case 'current_mode_update':
        if (this._legacyModes) {
          this._legacyModes = {
            ...this._legacyModes,
            currentModeId: update.currentModeId,
          }
        }
        this._reconcileLegacyModeOption(update.currentModeId)
        break
      case 'config_option_update':
        this.configOptions.set(this._materializeConfigOptions(update.configOptions), undefined)
        break
      default:
        // session_info_update / usage_update etc. — ignored for now.
        break
    }
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const cur = this.configOptions.get()
    const target = cur.find((o) => o.id === configId)
    const isLegacyMode =
      target?.category === 'mode' &&
      this._legacyModes !== undefined &&
      !cur.some((o) => o.category === 'mode' && this._lastSeenFromConfigOptionsServer.has(o.id))
    // Legacy path: only modes were advertised → use session/set_mode.
    if (isLegacyMode) {
      const params: SetSessionModeRequest = {
        sessionId: this._sessionIdOnAgent,
        modeId: value,
      }
      await this._conn.conn.setSessionMode(params)
      this._legacyModes = { ...this._legacyModes!, currentModeId: value }
      this._reconcileLegacyModeOption(value)
      this._telemetry.publicLog('acp.config_option_set', {
        sessionId: this.id,
        configId,
        legacy: true,
      })
      return
    }
    const params: SetSessionConfigOptionRequest = {
      sessionId: this._sessionIdOnAgent,
      configId,
      value,
    }
    const resp = await this._conn.conn.setSessionConfigOption(params)
    if (resp.configOptions) {
      this._markServerConfigIds(resp.configOptions)
      this.configOptions.set(this._materializeConfigOptions(resp.configOptions), undefined)
    }
    this._telemetry.publicLog('acp.config_option_set', { sessionId: this.id, configId })
  }

  /** Synthesize / refresh the mode ConfigOption from `_legacyModes`. */
  private _reconcileLegacyModeOption(currentModeId: string): void {
    if (!this._legacyModes) return
    const cur = this.configOptions.get()
    const next = cur.map((o) =>
      o.category === 'mode' && !this._lastSeenFromConfigOptionsServer.has(o.id)
        ? ({ ...o, currentValue: currentModeId } as SessionConfigOption)
        : o,
    )
    this.configOptions.set(next, undefined)
  }

  /**
   * Build the final ConfigOption[] for the UI: agent-supplied options first
   * (preserving their priority order), then a synthetic `mode` option derived
   * from legacy `modes` if the agent didn't already publish one in that
   * category. Per spec, when both are present the client uses configOptions
   * exclusively and ignores modes — we keep `_legacyModes` only to fall back
   * to `session/set_mode` when writing.
   */
  private _materializeConfigOptions(
    serverOpts: readonly SessionConfigOption[] | undefined,
  ): readonly SessionConfigOption[] {
    const out: SessionConfigOption[] = serverOpts ? [...serverOpts] : []
    if (this._legacyModes) {
      const hasServerMode = out.some((o) => o.category === 'mode')
      if (!hasServerMode) {
        out.push(legacyModesToConfigOption(this._legacyModes))
      }
    }
    if (serverOpts) this._markServerConfigIds(serverOpts)
    return out
  }

  private readonly _lastSeenFromConfigOptionsServer = new Set<string>()
  private _markServerConfigIds(opts: readonly SessionConfigOption[]): void {
    this._lastSeenFromConfigOptionsServer.clear()
    for (const o of opts) this._lastSeenFromConfigOptionsServer.add(o.id)
  }

  private _appendChunk(role: AcpMessageRole, block: ContentBlock): void {
    const last = this._messages[this._messages.length - 1]
    if (last && last.role === role && this._isStreaming(last.id)) {
      const blocks = mergeStreamingBlock(last.blocks, block)
      const next: AcpMessage = { id: last.id, role, blocks, text: blocksToText(blocks) }
      this._messages = [...this._messages.slice(0, -1), next]
    } else {
      const id = `m${++this._msgCounter}`
      this._streamingIds.add(id)
      const blocks: readonly ContentBlock[] = [block]
      this._messages = [...this._messages, { id, role, blocks, text: blocksToText(blocks) }]
    }
    this.messages.set(this._messages, this._batchedTx())
  }

  private readonly _streamingIds = new Set<string>()
  private _isStreaming(id: string): boolean {
    return this._streamingIds.has(id)
  }

  private _flushStream(): void {
    this._streamingIds.clear()
    this.messages.set(this._messages, undefined)
    this._commitBatchedTx()
  }

  private _appendMessage(role: AcpMessageRole, text: string): void {
    const id = `m${++this._msgCounter}`
    const blocks: readonly ContentBlock[] = [{ type: 'text', text }]
    this._messages = [...this._messages, { id, role, blocks, text }]
    this.messages.set(this._messages, undefined)
  }

  private _upsertToolCall(call: AcpToolCall): void {
    const idx = this._toolCalls.findIndex((t) => t.id === call.id)
    if (idx === -1) {
      this._toolCalls = [...this._toolCalls, call]
    } else {
      this._toolCalls = [...this._toolCalls.slice(0, idx), call, ...this._toolCalls.slice(idx + 1)]
    }
    this.toolCalls.set(this._toolCalls, this._batchedTx())
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

function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
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
 * Flatten the SDK's ToolCallContent[] (a discriminated union of content / diff /
 * terminal wrappers) into a flat ContentBlock[] so the existing MessageContent
 * renderer can display tool call output uniformly. Non-text variants (diff,
 * terminal) become a labelled text placeholder — full rendering can land in a
 * follow-up.
 */
function toolCallContentToBlocks(content: readonly ToolCallContent[]): readonly ContentBlock[] {
  const out: ContentBlock[] = []
  for (const item of content) {
    switch (item.type) {
      case 'content':
        out.push(item.content)
        break
      case 'diff':
        out.push({ type: 'text', text: `[diff: ${item.path}]` })
        break
      case 'terminal':
        out.push({ type: 'text', text: `[terminal: ${item.terminalId}]` })
        break
    }
  }
  return out
}

/**
 * Merge an incoming streaming chunk into the existing blocks list. Consecutive
 * `text` blocks collapse into a single block so the markdown parser can see a
 * coherent document; non-text blocks (image / resource / resource_link / audio)
 * are appended as-is.
 */
function mergeStreamingBlock(
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

/**
 * Convert the legacy `SessionModeState` into a synthetic ConfigOption (category
 * `mode`) so the UI can render legacy and new agents identically. The id is
 * stable — the upper layer detects "legacy mode" by checking whether the agent
 * ever published a real ConfigOption with the same id (it didn't if this
 * synthetic id is in use).
 */
const LEGACY_MODE_OPTION_ID = '__legacy_mode__'

function legacyModesToConfigOption(state: SessionModeState): SessionConfigOption {
  return {
    type: 'select',
    id: LEGACY_MODE_OPTION_ID,
    name: 'Mode',
    category: 'mode',
    currentValue: state.currentModeId,
    options: state.availableModes.map((m) => ({
      value: m.id,
      name: m.name,
      ...(m.description !== undefined && m.description !== null
        ? { description: m.description }
        : {}),
    })),
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export class AcpSessionService
  extends Disposable
  implements IAcpSessionService, IAcpClientNotificationSink
{
  declare readonly _serviceBrand: undefined

  readonly sessions: ISettableObservable<readonly IAcpSession[]>
  readonly activeSessionId: ISettableObservable<string | undefined>
  readonly activeSession: ISettableObservable<IAcpSession | undefined>

  private readonly _onDidCreate = this._register(new Emitter<IAcpSession>())
  readonly onDidCreate = this._onDidCreate.event

  private readonly _byAgentSessionId = new Map<string, AcpSession>()
  private _sessions: AcpSession[] = []
  private _seq = 0
  private readonly _logger: ILogger

  constructor(
    @IAcpClientService private readonly _client: IAcpClientService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @INotificationService private readonly _notification: INotificationService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @IAcpPermissionHandler private readonly _permission: IAcpPermissionHandler,
    @IProgressService private readonly _progress: IProgressService,
    @ILoggerService loggerService: ILoggerService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSession', name: 'ACP Session' })
    this.sessions = observableValue<readonly IAcpSession[]>('acp.sessions', [])
    this.activeSessionId = observableValue<string | undefined>('acp.activeSessionId', undefined)
    this.activeSession = observableValue<IAcpSession | undefined>('acp.activeSession', undefined)
  }

  async createSession(agentId?: string): Promise<IAcpSession> {
    const resolvedAgentId = agentId ?? this._registry.defaultAgentId()
    const agentName = this._registry.get(resolvedAgentId).name
    return this._progress.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Starting ${agentName}…`,
        cancellable: true,
        source: 'acp',
      },
      async (progress, token) => {
        const cwd = this._workspace.current?.folder.fsPath
        progress.report({ message: 'Spawning agent process…' })
        const conn = await this._client.connect(
          resolvedAgentId,
          this,
          cwd !== undefined ? { cwd } : {},
        )
        const cancelSub = token.onCancellationRequested(() => conn.dispose())
        const timeoutMs =
          this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
        const mcpServers = this._readMcpServers()
        const initParams: InitializeRequest = {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }
        try {
          progress.report({ message: 'Negotiating ACP protocol…' })
          await withTimeout(conn.conn.initialize(initParams), timeoutMs, 'ACP initialize')
          progress.report({ message: 'Creating session…' })
          const newParams: NewSessionRequest = {
            cwd: cwd ?? '',
            mcpServers: mcpServers as NewSessionRequest['mcpServers'],
          }
          const result = await withTimeout(
            conn.conn.newSession(newParams),
            timeoutMs,
            'ACP session/new',
          )
          const localId = `s${++this._seq}`
          const title = `${agentName} · ${localId}`
          const initState: IAcpSessionInitState = {
            ...(result.configOptions ? { configOptions: result.configOptions } : {}),
            ...(result.modes ? { modes: result.modes } : {}),
          }
          // Record the session in persistent history BEFORE constructing AcpSession
          // so the session has its historyId from the first sendPrompt onwards. The
          // history.add call returns synchronously; the storage write is debounced.
          const histEntry = this._history.add({
            agentId: resolvedAgentId,
            sessionIdOnAgent: result.sessionId,
            title,
            ...(cwd !== undefined ? { cwd } : {}),
          })
          const session = new AcpSession(
            localId,
            resolvedAgentId,
            title,
            conn,
            result.sessionId,
            this._telemetry,
            initState,
            histEntry.id,
            this._history,
          )
          this._byAgentSessionId.set(result.sessionId, session)
          transaction((tx) => {
            this._sessions = [...this._sessions, session]
            this.sessions.set(this._sessions, tx)
            this.activeSessionId.set(localId, tx)
            this.activeSession.set(session, tx)
          })
          this._telemetry.publicLog('acp.session_created', { agentId: resolvedAgentId })
          this._onDidCreate.fire(session)
          return session
        } catch (err) {
          conn.dispose()
          const msg = (err as Error).message
          this._logger.warn(`[acp] createSession failed: ${msg}`)
          this._notification.notify({
            severity: Severity.Error,
            message: `Failed to start agent session: ${msg}`,
          })
          this._telemetry.publicLogError('acp.session_create_failed', {
            agentId: resolvedAgentId,
            error: msg,
          })
          throw err
        } finally {
          cancelSub.dispose()
        }
      },
    )
  }

  setActive(sessionId: string): void {
    const s = this._sessions.find((x) => x.id === sessionId)
    if (!s) return
    this.activeSessionId.set(sessionId, undefined)
    this.activeSession.set(s, undefined)
  }

  async resumeSession(historyId: string): Promise<IAcpSession> {
    const entry = this._history.get(historyId)
    if (!entry) {
      throw new Error(`Unknown agent session history id: ${historyId}`)
    }
    // If a live session backed by the same sessionIdOnAgent is already open,
    // surface it instead of spawning a duplicate agent process.
    const existing = this._byAgentSessionId.get(entry.sessionIdOnAgent)
    if (existing && existing.status.get() !== 'closed') {
      this.setActive(existing.id)
      return existing
    }
    const cwd = entry.cwd
    const conn = await this._client.connect(entry.agentId, this, cwd !== undefined ? { cwd } : {})
    const timeoutMs = this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
    const mcpServers = this._readMcpServers()
    const initParams: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }
    let session: AcpSession | undefined
    let registered = false
    try {
      const initResult = await withTimeout(
        conn.conn.initialize(initParams),
        timeoutMs,
        'ACP initialize',
      )
      if (initResult.agentCapabilities?.loadSession !== true) {
        throw new Error('Agent does not advertise agentCapabilities.loadSession — cannot resume')
      }
      const localId = `s${++this._seq}`
      const title = `${this._registry.get(entry.agentId).name} · ${localId}`
      // Construct the AcpSession BEFORE session/load so any session/update
      // notifications the agent emits during replay route through this._byAgentSessionId.
      session = new AcpSession(
        localId,
        entry.agentId,
        title,
        conn,
        entry.sessionIdOnAgent,
        this._telemetry,
        undefined,
        historyId,
        this._history,
      )
      this._byAgentSessionId.set(entry.sessionIdOnAgent, session)
      const captured = session
      transaction((tx) => {
        this._sessions = [...this._sessions, captured]
        this.sessions.set(this._sessions, tx)
        this.activeSessionId.set(localId, tx)
        this.activeSession.set(captured, tx)
      })
      registered = true

      const loadParams: LoadSessionRequest = {
        sessionId: entry.sessionIdOnAgent,
        cwd: cwd ?? '',
        mcpServers: mcpServers as LoadSessionRequest['mcpServers'],
      }
      const loadResult = await withTimeout(
        conn.conn.loadSession(loadParams),
        timeoutMs,
        'ACP session/load',
      )
      if (loadResult && (loadResult.modes || loadResult.configOptions)) {
        session.applyInitState({
          ...(loadResult.modes ? { modes: loadResult.modes } : {}),
          ...(loadResult.configOptions ? { configOptions: loadResult.configOptions } : {}),
        })
      }
      this._history.touch(historyId)
      this._telemetry.publicLog('acp.session_resumed', {
        agentId: entry.agentId,
      })
      this._onDidCreate.fire(session)
      return session
    } catch (err) {
      if (registered && session) {
        const captured = session
        // Rollback: drop the partial session before bubbling the error.
        this._sessions = this._sessions.filter((x) => x !== captured)
        this.sessions.set(this._sessions, undefined)
        this._byAgentSessionId.delete(entry.sessionIdOnAgent)
        if (this.activeSession.get() === captured) {
          const next = this._sessions[0]
          this.activeSessionId.set(next?.id, undefined)
          this.activeSession.set(next, undefined)
        }
        captured.dispose()
      } else {
        conn.dispose()
      }
      const msg = (err as Error).message
      this._logger.warn(`[acp] resumeSession failed: ${msg}`)
      this._notification.notify({
        severity: Severity.Error,
        message: `Failed to resume agent session: ${msg}`,
      })
      this._telemetry.publicLogError('acp.session_resume_failed', {
        agentId: entry.agentId,
        error: msg,
      })
      throw err
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const idx = this._sessions.findIndex((x) => x.id === sessionId)
    if (idx === -1) return
    const session = this._sessions[idx]!
    await session.close()
    this._sessions = this._sessions.filter((x) => x.id !== sessionId)
    this.sessions.set(this._sessions, undefined)
    for (const [k, v] of this._byAgentSessionId) {
      if (v === session) {
        this._byAgentSessionId.delete(k)
        break
      }
    }
    if (this.activeSessionId.get() === sessionId) {
      const next = this._sessions[0]
      this.activeSessionId.set(next?.id, undefined)
      this.activeSession.set(next, undefined)
    }
    this._telemetry.publicLog('acp.session_closed', { sessionId })
  }

  getById(sessionId: string): IAcpSession | undefined {
    return this._sessions.find((x) => x.id === sessionId)
  }

  getByHistoryId(historyId: string): IAcpSession | undefined {
    return this._sessions.find((x) => x.historyId === historyId)
  }

  // -- IAcpClientNotificationSink ---------------------------------------

  onSessionUpdate(params: SessionNotification): void {
    const session = this._byAgentSessionId.get(params.sessionId)
    if (!session) return
    session.applyUpdate(params.update)
  }

  async onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const auto = this._permission.tryAutoApprove(params)
    if (auto) {
      this._telemetry.publicLog('acp.permission_auto_approved', {
        kind: params.toolCall.kind ?? 'unknown',
      })
      return auto
    }
    const session = this._byAgentSessionId.get(params.sessionId)
    if (!session) {
      this._logger.warn(`[acp] request_permission for unknown session ${params.sessionId}`)
      return { outcome: { outcome: 'cancelled' } }
    }
    const allowAlways = params.options.find((o) => o.kind === 'allow_always')
    return await new Promise<RequestPermissionResponse>((resolve) => {
      const settle = (result: RequestPermissionResponse): void => {
        if (session.pendingPermission.get() === pending) {
          session.pendingPermission.set(undefined, undefined)
        }
        resolve(result)
      }
      const pending: AcpPendingPermission = {
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? params.toolCall.toolCallId,
        ...(params.toolCall.kind != null ? { kind: params.toolCall.kind } : {}),
        options: params.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          ...(o.kind !== undefined ? { kind: o.kind } : {}),
        })),
        resolve: (optionId) => {
          if (allowAlways && optionId === allowAlways.optionId && params.toolCall.kind) {
            this._permission.persistAllow(params.toolCall.kind)
          }
          this._telemetry.publicLog('acp.permission_resolved', { optionId })
          settle({ outcome: { outcome: 'selected', optionId } })
        },
        cancel: () => {
          this._telemetry.publicLog('acp.permission_cancelled', {})
          settle({ outcome: { outcome: 'cancelled' } })
        },
      }
      session.presentPermission(pending)
    })
  }

  private _readMcpServers(): readonly unknown[] {
    const raw = this._config.get<unknown>('acp.mcpServers')
    return Array.isArray(raw) ? raw : []
  }
}
