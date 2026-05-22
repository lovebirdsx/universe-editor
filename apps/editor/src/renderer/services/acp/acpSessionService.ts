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
 *  ACP `initialize` + `session/new`, then stays idle until `sendPrompt(text)`
 *  is called. `cancelTurn()` issues `session/cancel`. `close()` disposes the
 *  connection (which kills the process via the host) and removes the session
 *  from the observable list.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  IWorkspaceService,
  observableValue,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { IAcpClientService, type IAcpClientNotificationSink } from './acpClientService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import type { AcpConnection } from './acpConnection.js'
import {
  ACP_PROTOCOL_VERSION,
  AcpMethods,
  type AcpContentBlock,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
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

export type AcpSessionStatus = 'idle' | 'connecting' | 'running' | 'errored' | 'closed'

export interface IAcpSession {
  readonly id: string
  readonly agentId: string
  readonly title: string
  readonly messages: IObservable<readonly AcpMessage[]>
  readonly toolCalls: IObservable<readonly AcpToolCall[]>
  readonly plan: IObservable<readonly AcpPlanEntry[]>
  readonly status: IObservable<AcpSessionStatus>
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

class AcpSession extends Disposable implements IAcpSession {
  readonly messages: ISettableObservable<readonly AcpMessage[]>
  readonly toolCalls: ISettableObservable<readonly AcpToolCall[]>
  readonly plan: ISettableObservable<readonly AcpPlanEntry[]>
  readonly status: ISettableObservable<AcpSessionStatus>

  /** Internal: backing arrays for cheap mutations before publishing snapshots. */
  private _messages: AcpMessage[] = []
  private _toolCalls: AcpToolCall[] = []
  private _msgCounter = 0

  /** Active streaming buffer per role for chunked updates. */
  private _streamBuffer = new Map<AcpMessageRole, string>()

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly title: string,
    private readonly _conn: AcpConnection,
    private readonly _sessionIdOnAgent: string,
  ) {
    super()
    this.messages = observableValue<readonly AcpMessage[]>(`acp.session.messages.${id}`, [])
    this.toolCalls = observableValue<readonly AcpToolCall[]>(`acp.session.toolCalls.${id}`, [])
    this.plan = observableValue<readonly AcpPlanEntry[]>(`acp.session.plan.${id}`, [])
    this.status = observableValue<AcpSessionStatus>(`acp.session.status.${id}`, 'idle')
    this._register(this._conn)
    this._register(
      this._conn.onExit(() => {
        this.status.set('closed', undefined)
      }),
    )
  }

  async sendPrompt(text: string): Promise<void> {
    this._appendMessage('user', text)
    this.status.set('running', undefined)
    const params: AcpSessionPromptParams = {
      sessionId: this._sessionIdOnAgent,
      prompt: [{ type: 'text', text }],
    }
    try {
      await this._conn.request<AcpSessionPromptResult>(AcpMethods.SessionPrompt, params)
      this._flushStream()
      this.status.set('idle', undefined)
    } catch (err) {
      this._flushStream()
      this.status.set('errored', undefined)
      this._appendMessage('agent', `[error] ${(err as Error).message}`)
    }
  }

  async cancelTurn(): Promise<void> {
    const params: AcpSessionCancelParams = { sessionId: this._sessionIdOnAgent }
    try {
      await this._conn.notify(AcpMethods.SessionCancel, params)
    } catch {
      // swallow — cancel is best-effort
    }
  }

  async close(): Promise<void> {
    this.status.set('closed', undefined)
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
    if (block.type !== 'text') return
    const buf = (this._streamBuffer.get(role) ?? '') + block.text
    this._streamBuffer.set(role, buf)
    // Update or create the last message of this role.
    const last = this._messages[this._messages.length - 1]
    if (last && last.role === role && this._isStreaming(last.id)) {
      const next: AcpMessage = { id: last.id, role, text: buf }
      this._messages = [...this._messages.slice(0, -1), next]
    } else {
      const id = `m${++this._msgCounter}`
      this._streamingIds.add(id)
      this._messages = [...this._messages, { id, role, text: buf }]
    }
    this.messages.set(this._messages, undefined)
  }

  private readonly _streamingIds = new Set<string>()
  private _isStreaming(id: string): boolean {
    return this._streamingIds.has(id)
  }

  private _flushStream(): void {
    this._streamBuffer.clear()
    this._streamingIds.clear()
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
    this.toolCalls.set(this._toolCalls, undefined)
  }
}

function blocksToText(blocks: readonly AcpContentBlock[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? b.uri : ''))
    .join('')
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

  constructor(
    @IAcpClientService private readonly _client: IAcpClientService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {
    super()
    this.sessions = observableValue<readonly IAcpSession[]>('acp.sessions', [])
    this.activeSessionId = observableValue<string | undefined>('acp.activeSessionId', undefined)
    this.activeSession = observableValue<IAcpSession | undefined>('acp.activeSession', undefined)
  }

  async createSession(agentId?: string): Promise<IAcpSession> {
    const resolvedAgentId = agentId ?? this._registry.defaultAgentId()
    const cwd = this._workspace.current?.folder.fsPath
    const conn = await this._client.connect(resolvedAgentId, this, cwd !== undefined ? { cwd } : {})
    const initParams: AcpInitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }
    await conn.request<AcpInitializeResult>(AcpMethods.Initialize, initParams)
    const newParams: AcpNewSessionParams = { cwd: cwd ?? '', mcpServers: [] }
    const { sessionId: agentSessionId } = await conn.request<AcpNewSessionResult>(
      AcpMethods.NewSession,
      newParams,
    )
    const localId = `s${++this._seq}`
    const title = `${this._registry.get(resolvedAgentId).name} · ${localId}`
    const session = new AcpSession(localId, resolvedAgentId, title, conn, agentSessionId)
    this._byAgentSessionId.set(agentSessionId, session)
    this._sessions = [...this._sessions, session]
    this.sessions.set(this._sessions, undefined)
    this.setActive(localId)
    this._onDidCreate.fire(session)
    return session
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
  }

  getById(sessionId: string): IAcpSession | undefined {
    return this._sessions.find((x) => x.id === sessionId)
  }

  // -- IAcpClientNotificationSink ---------------------------------------

  onSessionUpdate(params: AcpSessionUpdateParams): void {
    const session = this._byAgentSessionId.get(params.sessionId)
    if (!session) return
    session.applyUpdate(params.update)
  }
}
