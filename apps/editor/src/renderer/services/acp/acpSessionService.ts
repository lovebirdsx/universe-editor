/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionService — high-level multi-session state on top of AcpClientService.
 *
 *  Each Session owns one agent process (one AcpConnection). The service exposes
 *  observable arrays for the React layer to render:
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
import { IAcpClientService, type IAcpClientNotificationSink } from './acpClientService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPermissionHandler } from './acpPermissionHandler.js'
import { AcpAbortError, type AcpConnection } from './acpConnection.js'
import {
  ACP_PROTOCOL_VERSION,
  AcpMethods,
  parseSessionUpdateParams,
  type AcpContentBlock,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionCancelParams,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type AcpSessionUpdate,
  type AcpSessionUpdateParams,
} from './acpProtocol.js'

// ---------------------------------------------------------------------------
// Public view model
// ---------------------------------------------------------------------------

export type AcpMessageRole = 'user' | 'agent' | 'thought'

export interface AcpMessage {
  readonly id: string
  readonly role: AcpMessageRole
  readonly text: string
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface AcpToolCall {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: AcpToolCallStatus
  readonly text: string
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

export interface IAcpSession {
  readonly id: string
  readonly agentId: string
  readonly title: string
  readonly messages: IObservable<readonly AcpMessage[]>
  readonly toolCalls: IObservable<readonly AcpToolCall[]>
  readonly plan: IObservable<readonly AcpPlanEntry[]>
  readonly status: IObservable<AcpSessionStatus>
  readonly pendingPermission: IObservable<AcpPendingPermission | undefined>
  /** Internal — call site is the permission handler. */
  presentPermission(p: AcpPendingPermission): void
  sendPrompt(text: string): Promise<void>
  cancelTurn(): Promise<void>
  close(): Promise<void>
}

export interface IAcpSessionService {
  readonly _serviceBrand: undefined
  readonly sessions: IObservable<readonly IAcpSession[]>
  readonly activeSessionId: IObservable<string | undefined>
  readonly activeSession: IObservable<IAcpSession | undefined>
  createSession(agentId?: string): Promise<IAcpSession>
  setActive(sessionId: string): void
  closeSession(sessionId: string): Promise<void>
  getById(sessionId: string): IAcpSession | undefined
}

export const IAcpSessionService = createDecorator<IAcpSessionService>('acpSessionService')

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000

class AcpSession extends Disposable implements IAcpSession {
  readonly messages: ISettableObservable<readonly AcpMessage[]>
  readonly toolCalls: ISettableObservable<readonly AcpToolCall[]>
  readonly plan: ISettableObservable<readonly AcpPlanEntry[]>
  readonly status: ISettableObservable<AcpSessionStatus>
  readonly pendingPermission: ISettableObservable<AcpPendingPermission | undefined>

  private _messages: AcpMessage[] = []
  private _toolCalls: AcpToolCall[] = []
  private _msgCounter = 0

  private _streamBuffer = new Map<AcpMessageRole, string>()
  /** Abort controller for the in-flight `session/prompt`. */
  private _activeAbort: AbortController | undefined

  // 16ms batching: collapse bursts of session/update chunks into one
  // observer notification per frame. Underlying values still update
  // synchronously (set(v, tx) writes _value before tx.finish()).
  private _pendingTx: TransactionImpl | undefined
  private _flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly title: string,
    private readonly _conn: AcpConnection,
    private readonly _sessionIdOnAgent: string,
    private readonly _telemetry: ITelemetryService,
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
    this._register(this._conn)
    this._register(
      this._conn.onExit(() => {
        this._commitBatchedTx()
        this.status.set('closed', undefined)
        this._cancelPending()
      }),
    )
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

  async sendPrompt(text: string): Promise<void> {
    this._appendMessage('user', text)
    this.status.set('running', undefined)
    const params: AcpSessionPromptParams = {
      sessionId: this._sessionIdOnAgent,
      prompt: [{ type: 'text', text }],
    }
    const abort = new AbortController()
    this._activeAbort = abort
    this._telemetry.publicLog('acp.prompt_sent', { sessionId: this.id })
    try {
      await this._conn.request<AcpSessionPromptResult>(
        AcpMethods.SessionPrompt,
        params,
        abort.signal,
      )
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
    const params: AcpSessionCancelParams = { sessionId: this._sessionIdOnAgent }
    try {
      await this._conn.notify(AcpMethods.SessionCancel, params)
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

  applyUpdate(update: AcpSessionUpdate): void {
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
      case 'tool_call':
        this._upsertToolCall({
          id: update.toolCallId,
          title: update.title ?? update.toolCallId,
          kind: update.kind ?? 'unknown',
          status: update.status ?? 'pending',
          text: blocksToText(update.content),
        })
        this._telemetry.publicLog('acp.tool_call_started', {
          sessionId: this.id,
          kind: update.kind ?? 'unknown',
        })
        break
      case 'tool_call_update': {
        const existing = this._toolCalls.find((t) => t.id === update.toolCallId)
        const next: AcpToolCall = {
          id: update.toolCallId,
          title: existing?.title ?? update.toolCallId,
          kind: existing?.kind ?? 'unknown',
          status: update.status ?? existing?.status ?? 'pending',
          text: update.content ? blocksToText(update.content) : (existing?.text ?? ''),
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
    }
  }

  private _appendChunk(role: AcpMessageRole, block: AcpContentBlock): void {
    if (block.type !== 'text') {
      // image / resource blocks: surface a minimal placeholder rather than
      // silently dropping content the user could otherwise inspect.
      const placeholder = block.type === 'resource' ? `[resource: ${block.uri}]` : `[image]`
      this._appendBufferedChunk(role, placeholder)
      this.messages.set(this._messages, this._batchedTx())
      return
    }
    this._appendBufferedChunk(role, block.text)
    this.messages.set(this._messages, this._batchedTx())
  }

  private _appendBufferedChunk(role: AcpMessageRole, text: string): void {
    const buf = (this._streamBuffer.get(role) ?? '') + text
    this._streamBuffer.set(role, buf)
    const last = this._messages[this._messages.length - 1]
    if (last && last.role === role && this._isStreaming(last.id)) {
      const next: AcpMessage = { id: last.id, role, text: buf }
      this._messages = [...this._messages.slice(0, -1), next]
    } else {
      const id = `m${++this._msgCounter}`
      this._streamingIds.add(id)
      this._messages = [...this._messages, { id, role, text: buf }]
    }
  }

  private readonly _streamingIds = new Set<string>()
  private _isStreaming(id: string): boolean {
    return this._streamingIds.has(id)
  }

  private _flushStream(): void {
    this._streamBuffer.clear()
    this._streamingIds.clear()
    this.messages.set(this._messages, undefined)
    this._commitBatchedTx()
  }

  private _appendMessage(role: AcpMessageRole, text: string): void {
    const id = `m${++this._msgCounter}`
    this._messages = [...this._messages, { id, role, text }]
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

function blocksToText(blocks: readonly AcpContentBlock[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((b) =>
      b.type === 'text'
        ? b.text
        : b.type === 'resource'
          ? `[resource: ${b.uri}]`
          : `[image: ${b.mimeType}]`,
    )
    .join('')
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
        const initParams: AcpInitializeParams = {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        }
        try {
          progress.report({ message: 'Negotiating ACP protocol…' })
          await withTimeout(
            conn.request<AcpInitializeResult>(AcpMethods.Initialize, initParams),
            timeoutMs,
            'ACP initialize',
          )
          progress.report({ message: 'Creating session…' })
          const newParams: AcpNewSessionParams = { cwd: cwd ?? '', mcpServers }
          const { sessionId: agentSessionId } = await withTimeout(
            conn.request<AcpNewSessionResult>(AcpMethods.NewSession, newParams),
            timeoutMs,
            'ACP session/new',
          )
          const localId = `s${++this._seq}`
          const title = `${agentName} · ${localId}`
          const session = new AcpSession(
            localId,
            resolvedAgentId,
            title,
            conn,
            agentSessionId,
            this._telemetry,
          )
          this._byAgentSessionId.set(agentSessionId, session)
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

  // -- IAcpClientNotificationSink ---------------------------------------

  onSessionUpdate(params: AcpSessionUpdateParams): void {
    const parsed = parseSessionUpdateParams(params)
    if (!parsed) {
      this._logger.warn('[acp] dropping malformed session/update')
      return
    }
    const session = this._byAgentSessionId.get(parsed.sessionId)
    if (!session) return
    session.applyUpdate(parsed.update)
  }

  async onRequestPermission(
    params: AcpRequestPermissionParams,
  ): Promise<AcpRequestPermissionResult> {
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
    return await new Promise<AcpRequestPermissionResult>((resolve) => {
      const settle = (result: AcpRequestPermissionResult): void => {
        if (session.pendingPermission.get() === pending) {
          session.pendingPermission.set(undefined, undefined)
        }
        resolve(result)
      }
      const pending: AcpPendingPermission = {
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? params.toolCall.toolCallId,
        ...(params.toolCall.kind !== undefined ? { kind: params.toolCall.kind } : {}),
        options: params.options,
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
