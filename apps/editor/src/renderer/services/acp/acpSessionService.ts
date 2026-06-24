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
  ICommandService,
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
  localize,
  observableValue,
  transaction,
  type ILogger,
  type IObservable,
  type ISettableObservable,
  type Event,
} from '@universe-editor/platform'
import {
  type LoadSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  filterMcpServersByCapabilities,
  mcpServerTransport,
  normalizeMcpServers,
} from './acpMcpServers.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from './acpClientService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { isAuthRequiredError } from './acpAuthError.js'
import { IAcpPermissionHandler } from './acpPermissionHandler.js'
import { IAcpSessionHistoryService, type AcpSessionHistoryEntry } from './acpSessionHistory.js'
import { IAcpSessionTitleService } from './acpSessionTitleService.js'
import { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import { ISessionChangeTrackerService } from './sessionChangeTracker.js'
import { AcpChatViewStateCache } from './acpChatViewStateCache.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import { AcpPromptDraftCache } from './acpPromptDraftCache.js'
import { AcpQuestionDraftCache } from './acpQuestionDraftCache.js'
import {
  AcpSession,
  type AcpPendingPermission,
  type AcpPendingQuestion,
  type AskUserQuestionRequest,
  type AskUserQuestionResult,
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
  type AcpToolCallDiff,
  type AcpToolCallStatus,
  type AcpChildItem,
  type AcpPlanEntry,
  type AcpPlanEntryStatus,
  type AcpPendingPermission,
  type AcpPendingQuestion,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionRequest,
  type AskUserQuestionResult,
  type AcpSessionStatus,
  type AcpUsage,
  type IAcpSession,
  type IAcpSessionInitState,
  type TimelineItem,
} from './acpSession.js'

export interface IAcpSessionService {
  readonly _serviceBrand: undefined
  readonly sessions: IObservable<readonly IAcpSession[]>
  readonly activeSessionId: IObservable<string | undefined>
  readonly activeSession: IObservable<IAcpSession | undefined>
  /** Fired after a session is removed from `sessions`. Carries the closed session id. */
  readonly onDidCloseSession: Event<string>
  createSession(agentId?: string): Promise<IAcpSession>
  /**
   * Resume a previously-persisted session by its (agent-issued) sessionId.
   * Spawns a fresh agent process, validates `agentCapabilities.loadSession`,
   * replays the conversation via `session/load`, and registers the session
   * before issuing the load so streaming `session/update` notifications during
   * replay are routed correctly. Concurrent calls for the same sessionId
   * dedupe onto a single in-flight promise.
   */
  resumeSession(sessionId: string): Promise<IAcpSession>
  setActive(sessionId: string): void
  closeSession(sessionId: string): Promise<void>
  getById(sessionId: string): IAcpSession | undefined
  /**
   * If a previously-active session id was persisted (workspace scope), resume
   * it. No-op when no pending restore exists, when a session is already
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
  deleteOnAgent(sessionId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'>
}

export const IAcpSessionService = createDecorator<IAcpSessionService>('acpSessionService')

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

/** Min gap between auth-required toasts per session, collapsing prompt bursts. */
const AUTH_NOTIFICATION_COOLDOWN_MS = 10_000

/** ext-notification method the agent fork uses to forward raw Claude SDK messages. */
const SDK_MESSAGE_EXT_METHOD = '_claude/sdkMessage'

/**
 * `_meta` passed on session/new + session/load that asks the agent fork to
 * forward only the Claude SDK system-init message (which carries the MCP server
 * connection snapshot) via `extNotification(_claude/sdkMessage)`. Filtering to
 * `init` keeps the rest of the raw SDK stream off the wire.
 */
const EMIT_INIT_SDK_MESSAGE_META = {
  claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'init' }] },
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

  private readonly _onDidCloseSession = this._register(new Emitter<string>())
  readonly onDidCloseSession = this._onDidCloseSession.event

  private _sessions: AcpSession[] = []
  private readonly _logger: ILogger
  private readonly _coordinator: AcpSessionRestoreCoordinator

  /**
   * In-flight `resumeSession` promises keyed by sessionId. Concurrent callers
   * (e.g. AcpSessionEditor's useEffect + a click handler) dedupe onto the
   * same promise so we never spawn two agent subprocesses for one session.
   */
  private readonly _resumingBySessionId = new Map<string, Promise<IAcpSession>>()

  /** While true, the activeSessionId autorun skips writing to storage. */
  private _suspendActivePersist = false

  constructor(
    @IAcpClientService private readonly _client: IAcpClientService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @INotificationService private readonly _notification: INotificationService,
    @ICommandService private readonly _commands: ICommandService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @IAcpPermissionHandler private readonly _permission: IAcpPermissionHandler,
    @IProgressService private readonly _progress: IProgressService,
    @ILoggerService loggerService: ILoggerService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IStorageService private readonly _storage: IStorageService,
    @IAcpAgentDefaultsService private readonly _agentDefaults: IAcpAgentDefaultsService,
    @ISessionChangeTrackerService private readonly _changeTracker: ISessionChangeTrackerService,
    @IAcpSessionTitleService private readonly _titleService: IAcpSessionTitleService,
    @IHostService hostService: IHostService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSession', name: 'ACP Session' })
    this.sessions = observableValue<readonly IAcpSession[]>('acp.sessions', [])
    this.activeSessionId = observableValue<string | undefined>('acp.activeSessionId', undefined)
    this.activeSession = observableValue<IAcpSession | undefined>('acp.activeSession', undefined)
    // Install the notification sink on the (singleton) client service. The
    // pool fans out session/update + session/request_permission via this sink,
    // routing by params.sessionId, so a single sink supports the shared
    // connection per (agentId, cwd).
    this._client.setNotificationSink(this)

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
          resumeSession: (sessionId) => this.resumeSession(sessionId),
          hasActiveSession: () => this.activeSessionId.get() !== undefined,
          getCurrentCwd: () => this._workspace.current?.folder.fsPath,
          whenWorkspaceReady: () => this._workspace.whenReady,
          getLiveSessionIds: () => {
            const ids = new Set<string>()
            for (const s of this._sessions) ids.add(s.id)
            return ids
          },
        },
      ),
    )
    this._coordinator.start()

    // Persist the active session's id so we can restore it on the next editor
    // launch. The id is the agent-issued sessionId — durable across restarts.
    this._register(
      autorun((r) => {
        const session = this.activeSession.read(r)
        if (this._suspendActivePersist) return
        const sessionId = session?.id
        if (sessionId) {
          void this._storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, sessionId, StorageScope.WORKSPACE)
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
    this._resumingBySessionId.clear()
    for (const session of oldSessions) {
      void session.close().catch((err) => {
        this._logger.warn(`close on workspace swap failed: ${(err as Error).message}`)
      })
    }
    // Sessions belong to the OLD cwd; their connections must die immediately so
    // the new workspace doesn't accidentally reuse a process rooted in the old
    // sandbox during the 30s grace window.
    this._client.drainAll()
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
    const collapseModes = this._config.get<Record<string, string>>('acp.defaultCollapseModes') ?? {}
    const initialCollapseMode: CollapseMode =
      (collapseModes[resolvedAgentId] as CollapseMode | undefined) ?? 'default'
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
        const conn = await this._client.connect(resolvedAgentId, cwd !== undefined ? { cwd } : {})
        const cancelSub = token.onCancellationRequested(() => conn.dispose())
        const timeoutMs =
          this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
        const mcpServers = this._readMcpServers()
        try {
          progress.report({ message: 'Negotiating ACP protocol…' })
          const initResult = await withTimeout(conn.initializeResult, timeoutMs, 'ACP initialize')
          progress.report({ message: 'Creating session…' })
          const { kept, dropped } = filterMcpServersByCapabilities(
            mcpServers,
            initResult.agentCapabilities?.mcpCapabilities,
          )
          this._warnDroppedMcpServers(agentName, dropped)
          const newParams: NewSessionRequest = {
            cwd: cwd ?? '',
            mcpServers: kept,
            _meta: EMIT_INIT_SDK_MESSAGE_META,
          }
          const result = await withTimeout(
            conn.conn.newSession(newParams),
            timeoutMs,
            'ACP session/new',
          )
          conn.attachSession(result.sessionId)
          const now = new Date()
          const hh = String(now.getHours()).padStart(2, '0')
          const mm = String(now.getMinutes()).padStart(2, '0')
          const title = `${agentName} ${hh}:${mm}`
          const mcpSeed = kept.map((s) => ({ name: s.name, transport: mcpServerTransport(s) }))
          const initState: IAcpSessionInitState = {
            ...(result.configOptions ? { configOptions: result.configOptions } : {}),
            ...(mcpSeed.length > 0 ? { mcpServers: mcpSeed } : {}),
          }
          // Record the session in persistent history BEFORE constructing AcpSession
          // so the session has its history entry from the first sendPrompt onwards.
          // history.add returns synchronously; the storage write is debounced.
          this._history.add({
            agentId: resolvedAgentId,
            sessionIdOnAgent: result.sessionId,
            title,
            ...(cwd !== undefined ? { cwd } : {}),
            hasMessages: false,
          })
          const session = new AcpSession(
            result.sessionId,
            resolvedAgentId,
            title,
            conn,
            this._telemetry,
            initState,
            initialCollapseMode,
            this._history,
            this._agentDefaults,
            this._changeTracker,
            this._titleService,
          )
          this._register(session)
          this._wireAuthGuidance(session)
          transaction((tx) => {
            this._sessions = [...this._sessions, session]
            this.sessions.set(this._sessions, tx)
            this.activeSessionId.set(session.id, tx)
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
          if (isAuthRequiredError(err)) {
            // No usable credentials yet — point the user straight at the
            // Authentication panel instead of a dead-end error toast.
            this._notification.notify({
              severity: Severity.Warning,
              message: localize(
                'acp.session.authRequired',
                'This agent needs authentication before it can start.',
              ),
              actions: [
                {
                  label: localize('acp.session.openAuth', 'Open Agent Settings'),
                  run: () => {
                    void this._commands.executeCommand('workbench.action.agent.openSettings')
                  },
                },
              ],
            })
          } else {
            this._notification.notify({
              severity: Severity.Error,
              message: `Failed to start agent session: ${msg}`,
            })
          }
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

  async resumeSession(sessionId: string): Promise<IAcpSession> {
    // Concurrent callers (e.g. AcpSessionEditor's useEffect + a sidebar click
    // landing in the same frame) must dedupe — otherwise both race past the
    // existing-session check and we spawn two agent subprocesses, the second
    // of which overwrites the first in _sessions and corrupts the routing
    // map. The in-flight promise is settled before being removed.
    const inflight = this._resumingBySessionId.get(sessionId)
    if (inflight) return inflight
    const existing = this._sessions.find((s) => s.id === sessionId)
    if (existing && existing.status.get() !== 'closed') {
      this.setActive(existing.id)
      return existing
    }
    const promise = this._resumeSessionInner(sessionId).finally(() => {
      this._resumingBySessionId.delete(sessionId)
    })
    this._resumingBySessionId.set(sessionId, promise)
    return promise
  }

  private async _resumeSessionInner(sessionId: string): Promise<IAcpSession> {
    // History hydration is fire-and-forget at bootstrap; on editor restart the
    // restored AcpSessionEditorInput triggers an auto-resume via useEffect that
    // races with the load. Wait for hydration so a transient empty-state
    // lookup doesn't masquerade as a genuine "unknown id".
    try {
      await this._history.initialize()
    } catch {
      // best-effort — proceed and let the lookup decide
    }
    const entry = this._history.get(sessionId)
    if (!entry) {
      throw new Error(`Unknown agent session id: ${sessionId}`)
    }
    const cwd = entry.cwd
    let conn: IAcpClientConnection
    try {
      conn = await this._client.connect(entry.agentId, {
        ...(cwd !== undefined ? { cwd } : {}),
        leaseFor: entry.sessionIdOnAgent,
      })
    } catch (err) {
      // connect() now bounds the spawn+initialize handshake, so a stall surfaces
      // here as a rejection instead of an infinite "Resuming agent session…"
      // spinner. _onResumeFailure decides whether to surface this (real session)
      // or discard it silently (empty session the agent never persisted);
      // resumeSession's `finally` then clears the in-flight dedup entry so the
      // poisoned promise can no longer make every later Retry/switch a no-op.
      this._onResumeFailure(entry, err)
    }
    const timeoutMs = this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
    const mcpServers = this._readMcpServers()
    let session: AcpSession | undefined
    let registered = false
    try {
      const initResult = await withTimeout(conn.initializeResult, timeoutMs, 'ACP initialize')
      if (initResult.agentCapabilities?.loadSession !== true) {
        throw new Error('Agent does not advertise agentCapabilities.loadSession — cannot resume')
      }
      const title = entry.title
      // Construct the AcpSession BEFORE session/load so any session/update
      // notifications the agent emits during replay route to the right
      // session via this._sessions lookup.
      session = new AcpSession(
        entry.sessionIdOnAgent,
        entry.agentId,
        title,
        conn,
        this._telemetry,
        {
          ...(entry.usage ? { usage: entry.usage } : {}),
          ...(entry.accumulatedRunningMs
            ? { accumulatedRunningMs: entry.accumulatedRunningMs }
            : {}),
        },
        entry.collapseMode ?? 'default',
        this._history,
        this._agentDefaults,
        this._changeTracker,
        // No title service on resume: restored sessions already carry a durable
        // title, so we must not regenerate (and overwrite) it on the next turn.
      )
      this._register(session)
      this._wireAuthGuidance(session)
      const captured = session
      const prior = this._sessions.find((s) => s.id === captured.id)
      transaction((tx) => {
        this._sessions = [...this._sessions.filter((s) => s.id !== captured.id), captured]
        this.sessions.set(this._sessions, tx)
        this.activeSessionId.set(captured.id, tx)
        this.activeSession.set(captured, tx)
      })
      registered = true
      prior?.dispose()

      const { kept, dropped } = filterMcpServersByCapabilities(
        mcpServers,
        initResult.agentCapabilities?.mcpCapabilities,
      )
      this._warnDroppedMcpServers(this._registry.get(entry.agentId).name, dropped)
      const mcpSeed = kept.map((s) => ({ name: s.name, transport: mcpServerTransport(s) }))
      if (mcpSeed.length > 0) session.applyInitState({ mcpServers: mcpSeed })
      const loadParams: LoadSessionRequest = {
        sessionId: entry.sessionIdOnAgent,
        cwd: cwd ?? '',
        mcpServers: kept,
        _meta: EMIT_INIT_SDK_MESSAGE_META,
      }
      const loadResult = await withTimeout(
        conn.conn.loadSession(loadParams),
        timeoutMs,
        'ACP session/load',
      )
      if (loadResult?.configOptions) {
        session.applyInitState({ configOptions: loadResult.configOptions })
      }
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
        this._sessions = this._sessions.filter((x) => x.id !== captured.id)
        this.sessions.set(this._sessions, undefined)
        if (this.activeSession.get() === captured) {
          const next = this._sessions[0]
          this.activeSessionId.set(next?.id, undefined)
          this.activeSession.set(next, undefined)
        }
        captured.dispose()
      } else {
        conn.dispose()
      }
      this._onResumeFailure(entry, err)
    }
  }

  /**
   * Subscribe to a session's `onDidRequireAuth` and surface a single actionable
   * notification routing the user to the Authentication settings. The agent only
   * raises authRequired once the first prompt is sent (session creation itself
   * succeeds), so this is the path that catches an unconfigured agent in practice.
   * A short cooldown collapses bursts (concurrent prompts) into one toast.
   */
  private _wireAuthGuidance(session: IAcpSession): void {
    let lastShownAt = 0
    this._register(
      session.onDidRequireAuth(() => {
        const now = Date.now()
        if (now - lastShownAt < AUTH_NOTIFICATION_COOLDOWN_MS) return
        lastShownAt = now
        this._notification.notify({
          severity: Severity.Warning,
          message: localize(
            'acp.session.authRequired',
            'This agent needs authentication before it can respond.',
          ),
          actions: [
            {
              label: localize('acp.session.openAuth', 'Open Agent Settings'),
              run: () => {
                void this._commands.executeCommand('workbench.action.agent.openSettings')
              },
            },
          ],
        })
      }),
    )
  }

  /**
   * Centralised resume-failure policy. An empty session (created but never
   * messaged) cannot be revived after a restart — the agent never persisted it —
   * so we discard it silently: drop the history row (it leaves the session list)
   * and let the restored editor tab close itself, with NO error notification.
   * Any session that has messages (or predates the `hasMessages` flag) surfaces
   * the failure to the user as before. Always rethrows so callers see the error.
   */
  private _onResumeFailure(entry: AcpSessionHistoryEntry, err: unknown): never {
    const msg = (err as Error).message
    if (entry.hasMessages === false) {
      this._logger.info(`discarding empty session that failed to resume: ${entry.id}`)
      this._history.remove(entry.id)
    } else {
      this._logger.warn(`resumeSession failed: ${msg}`)
      this._notification.notify({
        severity: Severity.Error,
        message: `Failed to resume agent session: ${msg}`,
      })
      this._telemetry.publicLogError('acp.session_resume_failed', {
        agentId: entry.agentId,
        error: msg,
      })
    }
    throw err
  }

  async closeSession(sessionId: string): Promise<void> {
    const idx = this._sessions.findIndex((x) => x.id === sessionId)
    if (idx === -1) return
    const session = this._sessions[idx]!
    await session.close()
    this._sessions = this._sessions.filter((x) => x.id !== sessionId)
    this.sessions.set(this._sessions, undefined)
    AcpChatViewStateCache.clear(sessionId)
    AcpPromptDraftCache.clear(sessionId)
    AcpQuestionDraftCache.clearSession(sessionId)
    if (this.activeSessionId.get() === sessionId) {
      const next = this._sessions[0]
      this.activeSessionId.set(next?.id, undefined)
      this.activeSession.set(next, undefined)
    }
    this._telemetry.publicLog('acp.session_closed', { sessionId })
    this._onDidCloseSession.fire(sessionId)
  }

  getById(sessionId: string): IAcpSession | undefined {
    return this._sessions.find((x) => x.id === sessionId)
  }

  deleteOnAgent(sessionId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
    return this._coordinator.deleteOnAgent(sessionId)
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
    const session = this._sessions.find((s) => s.id === params.sessionId)
    if (!session) return
    session.applyUpdate(params.update)
  }

  onExtNotification(method: string, params: Record<string, unknown>): void {
    if (method !== SDK_MESSAGE_EXT_METHOD) return
    const sessionId = params['sessionId']
    const message = params['message']
    if (typeof sessionId !== 'string' || message == null || typeof message !== 'object') return
    const m = message as { type?: unknown; subtype?: unknown; mcp_servers?: unknown }
    if (m.type !== 'system' || m.subtype !== 'init' || !Array.isArray(m.mcp_servers)) return
    const session = this._sessions.find((s) => s.id === sessionId)
    if (!session) return
    const servers = m.mcp_servers
      .filter((s): s is { name: string; status: string } => {
        if (s == null || typeof s !== 'object') return false
        const o = s as { name?: unknown; status?: unknown }
        return typeof o.name === 'string' && typeof o.status === 'string'
      })
      .map((s) => ({ name: s.name, status: s.status }))
    session.applyMcpServerSnapshot(servers)
  }

  async onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const auto = this._permission.tryAutoApprove(params)
    if (auto) {
      this._telemetry.publicLog('acp.permission_auto_approved', {
        kind: params.toolCall.kind ?? 'unknown',
      })
      return auto
    }
    const session = this._sessions.find((s) => s.id === params.sessionId)
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

  async onAskUserQuestion(params: AskUserQuestionRequest): Promise<AskUserQuestionResult> {
    const session = this._sessions.find((s) => s.id === params.sessionId)
    if (!session) {
      this._logger.warn(`ask_user_question for unknown session ${params.sessionId}`)
      return { cancelled: true }
    }
    this._telemetry.publicLog('acp.ask_user_question', {
      sessionId: params.sessionId,
      count: params.questions.length,
    })
    return await new Promise<AskUserQuestionResult>((resolve) => {
      const settle = (result: AskUserQuestionResult): void => {
        if (session.pendingQuestion.get() === pending) {
          session.pendingQuestion.set(undefined, undefined)
        }
        resolve(result)
      }
      const pending: AcpPendingQuestion = {
        toolCallId: params.toolCallId,
        questions: params.questions,
        resolve: (result) => {
          this._telemetry.publicLog('acp.ask_user_question_resolved', {
            answered: Object.keys(result.answers ?? {}).length,
          })
          settle(result)
        },
        cancel: () => {
          this._telemetry.publicLog('acp.ask_user_question_cancelled', {})
          settle({ cancelled: true })
        },
      }
      session.presentQuestion(pending)
    })
  }

  private _readMcpServers(): McpServer[] {
    return normalizeMcpServers(this._config.get<unknown>('acp.mcpServers'), (m) =>
      this._logger.warn(`mcpServers: ${m}`),
    )
  }

  private _warnDroppedMcpServers(
    agentName: string,
    dropped: ReadonlyArray<{ name: string; transport: 'http' | 'sse' }>,
  ): void {
    if (dropped.length === 0) return
    for (const d of dropped) {
      this._logger.warn(
        `mcpServers: "${d.name}" uses ${d.transport} transport which ${agentName} does not support, skipped`,
      )
    }
    const names = dropped.map((d) => `"${d.name}"`).join(', ')
    this._notification.notify({
      severity: Severity.Warning,
      message: `${agentName} does not support the configured MCP transport for ${names}; these servers were skipped.`,
    })
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
