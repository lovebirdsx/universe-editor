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
  generateUuid,
  ICommandService,
  IConfigurationService,
  ILoggerService,
  INotificationService,
  IStorageService,
  ITelemetryService,
  IUriIdentityService,
  IWorkspaceService,
  Severity,
  StorageScope,
  localize,
  type ILogger,
  type IObservable,
  type Event,
} from '@universe-editor/platform'
import {
  type LoadSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
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
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type SessionHistoryScope,
} from './acpSessionHistory.js'
import { IAcpSessionTitleService } from './acpSessionTitleService.js'
import { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import { IAcpConfigOptionsCacheService } from './acpConfigOptionsCache.js'
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
import { AcpSessionRegistry } from './acpSessionRegistry.js'
import type { PromptMention } from './promptMentions.js'
import type { SelectionContext } from './promptContext.js'
import type { PromptImage } from './promptImage.js'

export type { PromptMention, SelectionContext, PromptImage }
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
import { AcpForeignWorktreeError } from './acpErrors.js'
import { snapshotConfigSelections } from './configOptionLabel.js'

/**
 * Re-exported from ./acpErrors.js (the consolidated ACP error family) so the
 * historical `acpSessionService` import path keeps working — the UI's
 * cross-worktree activation flow catches this by type.
 */
export { AcpForeignWorktreeError }

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
  /**
   * Resume a session that belongs to a DIFFERENT worktree as a read-only
   * preview: spawns the agent against the session's own cwd and replays the
   * conversation via `session/load` so its history can be viewed, but the
   * resulting session is flagged `readOnly` (no prompt / config mutation) and is
   * NOT made the active session — it must not displace the current worktree's
   * working session. The split-brain guard is intentionally bypassed because a
   * read-only replay has no side effects on the foreign worktree.
   */
  resumeSessionReadOnly(sessionId: string): Promise<IAcpSession>
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

/** Configuration key controlling which sessions the history list surfaces. */
const HISTORY_SCOPE_KEY = 'acp.sessions.historyScope'

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

  private readonly _sessionStore = new AcpSessionRegistry()
  readonly sessions: IObservable<readonly IAcpSession[]> = this._sessionStore.sessions
  readonly activeSessionId: IObservable<string | undefined> = this._sessionStore.activeSessionId
  readonly activeSession: IObservable<IAcpSession | undefined> = this._sessionStore.activeSession

  private readonly _onDidCreate = this._register(new Emitter<IAcpSession>())
  readonly onDidCreate = this._onDidCreate.event

  private readonly _onDidCloseSession = this._register(new Emitter<string>())
  readonly onDidCloseSession = this._onDidCloseSession.event

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
    @ILoggerService loggerService: ILoggerService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IStorageService private readonly _storage: IStorageService,
    @IAcpAgentDefaultsService private readonly _agentDefaults: IAcpAgentDefaultsService,
    @IAcpConfigOptionsCacheService
    private readonly _configOptionsCache: IAcpConfigOptionsCacheService,
    @ISessionChangeTrackerService private readonly _changeTracker: ISessionChangeTrackerService,
    @IAcpSessionTitleService private readonly _titleService: IAcpSessionTitleService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSession', name: 'ACP Session' })
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
        this._uriIdentity,
        {
          resumeSession: (sessionId) => this.resumeSession(sessionId),
          hasActiveSession: () => this.activeSessionId.get() !== undefined,
          getCurrentCwd: () => this._workspace.current?.folder.fsPath,
          whenWorkspaceReady: () => this._workspace.whenReady,
          getLiveSessionIds: () => this._sessionStore.liveIds(),
          getHistoryScope: () => this._historyScope(),
        },
      ),
    )
    this._coordinator.start()

    // Persist the active session's agent-issued id so we can restore it on the
    // next editor launch. We persist the durable `sessionIdOnAgent`, not the
    // local id — a freshly created session has no agent id until its connection
    // attaches, so the write is deferred until then (the autorun re-fires when
    // sessionIdOnAgent flips from undefined). A session with no agent id yet
    // leaves the stored pointer untouched rather than clobbering it.
    this._register(
      autorun((r) => {
        const session = this.activeSession.read(r)
        const sessionId = session?.sessionIdOnAgent.read(r)
        if (this._suspendActivePersist) return
        if (sessionId) {
          void this._storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, sessionId, StorageScope.WORKSPACE)
        } else if (session === undefined) {
          void this._storage.remove(ACP_ACTIVE_SESSION_STORAGE_KEY, StorageScope.WORKSPACE)
        }
      }),
    )
    // Workspace swap: close all live sessions and re-read the active-session
    // pointer from the new bucket.
    this._register(this._storage.onDidChangeWorkspaceScope(() => void this._onWorkspaceSwap()))
    // History scope changed: re-run a replace-mode sweep so the list re-converges
    // (narrowing prunes worktree/cross-project rows; widening pulls them back).
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(HISTORY_SCOPE_KEY)) {
          void this.refreshSessions().catch(() => {
            // refresh failures are non-fatal and already logged by the coordinator.
          })
        }
      }),
    )
  }

  private _historyScope(): SessionHistoryScope {
    const raw = this._config.get<string>(HISTORY_SCOPE_KEY)
    return raw === 'worktree' || raw === 'all' || raw === 'workspace' ? raw : 'worktree'
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
    const oldSessions = this._sessionStore.clear()
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
    const cwd = this._workspace.current?.folder.fsPath
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    const title = `${agentName} ${hh}:${mm}`

    // Build + publish the session synchronously with a stable local id so the
    // chat UI renders (and accepts input) immediately. The agent process spawn +
    // ACP handshake + session/new run in the background; the user's prompts are
    // queued by AcpSession until attachConnection lands. This is what makes "new
    // session" feel instant instead of blocking for 1-5s on the handshake.
    const session = new AcpSession(
      generateUuid(),
      resolvedAgentId,
      title,
      this._telemetry,
      undefined,
      initialCollapseMode,
      this._history,
      this._agentDefaults,
      this._changeTracker,
      this._titleService,
    )
    this._register(session)
    this._wireAuthGuidance(session)
    this._wireConfigOptionsCache(session)
    // Optimistic config bar: seed the last-known option bag for this agent
    // (currentValue overridden by the user's saved per-agent defaults) so the
    // config switches render the instant the session appears, instead of
    // popping in 1-5s later when session/new returns the real bag. The real bag
    // replaces this once the handshake lands (see _connectSession).
    const seededOptions = this._seedConfigOptions(resolvedAgentId)
    if (seededOptions.length > 0) {
      session.setConfigDesired(this._agentDefaults.getDefaults(resolvedAgentId))
      session.seedConfigOptions(seededOptions)
    }
    this._sessionStore.add(session, { activate: true })
    this._telemetry.publicLog('acp.session_created', { agentId: resolvedAgentId })
    this._onDidCreate.fire(session)

    void this._connectSession(session, resolvedAgentId, cwd)
    return session
  }

  /**
   * Background connect for a freshly created session: spawn + initialize +
   * session/new, then hand the live connection to the session via
   * `attachConnection` (which flushes any queued prompts) and register it in
   * durable history. On failure the session is sealed via `failConnection` and
   * the user is guided to fix auth / sees the error — the session row stays in
   * the list so the failure is visible instead of vanishing.
   */
  private async _connectSession(
    session: AcpSession,
    resolvedAgentId: string,
    cwd: string | undefined,
  ): Promise<void> {
    const agentName = this._registry.get(resolvedAgentId).name
    const timeoutMs = this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
    const mcpServers = this._readMcpServers()
    let conn: IAcpClientConnection | undefined
    try {
      conn = await this._client.connect(resolvedAgentId, cwd !== undefined ? { cwd } : {})
      const activeConn = conn
      const initResult = await withTimeout(activeConn.initializeResult, timeoutMs, 'ACP initialize')
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
        activeConn.conn.newSession(newParams),
        timeoutMs,
        'ACP session/new',
      )
      // The session may have been closed by the user while connecting.
      if (session.status.get() === 'closed') {
        activeConn.dispose()
        return
      }
      activeConn.attachSession(result.sessionId)
      const mcpSeed = kept.map((s) => ({ name: s.name, transport: mcpServerTransport(s) }))
      const initState: IAcpSessionInitState = {
        ...(result.configOptions ? { configOptions: result.configOptions } : {}),
        ...(mcpSeed.length > 0 ? { mcpServers: mcpSeed } : {}),
      }
      // Record the session in persistent history now that we have the agent id.
      this._history.add({
        agentId: resolvedAgentId,
        sessionIdOnAgent: result.sessionId,
        title: session.title,
        ...(cwd !== undefined ? { cwd } : {}),
        hasMessages: false,
      })
      // Seed the saved per-agent defaults BEFORE applying the bag so the state
      // machine reconciles it flicker-free (server default → saved value, with
      // no intermediate frame) and queues the real RPC for the agent to adopt.
      session.setConfigDesired(this._agentDefaults.getDefaults(resolvedAgentId))
      session.applyInitState(initState)
      // Snapshot the (reconciled) configOption selections into history so the
      // sidebar can show model / effort on this row even after it stops being
      // live — including the default selection the user never touched.
      this._snapshotConfigToHistory(result.sessionId, session.configOptions.get())
      if (result.configOptions) {
        this._configOptionsCache.set(resolvedAgentId, result.configOptions)
      }
      session.attachConnection(activeConn, result.sessionId)
    } catch (err) {
      if (conn) conn.dispose()
      const msg = (err as Error).message
      this._logger.warn(`createSession failed: ${msg}`)
      session.failConnection(msg)
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
    }
  }

  /**
   * Mirror the current configOption selections (value + friendly label) onto the
   * durable history row so the sidebar can show model / effort after the session
   * stops being live. Snapshots the default selection too — the per-option
   * `setHistoryConfigOption` only fires on a *user-driven* change, so without
   * this a never-touched session would persist no model/effort at all.
   */
  private _snapshotConfigToHistory(
    sessionIdOnAgent: string,
    options: readonly SessionConfigOption[],
  ): void {
    const { values, labels } = snapshotConfigSelections(options)
    for (const [configId, value] of Object.entries(values)) {
      this._history.setHistoryConfigOption(sessionIdOnAgent, configId, value, labels[configId])
    }
  }

  /**
   * Find a live session by either its stable local id or its agent-issued
   * sessionId. Callers may hold either: the local id is used by freshly-created
   * sessions / editor inputs opened in this run, while the agent id is what
   * history rows, persisted editor inputs, and protocol notifications carry.
   */
  private _findSession(sessionId: string): AcpSession | undefined {
    return this._sessionStore.find(sessionId)
  }

  setActive(sessionId: string): void {
    this._sessionStore.setActive(sessionId)
  }

  async resumeSession(sessionId: string): Promise<IAcpSession> {
    // Concurrent callers (e.g. AcpSessionEditor's useEffect + a sidebar click
    // landing in the same frame) must dedupe — otherwise both race past the
    // existing-session check and we spawn two agent subprocesses, the second
    // of which overwrites the first in _sessions and corrupts the routing
    // map. The in-flight promise is settled before being removed.
    const inflight = this._resumingBySessionId.get(sessionId)
    if (inflight) return inflight
    const existing = this._findSession(sessionId)
    if (existing && existing.status.get() !== 'closed') {
      this.setActive(existing.id)
      return existing
    }
    const promise = this._resumeSessionInner(sessionId, { readOnly: false }).finally(() => {
      this._resumingBySessionId.delete(sessionId)
    })
    this._resumingBySessionId.set(sessionId, promise)
    return promise
  }

  async resumeSessionReadOnly(sessionId: string): Promise<IAcpSession> {
    // Dedupe with the same in-flight map as resumeSession: a read-only preview
    // and a (hypothetical) live resume for the same id must never both spawn.
    const inflight = this._resumingBySessionId.get(sessionId)
    if (inflight) return inflight
    const existing = this._findSession(sessionId)
    if (existing && existing.status.get() !== 'closed') {
      // Already live (read-only or not): reuse it. Do NOT setActive — a foreign
      // preview must not steal the current worktree's active session.
      return existing
    }
    const promise = this._resumeSessionInner(sessionId, { readOnly: true }).finally(() => {
      this._resumingBySessionId.delete(sessionId)
    })
    this._resumingBySessionId.set(sessionId, promise)
    return promise
  }

  private async _resumeSessionInner(
    sessionId: string,
    options: { readOnly: boolean },
  ): Promise<IAcpSession> {
    const { readOnly } = options
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
    // Split-brain guard: a session carries the cwd it was created in. Resuming it
    // here would spawn the agent against that cwd while this window's views stay
    // on the open folder. If the session belongs to a different worktree, refuse
    // to spawn — the UI routes the user through cross-worktree activation. cwd
    // undefined (legacy/global) is treated as "belongs here" to stay compatible.
    // Skipped for read-only previews: a `session/load` replay has no side effects
    // on the foreign worktree, so viewing its history across the boundary is safe.
    const currentCwd = this._workspace.current?.folder.fsPath
    if (
      !readOnly &&
      entry.cwd !== undefined &&
      currentCwd !== undefined &&
      !this._uriIdentity.arePathsEqual(entry.cwd, currentCwd)
    ) {
      this._logger.info(
        `[acp] refusing cross-worktree resume of ${sessionId}: session cwd=${entry.cwd} current=${currentCwd}`,
      )
      throw new AcpForeignWorktreeError(sessionId, entry.cwd, currentCwd)
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
      this._onResumeFailure(entry, err, readOnly)
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
      // session. Resumed sessions are keyed by the agent-issued id (id ===
      // sessionIdOnAgent) — they are durable and already known. attachConnection
      // (below) sets sessionIdOnAgent so routing works during the load replay.
      session = new AcpSession(
        entry.sessionIdOnAgent,
        entry.agentId,
        title,
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
        undefined,
        readOnly,
      )
      session.attachConnection(conn, entry.sessionIdOnAgent)
      this._register(session)
      this._wireAuthGuidance(session)
      this._wireConfigOptionsCache(session)
      const captured = session
      // Read-only foreign previews register so getById/timeline work, but must
      // not become the active session — that belongs to the current worktree.
      const prior = this._sessionStore.replace(captured, { activate: !readOnly })
      registered = true
      prior?.dispose()

      // The session is now registered, so getById hits and the editor swaps the
      // "Resuming…" placeholder for ChatBody — but the timeline is still empty
      // until session/load replays it below. Mark the replay so ChatBody keeps
      // showing a loading placeholder instead of flashing the empty-session hint.
      session.beginHistoryReplay()

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
      // Replay finished: timeline is now populated, so ChatBody can render the
      // history (or the genuine empty-session hint if this session truly has none).
      session.endHistoryReplay()
      // Per-session history wins over per-agent defaults: a user who picked
      // distinct values for a specific session expects them on resume even if
      // the global default has since changed. Seed BEFORE applying the bag so
      // the state machine reconciles it flicker-free; the connection is already
      // attached here, so applyInitState flushes the resulting RPCs immediately.
      session.setConfigDesired({
        ...this._agentDefaults.getDefaults(entry.agentId),
        ...(entry.configOptions ?? {}),
      })
      if (loadResult?.configOptions) {
        session.applyInitState({ configOptions: loadResult.configOptions })
        this._snapshotConfigToHistory(entry.sessionIdOnAgent, session.configOptions.get())
        this._configOptionsCache.set(entry.agentId, loadResult.configOptions)
      }
      this._telemetry.publicLog('acp.session_resumed', {
        agentId: entry.agentId,
      })
      this._onDidCreate.fire(session)
      return session
    } catch (err) {
      if (registered && session) {
        const captured = session
        // Rollback: drop the partial session before bubbling the error.
        this._sessionStore.remove(captured.id)
        captured.dispose()
      } else {
        conn.dispose()
      }
      this._onResumeFailure(entry, err, readOnly)
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
                void this._commands.executeCommand(
                  'workbench.action.agent.openSettings',
                  session.agentId,
                )
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
  private _onResumeFailure(entry: AcpSessionHistoryEntry, err: unknown, readOnly = false): never {
    const msg = (err as Error).message
    if (readOnly) {
      // Read-only preview failures (e.g. agent without loadSession) are not
      // user errors: the UI falls back to the metadata-only preview. Log only.
      this._logger.info(`read-only resume failed for ${entry.id}: ${msg}`)
    } else if (entry.hasMessages === false) {
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
    const session = this._findSession(sessionId)
    if (!session) return
    const localId = session.id
    await session.close()
    this._sessionStore.remove(localId)
    AcpChatViewStateCache.clear(localId)
    AcpPromptDraftCache.clear(localId)
    AcpQuestionDraftCache.clearSession(localId)
    this._telemetry.publicLog('acp.session_closed', { sessionId: localId })
    this._onDidCloseSession.fire(localId)
  }

  getById(sessionId: string): IAcpSession | undefined {
    return this._findSession(sessionId)
  }

  deleteOnAgent(sessionId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
    return this._coordinator.deleteOnAgent(sessionId)
  }

  /**
   * Build the optimistic `configOptions` bag for a brand-new session of `agentId`
   * from the persisted cache, overriding each option's `currentValue` with the
   * user's saved per-agent default so the placeholder shows exactly the value the
   * session will end up with (avoiding a server-default → user-value flicker).
   * Returns an empty array when nothing is cached (cold start / first session).
   */
  private _seedConfigOptions(agentId: string): readonly SessionConfigOption[] {
    const cached = this._configOptionsCache.get(agentId)
    if (cached.length === 0) return cached
    return overrideConfigOptionValues(cached, this._agentDefaults.getDefaults(agentId)).bag
  }

  /**
   * Persist the session's full `configOptions` bag into the per-agent cache as
   * it evolves. Unlike the one-shot write after `session/new`/`session/load`,
   * this stays subscribed so options the agent advertises *later* via
   * `config_option_update` (e.g. `thought_level`, which only appears once init
   * finishes) also land in the cache. Without this the optimistic config bar on
   * the next new session would be missing those late-arriving switches.
   *
   * Gated on `sessionIdOnAgent` so we never cache the optimistic placeholder bag
   * (which carries locally-overridden currentValues) before the real handshake.
   */
  private _wireConfigOptionsCache(session: AcpSession): void {
    this._register(
      autorun((r) => {
        if (session.sessionIdOnAgent.read(r) === undefined) return
        const bag = session.configOptions.read(r)
        if (bag.length === 0) return
        this._configOptionsCache.set(session.agentId, bag)
      }),
    )
  }

  // -- IAcpClientNotificationSink ---------------------------------------

  onSessionUpdate(params: SessionNotification): void {
    const session = this._findSession(params.sessionId)
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
    const session = this._findSession(sessionId)
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
    const session = this._findSession(params.sessionId)
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
    const session = this._findSession(params.sessionId)
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

/**
 * Override each select option's `currentValue` with the user's saved value
 * (`desired[optionId]`) when one exists, differs, and is offered by the option.
 * Used both to build the optimistic seed bag AND to pre-reconcile the
 * authoritative `session/new` / `session/load` bag before it lands in the
 * observable — so the server default for an option the user has a saved
 * preference for never flashes on screen.
 *
 * Returns the (possibly new) bag plus the ids that were actually overridden.
 * Those ids identify options whose *server* value differs from the user's
 * choice and therefore still need a real `setConfigOption` RPC to the agent —
 * the visual override alone does not change anything agent-side.
 */
function overrideConfigOptionValues(
  bag: readonly SessionConfigOption[],
  desired: Readonly<Record<string, string>>,
): { bag: readonly SessionConfigOption[]; overridden: readonly string[] } {
  if (bag.length === 0 || Object.keys(desired).length === 0) return { bag, overridden: [] }
  const overridden: string[] = []
  const next = bag.map((opt) => {
    if (opt.type !== 'select') return opt
    const want = desired[opt.id]
    if (want === undefined || want === opt.currentValue) return opt
    // Only override to a value the option actually offers; otherwise leave the
    // server value so the bar never shows an unselectable entry.
    if (!selectOptionHasValue(opt, want)) return opt
    overridden.push(opt.id)
    return { ...opt, currentValue: want }
  })
  return overridden.length > 0 ? { bag: next, overridden } : { bag, overridden: [] }
}

function selectOptionHasValue(
  opt: SessionConfigOption & { type: 'select' },
  value: string,
): boolean {
  for (const o of opt.options) {
    if ('group' in o) {
      for (const v of o.options) if (v.value === value) return true
    } else if (o.value === value) {
      return true
    }
  }
  return false
}
