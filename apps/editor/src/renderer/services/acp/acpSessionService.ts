/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionService — facade for the multi-session ACP layer.
 *
 *  Responsibilities (everything else is delegated):
 *    - register / lookup of live `AcpSession` instances by local id / agent
 *      session id / history id
 *    - observable aggregation: `sessions`, `activeSessionId`, `activeSession`
 *    - IAcpClientNotificationSink dispatch (route session/update + auto-approve
 *      or surface a permission card)
 *    - workspace-swap orchestration (suspend persist → clear state → close
 *      live sessions → hand off to coordinator)
 *
 *  Session creation/resume specifics live on the session itself; restore /
 *  hydrate / delete-on-agent live on the AcpSessionRestoreCoordinator.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  Disposable,
  Emitter,
  IConfigurationService,
  IHostService,
  ILoggerService,
  INotificationService,
  IProgressService,
  IStorageService,
  ITelemetryService,
  IWorkspaceService,
  ProgressLocation,
  Severity,
  StorageScope,
  observableValue,
  transaction,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import {
  PROTOCOL_VERSION,
  type InitializeRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { IAcpClientService, type IAcpClientNotificationSink } from './acpClientService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPermissionHandler } from './acpPermissionHandler.js'
import { IAcpSessionHistoryService } from './acpSessionHistory.js'
import { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import {
  AcpSession,
  type AcpPendingPermission,
  type IAcpSession,
  type IAcpSessionInitState,
} from './acpSession.js'
import {
  ACP_ACTIVE_SESSION_STORAGE_KEY,
  AcpSessionRestoreCoordinator,
} from './acpSessionRestoreCoordinator.js'
import type { PromptMention } from './promptMentions.js'

export type { PromptMention }
export {
  AcpAbortError,
  type AcpMessage,
  type AcpMessageRole,
  type AcpToolCall,
  type AcpToolCallStatus,
  type AcpPlanEntry,
  type AcpPendingPermission,
  type AcpSessionStatus,
  type IAcpSession,
  type IAcpSessionInitState,
} from './acpSession.js'

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
  /**
   * If a previously-active session's historyId was persisted (workspace scope),
   * resume it. No-op when no pending restore exists, when a session is already
   * active, or when the history entry has been removed. Idempotent — the pending
   * id is claimed on first call so concurrent invocations resume at most once.
   */
  tryRestoreActiveSession(): Promise<void>
  /**
   * Lazily kick off the cross-agent `session/list` hydrate sweep. Idempotent
   * per workspace cwd: a second call within the same workspace is a no-op
   * unless `onDidChangeWorkspaceScope` has fired since. Wired to the Agents
   * view visibility autorun so we never spawn agent subprocesses inside the
   * workspace cwd until the user actually opens the Agents UI.
   */
  requestHydrateIfNeeded(): void
  /**
   * 用户主动触发的刷新：强制重新执行 `session/list` 扫描，无视
   * `requestHydrateIfNeeded` 的 cwd 幂等门。返回 Promise 便于 UI 展示
   * loading 状态；并发调用会折叠到同一次 sweep。
   */
  refreshSessions(): Promise<void>
  /**
   * Best-effort: ask the owning agent to delete a session via `session/delete`.
   * Returns `'unsupported'` if the agent did not advertise
   * `sessionCapabilities.delete` at last hydrate, `'unknown'` if we have no
   * history entry for the id, `'ok'` if the call succeeded, `'error'` for any
   * RPC / spawn failure (caller is expected to still remove the local row).
   */
  deleteOnAgent(historyId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'>
}

export const IAcpSessionService = createDecorator<IAcpSessionService>('acpSessionService')

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

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
  private readonly _coordinator: AcpSessionRestoreCoordinator

  /** While true, the activeSessionId autorun skips writing to storage. */
  private _suspendActivePersist = false

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
    @IStorageService private readonly _storage: IStorageService,
    @IAcpAgentDefaultsService private readonly _agentDefaults: IAcpAgentDefaultsService,
    @IHostService hostService: IHostService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSession', name: 'ACP Session' })
    this.sessions = observableValue<readonly IAcpSession[]>('acp.sessions', [])
    this.activeSessionId = observableValue<string | undefined>('acp.activeSessionId', undefined)
    this.activeSession = observableValue<IAcpSession | undefined>('acp.activeSession', undefined)

    this._coordinator = this._register(
      new AcpSessionRestoreCoordinator(
        this._client,
        this._registry,
        this._history,
        this._storage,
        this._notification,
        this._telemetry,
        loggerService,
        hostService.platform,
        {
          resumeSession: (historyId) => this.resumeSession(historyId),
          hasActiveSession: () => this.activeSessionId.get() !== undefined,
          getCurrentCwd: () => this._workspace.current?.folder.fsPath,
          whenWorkspaceReady: () => this._workspace.whenReady,
          getLiveHistoryIds: () => {
            const ids = new Set<string>()
            for (const s of this._sessions) {
              if (s.historyId) ids.add(s.historyId)
            }
            return ids
          },
        },
      ),
    )
    this._coordinator.start()

    // Persist the active session's historyId so we can restore it on the next
    // editor launch. Mirrors OutputService's "restore last active" pattern.
    this._register(
      autorun((r) => {
        const session = this.activeSession.read(r)
        if (this._suspendActivePersist) return
        const historyId = session?.historyId
        if (historyId) {
          void this._storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, historyId, StorageScope.WORKSPACE)
        } else {
          void this._storage.remove(ACP_ACTIVE_SESSION_STORAGE_KEY, StorageScope.WORKSPACE)
        }
      }),
    )
    // Workspace swap: close all live sessions and re-read the active-session
    // pointer from the new bucket.
    this._register(this._storage.onDidChangeWorkspaceScope(() => void this._onWorkspaceSwap()))
  }

  /**
   * The user switched (or closed) the workspace folder. All live sessions point
   * at agent processes spawned with the OLD cwd, so we tear them down and let
   * the coordinator re-read the active-session pointer from the new bucket.
   *
   * Order is critical: `_suspendActivePersist` MUST go up *before* clearing
   * `activeSession`, otherwise the autorun fires while activeSession is
   * undefined and writes "remove" into the new bucket — deleting whatever
   * active-id the new workspace actually had stored.
   */
  private async _onWorkspaceSwap(): Promise<void> {
    this._suspendActivePersist = true
    const oldSessions = this._sessions
    transaction((tx) => {
      this._sessions = []
      this.sessions.set(this._sessions, tx)
      this.activeSessionId.set(undefined, tx)
      this.activeSession.set(undefined, tx)
    })
    this._byAgentSessionId.clear()
    for (const session of oldSessions) {
      void session.close().catch((err) => {
        this._logger.warn(`close on workspace swap failed: ${(err as Error).message}`)
      })
    }
    try {
      await this._coordinator.onWorkspaceSwap()
    } finally {
      this._suspendActivePersist = false
    }
  }

  tryRestoreActiveSession(): Promise<void> {
    return this._coordinator.tryRestoreActiveSession()
  }

  requestHydrateIfNeeded(): void {
    this._coordinator.requestHydrate()
  }

  refreshSessions(): Promise<void> {
    return this._coordinator.refresh()
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
          const initState: IAcpSessionInitState = result.configOptions
            ? { configOptions: result.configOptions }
            : {}
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
            this._agentDefaults,
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
          this._scheduleConfigPushBack(session, this._agentDefaults.getDefaults(resolvedAgentId))
          return session
        } catch (err) {
          conn.dispose()
          const msg = (err as Error).message
          this._logger.warn(`createSession failed: ${msg}`)
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
        this._agentDefaults,
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
      if (loadResult?.configOptions) {
        session.applyInitState({ configOptions: loadResult.configOptions })
      }
      this._history.touch(historyId)
      this._telemetry.publicLog('acp.session_resumed', {
        agentId: entry.agentId,
      })
      this._onDidCreate.fire(session)
      // Per-session history wins over per-agent defaults: a user who picked
      // distinct values for a specific session expects them on resume even if
      // the global default has since changed.
      const cached: Record<string, string> = {
        ...this._agentDefaults.getDefaults(entry.agentId),
        ...(entry.configOptions ?? {}),
      }
      this._scheduleConfigPushBack(session, cached)
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
      this._logger.warn(`resumeSession failed: ${msg}`)
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

  deleteOnAgent(historyId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
    return this._coordinator.deleteOnAgent(historyId)
  }

  /**
   * Reconcile a cached `configOptions` bag against the session's current
   * server-advertised values, and push the diff back to the agent. Used by
   * `createSession` (per-agent default) and `resumeSession` (per-session
   * history + per-agent default). Scheduled via `queueMicrotask` so the
   * push-back fences against any in-flight `session/update` notifications
   * that the agent may emit during `session/new` or `session/load`.
   *
   * Failures on a single push are logged but never thrown — one stale cached
   * value should not abort the session creation flow.
   */
  private _scheduleConfigPushBack(
    session: AcpSession,
    cached: Readonly<Record<string, string>>,
  ): void {
    const ids = Object.keys(cached)
    if (ids.length === 0) return
    queueMicrotask(async () => {
      if (session.status.get() === 'closed') return
      const cur = session.configOptions.get()
      for (const id of ids) {
        const desired = cached[id]
        if (desired === undefined) continue
        const opt = cur.find((o) => o.id === id)
        // Only push known configs whose current server value differs.
        if (!opt) continue
        const currentValue = (opt as { currentValue?: unknown }).currentValue
        if (currentValue === desired) continue
        try {
          await session.setConfigOption(id, desired)
        } catch (err) {
          this._logger.warn(
            `failed to restore configOption ${id}=${desired}: ${(err as Error).message}`,
          )
        }
      }
    })
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
      this._logger.warn(`request_permission for unknown session ${params.sessionId}`)
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
