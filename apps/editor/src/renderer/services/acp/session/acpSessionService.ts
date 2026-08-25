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
  ConfigurationTarget,
  Disposable,
  Emitter,
  generateUuid,
  IConfigurationService,
  IFileService,
  ILoggerService,
  INotificationService,
  IStorageService,
  ITelemetryService,
  IUriIdentityService,
  IWindowsService,
  IWorkspaceService,
  REMOTE_SCHEME,
  Severity,
  StorageScope,
  localize,
  observableValue,
  URI,
  type ILogger,
  type IObservable,
  type ISettableObservable,
  type Event,
} from '@universe-editor/platform'
import {
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
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
  filterWireByNames,
  mcpServerTransport,
  mergeMcpServerDefinitions,
  mergeMcpServerRawLayers,
  mergeWireMcpServers,
  normalizeMcpServers,
  parseMcpJson,
  readMcpServerDefinitions,
  readMcpServerDefinitionsLayered,
  resolveMcpServerSelection,
  type McpServerDefinition,
  type McpServerRawLayer,
} from '../acpMcpServers.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../acpClientService.js'
import { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import { IEnvironmentSnapshotService } from '../../../../shared/ipc/environmentSnapshotService.js'
import {
  AcpSessionCreateProfiler,
  formatSessionCreateProfile,
  type ISessionCreateProfileHandle,
  type SessionCreateProfile,
} from '../acpSessionCreateProfiler.js'
import { ACP_EXT_METHODS, ACP_META_KEYS } from './acpExtMethods.js'
import { isAuthRequiredError } from './acpAuthError.js'
import { IAcpPermissionHandler } from '../acpPermissionHandler.js'
import { IAcpAuthGuidanceService } from './acpAuthGuidanceService.js'
import { IAcpSessionFactory } from './acpSessionFactory.js'
import { IAcpModelCandidateService } from '../acpModelCandidateService.js'
import { contextWindowFor, type AcpModelCandidate } from '../acpModelCandidates.js'
import {
  effectiveEntryAuthority,
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type SessionHistoryScope,
} from './acpSessionHistory.js'
import { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import { IAcpConfigOptionsCacheService } from './acpConfigOptionsCache.js'
import { AcpChatViewStateCache } from './acpChatViewStateCache.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import { AcpPromptDraftCache } from './acpPromptDraftCache.js'
import type { AcpPromptDraft } from './acpPromptDraftCache.js'
import { AcpElicitationDraftCache } from './acpElicitationDraftCache.js'
import {
  AcpSession,
  BACKGROUND_ACTIVITY_METHOD,
  COMPACTION_METHOD,
  LIVENESS_PING_METHOD,
  MCP_SERVER_STATUS_METHOD,
  PLAN_AUTO_EXECUTE_DELAY_MS,
  RESURRECTION_METHOD,
  type AcpConnectionLostEvent,
  type AcpPendingElicitation,
  type AcpPendingPermission,
  type AcpUrlElicitationState,
  type IAcpSession,
  type IAcpSessionInitState,
  type RewindFilesResult,
} from './acpSession.js'
import { isResidentLive } from './acpSessionStatus.js'
import { MAX_RECOVERY_ATTEMPTS, recoveryBackoffMs } from './acpSessionRecovery.js'
import {
  ACP_ACTIVE_SESSION_STORAGE_KEY,
  AcpSessionRestoreCoordinator,
} from './acpSessionRestoreCoordinator.js'
import { AcpSessionRegistry } from './acpSessionRegistry.js'
import type { SelectionContext } from '../promptContext.js'
import type { PromptImage } from '../promptImage.js'

export type { SelectionContext, PromptImage }
export {
  AcpAbortError,
  type AcpMessage,
  type AcpMessageRole,
  type AcpToolCall,
  type AcpToolCallDiff,
  type AcpToolCallLocation,
  type AcpToolCallStatus,
  type AcpChildItem,
  type AcpPlanEntry,
  type AcpPlanEntryStatus,
  type AcpPendingPermission,
  type AcpPendingElicitation,
  type AcpUrlElicitationState,
  type AcpRecoveryState,
  type AcpSessionStatus,
  type AcpSubagentStats,
  type AcpUsage,
  type IAcpSession,
  type IAcpSessionInitState,
  type RewindFilesResult,
  type TimelineItem,
} from './acpSession.js'
import { AcpForeignWorktreeError } from './acpErrors.js'
import { shouldPauseAcpAutoResume } from './acpAutoResumeGuard.js'
import { selectOptionHasValue, snapshotConfigSelections } from '../configOptionLabel.js'
import { IExtensionMcpServersService } from '../../extensions/extensionMcpServersService.js'
import { IMcpServerEnablementService } from '../mcpServerEnablementService.js'

/**
 * Re-exported from ./acpErrors.js (the consolidated ACP error family) so the
 * historical `acpSessionService` import path keeps working — the UI's
 * cross-worktree activation flow catches this by type.
 */
export { AcpForeignWorktreeError }
export type { McpServerDefinition } from '../acpMcpServers.js'

export interface IAcpCreateSessionOptions {
  /**
   * Session working directory override. Defaults to the current workspace
   * folder. The agent deep link passes its resolved `cwd` here so the session
   * runs in the directory the link named, not merely the window's workspace.
   */
  readonly cwd?: string
  /**
   * The `remote-ssh` authority the session runs on. Defaults to the current
   * workspace folder's authority (undefined for a local workspace). The agent
   * deep link passes this alongside its resolved `cwd` for remote links.
   */
  readonly authority?: string
  /**
   * Title override (defaults to `agentName HH:MM`). Used by the empty-session
   * MCP reload so the replacement session keeps the old title seamlessly; a
   * caller-protected (manual) title must additionally be re-locked via
   * `renameTitle` on the new session.
   */
  readonly title?: string
  /**
   * Per-session MCP server whitelist to pin (`null` = inherit the defaults).
   * Applied synchronously before the background connect so the very first
   * session/new already carries it — used by the empty-session MCP reload,
   * which replaces the session instead of resuming it.
   */
  readonly mcpServerNames?: readonly string[] | null
  /**
   * Unsent prompt draft to seed into AcpPromptDraftCache under the new
   * session's id BEFORE the session is registered/activated — the prompt input
   * reads the cache once at mount, so seeding after activation would be too
   * late. Used by the empty-session MCP reload to carry the user's half-typed
   * input over the transparent session swap.
   */
  readonly promptDraft?: AcpPromptDraft
  /**
   * AI Fix session: config selections never write back to the per-agent
   * defaults (`AcpAgentDefaultsService`), so an AI Fix choice cannot leak into
   * ordinary chat defaults. Per-session history still records them. The flag is
   * persisted on the history entry so a resume rebuilds the same isolation.
   */
  readonly aiFix?: boolean
  /**
   * Desired configOption values layered on top of the per-agent defaults for
   * this session only (`{ ...agentDefaults, ...overrides }`). Must be passed
   * here (not set after creation) because the connect path re-seeds the desired
   * map and would clobber a later override.
   */
  readonly configDesiredOverrides?: Readonly<Record<string, string>>
}

export interface IAcpSessionService {
  readonly _serviceBrand: undefined
  readonly sessions: IObservable<readonly IAcpSession[]>
  readonly activeSessionId: IObservable<string | undefined>
  readonly activeSession: IObservable<IAcpSession | undefined>
  /** Fired after a session is removed from `sessions`. Carries the closed session id. */
  readonly onDidCloseSession: Event<string>
  createSession(agentId?: string, options?: IAcpCreateSessionOptions): Promise<IAcpSession>
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
  /**
   * Resolve the session's transcript file path, history cache first, then a
   * lazy `session/list` roundtrip against the owning agent. Needed because a
   * session created during this window's lifetime only gains `transcriptPath`
   * on the next hydrate sweep — without this the reveal-in-OS action has
   * nothing to open for a running session. A resolved path is written back to
   * history. Returns undefined when no path can be determined.
   */
  resolveTranscriptPath(sessionId: string): Promise<string | undefined>
  /**
   * Manually rename a session by its local or agent-issued id. A live (non
   * read-only) session is renamed through the view-model so the title is pushed
   * to the agent and protected from hydrate; a history-only row is renamed
   * locally with the `manualTitle` guard. Foreign (other-worktree) sessions are
   * rejected — their title in this bucket is only a hydrate cache and would be
   * overwritten by the owning worktree on the next reconcile. Returns `true` if
   * the rename was applied.
   */
  renameSession(sessionId: string, title: string): boolean
  /**
   * Fork a session into a NEW independent session (分叉). The fork contains the
   * conversation up to (and including) `messageId` — an earlier user turn — with
   * everything after it dropped; omit `messageId` to fork from the current tip.
   * The original session is left untouched. Backed by the agent's UNSTABLE
   * `session/fork` (Claude only for now, gated on
   * `sessionCapabilities.fork`): the fork is created resident on the agent, then
   * resumed here via `session/load` so its truncated history replays into a fresh
   * live session that is registered and made active. Rejects if the agent does
   * not advertise fork support. Returns the new session.
   */
  forkSession(sessionId: string, messageId?: string): Promise<IAcpSession>
  /**
   * Fork a LIVE session into a **side task** (侧边任务): a read-only-mode child
   * chat that inherits the parent's full conversation as agent-side context but
   * presents as a fresh, empty chat (the forked baseline replay is suppressed
   * from the timeline). The child row is linked to the parent via
   * `sideTaskOf`/`sideTaskQuote`, hidden from the session list, and surfaced
   * through the parent chat's side-tasks popover instead.
   *
   * Unlike {@link forkSession} the child is NOT made active — the caller opens
   * it in a right-split editor tab. Requires the parent to be live (resident
   * and non-read-only) so its current config / MCP selection can be inherited;
   * the same fork capability gate applies. Returns the new session.
   */
  forkSideTask(
    parentSessionId: string,
    quote: { text: string; label: string },
  ): Promise<IAcpSession>
  /**
   * Rewind a live session to an earlier user message (回退) — delegates to the
   * view-model's {@link IAcpSession.rewindTo}. `dryRun` previews the file impact
   * without mutating anything. `rewindFiles` (default true) rolls back the
   * agent-edited files; pass `false` to keep the working-tree edits and only
   * truncate the conversation. Returns the agent's {@link RewindFilesResult}, or
   * `undefined` when the session isn't live / doesn't support rewind.
   */
  rewindSession(
    sessionId: string,
    messageId: string,
    options?: { dryRun?: boolean; rewindFiles?: boolean },
  ): Promise<RewindFilesResult | undefined>
  /**
   * The MCP definition pool the session picker shows: `acp.mcpServers` merged
   * with the project `.mcp.json` (project wins by name), annotated with
   * transport / disabled / source. Updated on config changes and by
   * {@link refreshMcpServerDefinitions} (the picker calls it on open so a
   * `.mcp.json` edited on disk is picked up without a file watcher).
   */
  readonly mcpServerDefinitions: IObservable<readonly McpServerDefinition[]>
  /** Re-read the pool (global config + project `.mcp.json`). Fire-and-forget safe. */
  refreshMcpServerDefinitions(): Promise<void>
  /**
   * Read + parse the project `.mcp.json` at the workspace root (both the
   * Claude-Code envelope and the bare Record form). Returns `{}` when there is
   * no workspace / no file / broken JSON. Exposed for the MCP settings panel,
   * which renders this file as a read-only group.
   */
  readProjectMcpJson(): Promise<Record<string, unknown>>
  /**
   * Change the session's MCP whitelist (`null` = inherit the defaults).
   * Persists the pin to the history row (once the durable id exists), then
   * converges the live connection: a connected session whose effective server
   * set changed is seamlessly reloaded (`session/load` — the agent keeps the
   * conversation, MCP processes restart with the new list). The pin is
   * session-scoped only — it never changes what new sessions start with.
   * No-op for read-only previews.
   */
  setSessionMcpServers(sessionId: string, names: readonly string[] | null): void
  /**
   * Per-attempt createSession handshake profiles (ring buffer, most recent
   * last). Exposed for diagnostics and the e2e probe — see
   * `AcpSessionCreateProfiler`.
   */
  getSessionCreateProfiles(): readonly SessionCreateProfile[]
}

export const IAcpSessionService = createDecorator<IAcpSessionService>('acpSessionService')

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

/** Watchdog tick for stalled-turn detection. */
const STALL_WATCHDOG_TICK_MS = 60_000

/** Default silence after which a running turn is declared wedged (10 minutes). */
const DEFAULT_STALL_TIMEOUT_MS = 10 * 60_000

/** Default idle time after which an all-idle agent process is stopped (5 minutes). */
const DEFAULT_IDLE_PROCESS_TIMEOUT_MS = 5 * 60_000

/** Configuration key controlling which sessions the history list surfaces. */
const HISTORY_SCOPE_KEY = 'acp.sessions.historyScope'

/** ext-notification method the agent fork uses to forward raw Claude SDK messages. */
const SDK_MESSAGE_EXT_METHOD = ACP_EXT_METHODS.sdkMessage

/**
 * `_meta` passed on session/new + session/load that asks the agent fork to
 * forward only the Claude SDK system-init message (which carries the MCP server
 * connection snapshot) via `extNotification(_claude/sdkMessage)`. Filtering to
 * `init` keeps the rest of the raw SDK stream off the wire.
 */
const EMIT_INIT_SDK_MESSAGE_META = {
  claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'init' }] },
}

/**
 * `_meta` for session/load + session/resume: the init-message filter above,
 * plus the model this session is remembered to run (`history.configOptions.model`).
 * The fork re-asserts it after load — a resume otherwise lands on the
 * transcript's bare API name, dropping the "[1m]" context-lane spelling and
 * clamping the effective window to 200k. See `ACP_META_KEYS.resumeModel`.
 */
function buildResumeMeta(
  entry: AcpSessionHistoryEntry | undefined,
  candidates: readonly AcpModelCandidate[],
): Record<string, unknown> {
  const resumeModel = entry?.configOptions?.['model']
  const extraModels = candidates.map((c) => c.id)
  const contextWindow = contextWindowFor(candidates, resumeModel)
  return {
    claudeCode: {
      ...EMIT_INIT_SDK_MESSAGE_META.claudeCode,
      ...(resumeModel !== undefined ? { resumeModel } : {}),
    },
    // Every load/resume rebuilds the fork's model picker from scratch, so the
    // extra candidates must ride along or gateway models vanish from the
    // dropdown (and set_config_option rejects values outside its options).
    ...(extraModels.length > 0 ? { [ACP_META_KEYS.extraModels]: extraModels } : {}),
    ...(contextWindow !== undefined ? { [ACP_META_KEYS.modelContextWindow]: contextWindow } : {}),
  }
}

/**
 * `_meta` for session/new: the init-message filter plus the extra model
 * candidates the fork appends to its catalogue. `extraModels` is deliberately
 * top-level (not under `claudeCode`) — both forks read it, and appending is
 * their concern, not the native CLI's.
 */
function buildNewSessionMeta(candidates: readonly AcpModelCandidate[]): Record<string, unknown> {
  const extraModels = candidates.map((c) => c.id)
  // A new session names no model — the fork runs whatever its config file picks,
  // which is candidates[0]. Same resolution as resume, just without a name.
  const contextWindow = contextWindowFor(candidates, undefined)
  return {
    ...EMIT_INIT_SDK_MESSAGE_META,
    ...(extraModels.length > 0 ? { [ACP_META_KEYS.extraModels]: extraModels } : {}),
    ...(contextWindow !== undefined ? { [ACP_META_KEYS.modelContextWindow]: contextWindow } : {}),
  }
}

/**
 * `_meta` for session/fork: the model candidates and the resolved window only.
 * Deliberately NOT the resume meta — the claudeCode block there tunes the native
 * CLI's raw-message stream for a load, and fork has never asked for it.
 */
function buildForkMeta(
  entry: AcpSessionHistoryEntry,
  candidates: readonly AcpModelCandidate[],
): Record<string, unknown> {
  const extraModels = candidates.map((c) => c.id)
  const contextWindow = contextWindowFor(candidates, entry.configOptions?.['model'])
  return {
    ...(extraModels.length > 0 ? { [ACP_META_KEYS.extraModels]: extraModels } : {}),
    ...(contextWindow !== undefined ? { [ACP_META_KEYS.modelContextWindow]: contextWindow } : {}),
  }
}

export class AcpSessionService
  extends Disposable
  implements IAcpSessionService, IAcpClientNotificationSink
{
  declare readonly _serviceBrand: undefined

  private readonly _sessionStore = new AcpSessionRegistry()
  readonly sessions: IObservable<readonly IAcpSession[]> = this._sessionStore.sessions
  private readonly _createProfiler = new AcpSessionCreateProfiler()
  readonly activeSessionId: IObservable<string | undefined> = this._sessionStore.activeSessionId
  readonly activeSession: IObservable<IAcpSession | undefined> = this._sessionStore.activeSession

  private readonly _onDidCreate = this._register(new Emitter<IAcpSession>())
  readonly onDidCreate = this._onDidCreate.event

  private readonly _onDidCloseSession = this._register(new Emitter<string>())
  readonly onDidCloseSession = this._onDidCloseSession.event

  /**
   * MCP definition pool mirror (global config + project `.mcp.json`). Seeded
   * synchronously from the global config; the project file joins on the first
   * {@link refreshMcpServerDefinitions} / session creation.
   */
  readonly mcpServerDefinitions: ISettableObservable<readonly McpServerDefinition[]>

  /**
   * The effective MCP whitelist snapshotted when each session's connection
   * attached, keyed by local session id. The drift autorun compares the
   * session's *current* selection against this to decide whether a reload is
   * needed — comparing against the wire seed would false-positive on servers
   * dropped by capability gating.
   */
  private readonly _mcpSelectionAtAttach = new Map<string, readonly string[] | null>()

  /** Session ids (agent-issued) with an MCP reload currently in flight. */
  private readonly _mcpReloadingSessions = new Set<string>()

  /**
   * `agentId\0modelId` pairs already warned about a missing context window, so
   * the notice appears once per model rather than on every reconnect.
   */
  private readonly _missingWindowWarned = new Set<string>()

  /**
   * Consented url-mode elicitations awaiting the agent's `elicitation/complete`,
   * keyed by the request's `elicitationId`. Entries are removed when the card
   * is torn down (decline / cancel / dismiss / session close).
   */
  private readonly _pendingUrlElicitations = new Map<
    string,
    ISettableObservable<AcpUrlElicitationState>
  >()

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

  /**
   * Sessions with a hot-reconnect loop currently running, keyed by local id.
   * Guards against overlapping loops (auto crash event + manual retry).
   */
  private readonly _reconnectingSessions = new Set<string>()

  constructor(
    @IAcpClientService private readonly _client: IAcpClientService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @INotificationService private readonly _notification: INotificationService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @IAcpPermissionHandler private readonly _permission: IAcpPermissionHandler,
    @ILoggerService loggerService: ILoggerService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IStorageService private readonly _storage: IStorageService,
    @IAcpAgentDefaultsService private readonly _agentDefaults: IAcpAgentDefaultsService,
    @IAcpConfigOptionsCacheService
    private readonly _configOptionsCache: IAcpConfigOptionsCacheService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IAcpAuthGuidanceService private readonly _authGuidance: IAcpAuthGuidanceService,
    @IAcpSessionFactory private readonly _sessionFactory: IAcpSessionFactory,
    @IFileService private readonly _fileService: IFileService,
    @IExtensionMcpServersService
    private readonly _extensionMcpServers: IExtensionMcpServersService,
    @IMcpServerEnablementService
    private readonly _mcpEnablement: IMcpServerEnablementService,
    @IWindowsService private readonly _windows: IWindowsService,
    @IEnvironmentSnapshotService
    private readonly _envSnapshot: IEnvironmentSnapshotService,
    @IAcpModelCandidateService
    private readonly _modelCandidates: IAcpModelCandidateService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSession', name: 'ACP Session' })
    // Start the sidecar load early. Prompt dispatch awaits the same idempotent
    // promise before its first save, so pre-existing records cannot be clobbered.
    void this._sessionFactory.messageAttachments.initialize()
    this.mcpServerDefinitions = observableValue<readonly McpServerDefinition[]>(
      'acp.mcpServerDefinitions',
      this._readGlobalMcpDefinitions(),
    )
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
          getCurrentCwd: () => this._currentCwd(),
          getCurrentAuthority: () => this._currentAuthority(),
          whenWorkspaceReady: () => this._workspace.whenReady,
          getLiveSessionIds: () => this._sessionStore.liveIds(),
          getHistoryScope: () => this._historyScope(),
          shouldSkipAutoResume: () => shouldPauseAcpAutoResume(this._windows),
        },
      ),
    )
    this._coordinator.start()
    this._startStallWatchdog()

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
    // Global MCP config edited: keep the definition pool mirror fresh. Inheriting
    // sessions pick the change up on their next (re)connect — we intentionally
    // do NOT reload live sessions for a config edit; only an explicit picker
    // toggle reloads.
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('acp.mcpServers')) {
          void this.refreshMcpServerDefinitions()
        }
      }),
    )
    // Extension-contributed MCP servers changed (install / uninstall / trust /
    // gate setting): refresh the pool mirror. Same live-session semantics as a
    // config edit — next (re)connect picks it up.
    this._register(
      this._extensionMcpServers.onDidChange(() => void this.refreshMcpServerDefinitions()),
    )
    // MCP default-enable overrides changed (storage-backed, user/workspace
    // scope): refresh the pool mirror so the picker's "default" toggles and
    // the next session's wire list reflect the new overrides. Live sessions
    // are NOT reloaded — same semantics as a config edit.
    this._register(this._mcpEnablement.onDidChange(() => void this.refreshMcpServerDefinitions()))
  }

  private _currentCwd(): string | undefined {
    return this._workspace.current?.folder.fsPath
  }

  private _currentAuthority(): string | undefined {
    const folder = this._workspace.current?.folder
    if (!folder || folder.scheme !== REMOTE_SCHEME) return undefined
    return folder.authority || undefined
  }

  private _entryAuthority(entry: AcpSessionHistoryEntry): string | undefined {
    return effectiveEntryAuthority(entry, this._currentCwd(), this._currentAuthority(), (a, b) =>
      this._uriIdentity.arePathsEqual(a, b),
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

  getSessionCreateProfiles(): readonly SessionCreateProfile[] {
    return this._createProfiler.lastProfiles()
  }

  async createSession(agentId?: string, options?: IAcpCreateSessionOptions): Promise<IAcpSession> {
    const resolvedAgentId = agentId ?? this._registry.defaultAgentId()
    const profile = this._createProfiler.begin(resolvedAgentId)
    const agentName = this._registry.get(resolvedAgentId).name
    const collapseModes = this._config.get<Record<string, string>>('acp.defaultCollapseModes') ?? {}
    const initialCollapseMode: CollapseMode =
      (collapseModes[resolvedAgentId] as CollapseMode | undefined) ?? 'default'
    const cwd = options?.cwd ?? this._currentCwd()
    const authority = options?.authority ?? this._currentAuthority()
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    const title = options?.title ?? `${agentName} ${hh}:${mm}`

    // Build + publish the session synchronously with a stable local id so the
    // chat UI renders (and accepts input) immediately. The agent process spawn +
    // ACP handshake + session/new run in the background; the user's prompts are
    // queued by AcpSession until attachConnection lands. This is what makes "new
    // session" feel instant instead of blocking for 1-5s on the handshake.
    const session = this._sessionFactory.create({
      id: generateUuid(),
      agentId: resolvedAgentId,
      title,
      collapseMode: initialCollapseMode,
      withTitleService: true,
      ...(authority !== undefined ? { authority } : {}),
      ...(options?.aiFix === true ? { suppressConfigDefaults: true } : {}),
    })
    this._register(session)
    this._wireAuthGuidance(session)
    this._wireRecovery(session)
    this._wireConfigOptionsCache(session)
    this._wireMcpDrift(session)
    // Optimistic config bar: seed the last-known option bag for this agent
    // (currentValue overridden by the user's saved per-agent defaults) so the
    // config switches render the instant the session appears, instead of
    // popping in 1-5s later when session/new returns the real bag. The real bag
    // replaces this once the handshake lands (see _connectSession).
    const seededOptions = this._seedConfigOptions(resolvedAgentId, options?.configDesiredOverrides)
    if (seededOptions.length > 0) {
      session.setConfigDesired({
        ...this._agentDefaults.getDefaults(resolvedAgentId),
        ...options?.configDesiredOverrides,
      })
      session.seedConfigOptions(seededOptions)
    }
    // A caller-supplied pin must land before _connectSession snapshots the
    // selection for session/new. The drift autorun is inert here (no
    // sessionIdOnAgent yet), so this cannot trigger a spurious reload.
    if (options?.mcpServerNames !== undefined) {
      session.mcpServerSelection.set(options.mcpServerNames, undefined)
    }
    // Seed the rescued draft before activation: the prompt input reads the
    // draft cache once at mount, and registering the session (next line) is
    // what triggers that mount.
    if (options?.promptDraft !== undefined) {
      AcpPromptDraftCache.save(session.id, options.promptDraft)
    }
    this._sessionStore.add(session, { activate: true })
    this._telemetry.publicLog('acp.session_created', { agentId: resolvedAgentId })
    this._onDidCreate.fire(session)

    void this._connectSession(session, resolvedAgentId, cwd, authority, profile, options)
    return session
  }

  /** Memoized snapshot read for {@link _builtinAgentDirs}. */
  private _builtinSkillsRoot: Promise<string | undefined> | undefined

  /**
   * `additionalDirectories` seed carrying the editor's bundled agent skills
   * (`<resources>/agent-skills`, laid out as `.claude/skills/...`). Both agent
   * forks discover skills under every additional root, so bundled skills (e.g.
   * `/new-extension`) surface as slash commands in every session. Local
   * sessions only: a remote agent runs on the remote host where this local
   * path does not exist.
   */
  private async _builtinAgentDirs(
    authority: string | undefined,
  ): Promise<{ additionalDirectories?: string[] }> {
    if (authority !== undefined) return {}
    this._builtinSkillsRoot ??= this._envSnapshot.getSnapshot().then(
      (snapshot) => snapshot.builtinAgentSkillsRoot,
      () => undefined,
    )
    const root = await this._builtinSkillsRoot
    return root !== undefined ? { additionalDirectories: [root] } : {}
  }

  /**
   * Extra model candidates (id + known context window) to advertise in the
   * handshake `_meta` for `agentId`. Best-effort: candidate resolution failing
   * must never block session creation/resume, so every failure collapses to an
   * empty list (and the `extraModels` / `modelContextWindow` keys are omitted
   * from `_meta` entirely).
   */
  private async _extraModelsFor(
    agentId: string,
    authority: string | undefined,
  ): Promise<readonly AcpModelCandidate[]> {
    try {
      return await this._modelCandidates.extraModelsForAgent(agentId, authority)
    } catch (err) {
      this._logger.warn(`extraModelsForAgent failed: ${(err as Error).message}`)
      return []
    }
  }

  /**
   * Warn once per (agent, model) when a codex gateway model has no known context
   * window: codex then manages it on its 272K fallback, which may be wrong. The
   * warning lives here (not in the fork, which would re-emit it every turn) and
   * points the user at aiSettings.json where they can declare `maxInputTokens`.
   *
   * The model judged is the one the session will actually run — the remembered
   * `resumeModel` when there is one, else the pick. Matching `contextWindowFor`,
   * a remembered model absent from the candidates counts as unknown (we inject
   * nothing for it), so the user hears about the very case that needs fixing.
   */
  private _maybeWarnMissingContextWindow(
    agentId: string,
    candidates: readonly AcpModelCandidate[],
    resumeModel: string | undefined,
  ): void {
    if (agentId !== 'codex') return
    const model = resumeModel ?? candidates[0]?.id
    if (model === undefined) return
    if (contextWindowFor(candidates, model) !== undefined) return
    const dedupeKey = `${agentId}\0${model}`
    if (this._missingWindowWarned.has(dedupeKey)) return
    this._missingWindowWarned.add(dedupeKey)
    this._notification.notify({
      severity: Severity.Warning,
      sticky: true,
      message: localize(
        'acp.modelContextWindowUnknown',
        'The context window for "{model}" is unknown, so it runs on a default that may be wrong. Set "maxInputTokens" for it under "models" in aiSettings.json (command: AI: Open Settings JSON).',
        { model },
      ),
    })
  }

  /**
   * Background connect for a freshly created session: spawn + initialize +
   * session/new, then hand the live connection to the session via
   * `attachConnection` (which flushes any queued prompts) and register it in
   * durable history. On failure the session is sealed via `failConnection` and
   * the user is guided to fix auth / sees the error. Throughout the handshake
   * (and after a failure) the session stays visible in the session list via
   * SessionListBody's optimistic pending rows — the durable history row only
   * exists once session/new returns.
   */
  private async _connectSession(
    session: AcpSession,
    resolvedAgentId: string,
    cwd: string | undefined,
    authority: string | undefined,
    profile: ISessionCreateProfileHandle,
    options?: IAcpCreateSessionOptions,
  ): Promise<void> {
    const agentName = this._registry.get(resolvedAgentId).name
    const timeoutMs = this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
    // The pin is read at the moment session/new is issued so a toggle made
    // while connecting still lands; a later toggle is caught by the drift
    // autorun once the session attaches. The attach snapshot stores the pin
    // itself (not the resolved value) so inheriting sessions never drift
    // against the defaults.
    const selection = session.mcpServerSelection.get()
    profile.step('willResolveMcp')
    const mcpServers = await this._resolveSessionWireMcpServers(resolvedAgentId, selection, true)
    profile.step('didResolveMcp')
    let conn: IAcpClientConnection | undefined
    try {
      profile.step('willConnect')
      conn = await this._client.connect(resolvedAgentId, {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(authority !== undefined ? { authority } : {}),
        profile,
      })
      profile.step('didConnect')
      const activeConn = conn
      const initResult = await withTimeout(activeConn.initializeResult, timeoutMs, 'ACP initialize')
      const { kept, dropped } = filterMcpServersByCapabilities(
        mcpServers,
        initResult.agentCapabilities?.mcpCapabilities,
      )
      this._warnDroppedMcpServers(agentName, dropped)
      const extraModels = await this._extraModelsFor(resolvedAgentId, authority)
      this._maybeWarnMissingContextWindow(resolvedAgentId, extraModels, undefined)
      const newParams: NewSessionRequest = {
        cwd: cwd ?? '',
        mcpServers: kept,
        ...(await this._builtinAgentDirs(authority)),
        _meta: buildNewSessionMeta(extraModels),
      }
      profile.step('willNewSession')
      const result = await withTimeout(
        activeConn.conn.newSession(newParams),
        timeoutMs,
        'ACP session/new',
      )
      profile.step('didNewSession')
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
      // A toggled-while-connecting selection is pinned onto the row here; an
      // untouched session stores nothing (inherit semantics live on read).
      const liveSelection = session.mcpServerSelection.get()
      this._history.add({
        agentId: resolvedAgentId,
        sessionIdOnAgent: result.sessionId,
        title: session.title,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(authority !== undefined ? { authority } : {}),
        hasMessages: false,
        ...(liveSelection !== null ? { mcpServerNames: [...liveSelection] } : {}),
        ...(options?.aiFix === true ? { aiFix: true } : {}),
      })
      profile.step('didHistoryAdd')
      this._mcpSelectionAtAttach.set(session.id, selection)
      // Seed the saved per-agent defaults BEFORE applying the bag so the state
      // machine reconciles it flicker-free (server default → saved value, with
      // no intermediate frame) and queues the real RPC for the agent to adopt.
      session.setConfigDesired({
        ...this._agentDefaults.getDefaults(resolvedAgentId),
        ...options?.configDesiredOverrides,
      })
      session.applyInitState(initState)
      // Snapshot the (reconciled) configOption selections into history so the
      // sidebar can show model / effort on this row even after it stops being
      // live — including the default selection the user never touched.
      this._snapshotConfigToHistory(result.sessionId, session.configOptions.get())
      if (result.configOptions) {
        this._configOptionsCache.set(resolvedAgentId, result.configOptions)
      }
      session.attachConnection(activeConn, result.sessionId)
      profile.step('didAttach')
      this._logger.info(formatSessionCreateProfile(profile.end()))
    } catch (err) {
      if (conn) conn.dispose()
      const msg = (err as Error).message
      this._logger.warn(
        `createSession failed: ${msg} — ${formatSessionCreateProfile(profile.fail(msg))}`,
      )
      session.failConnection(msg)
      if (isAuthRequiredError(err)) {
        // No usable credentials yet — point the user straight at the
        // Authentication panel instead of a dead-end error toast.
        this._authGuidance.promptSessionStartAuth()
      } else {
        this._notification.notify({
          severity: Severity.Error,
          message: localize('acp.sessionStartFailed', 'Failed to start agent session: {msg}', {
            msg,
          }),
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
    if (existing && isResidentLive(existing)) {
      this.setActive(existing.id)
      // Dormant: the session object, its timeline and its tab are all intact —
      // only the agent process is gone. Wake it in place rather than building a
      // SECOND session for the same durable id: a session created in this run
      // has a local uuid that differs from its agent id, so the store's
      // replace-by-local-id would not find the dormant instance and both would
      // live on, with the registry's lookup order handing every notification to
      // the stale one. Fire-and-forget so the tab opens immediately; the
      // recovery bar reports the wake.
      if (existing.isDormant.get()) void existing.ensureAwake()
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
    if (existing && isResidentLive(existing)) {
      // Already live (read-only or not): reuse it. Do NOT setActive — a foreign
      // preview must not steal the current worktree's active session. A dormant
      // session is reused as-is and deliberately NOT woken: a read-only view
      // needs no agent process, and spawning one would undo the idle reclaim.
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
    options: {
      readOnly: boolean
      activate?: boolean
      withTitleService?: boolean
    },
  ): Promise<IAcpSession> {
    const { readOnly } = options
    try {
      await this._sessionFactory.messageAttachments.initialize()
    } catch {
      // A broken sidecar must not make the agent transcript itself unreadable.
    }
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
    const currentCwd = this._currentCwd()
    const currentAuthority = this._currentAuthority()
    const effectiveAuthority = this._entryAuthority(entry)
    if (
      !readOnly &&
      entry.cwd !== undefined &&
      currentCwd !== undefined &&
      (!this._uriIdentity.arePathsEqual(entry.cwd, currentCwd) ||
        effectiveAuthority !== currentAuthority)
    ) {
      this._logger.info(
        `[acp] refusing cross-worktree resume of ${sessionId}: session cwd=${entry.cwd} authority=${effectiveAuthority ?? 'local'} current=${currentCwd} authority=${currentAuthority ?? 'local'}`,
      )
      throw new AcpForeignWorktreeError(sessionId, entry.cwd, currentCwd)
    }
    const cwd = entry.cwd
    let conn: IAcpClientConnection
    try {
      conn = await this._client.connect(entry.agentId, {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(effectiveAuthority !== undefined ? { authority: effectiveAuthority } : {}),
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
    // MCP waterfall: session pin (history row) → inherit the non-disabled
    // pool. Resolved once here and applied identically to the session
    // view-model, the attach snapshot, and the wire list.
    const mcpSelection = entry.mcpServerNames !== undefined ? entry.mcpServerNames : null
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
      session = this._sessionFactory.create({
        id: entry.sessionIdOnAgent,
        agentId: entry.agentId,
        title,
        initState: {
          ...(entry.usage ? { usage: entry.usage } : {}),
          ...(entry.plan && entry.plan.length > 0 ? { plan: entry.plan } : {}),
          ...(entry.accumulatedRunningMs
            ? { accumulatedRunningMs: entry.accumulatedRunningMs }
            : {}),
          mcpServerSelection: mcpSelection === null ? null : [...mcpSelection],
        },
        collapseMode: entry.collapseMode ?? 'default',
        // No title service on resume: restored sessions already carry a durable
        // title, so we must not regenerate (and overwrite) it on the next turn.
        // Side tasks are the exception — their row title is only the quote-label
        // placeholder, so the first turn should derive/generate the real one.
        withTitleService: options.withTitleService === true,
        readOnly,
        // A read-only preview or a resumed remote session runs on the entry's
        // host, which need not be this window's — cost must follow the entry.
        ...(effectiveAuthority !== undefined ? { authority: effectiveAuthority } : {}),
        // AI Fix sessions keep their defaults-write isolation across restarts.
        ...(entry.aiFix === true ? { suppressConfigDefaults: true } : {}),
      })
      session.attachConnection(conn, entry.sessionIdOnAgent)
      this._register(session)
      this._wireAuthGuidance(session)
      this._wireRecovery(session)
      this._wireConfigOptionsCache(session)
      this._wireMcpDrift(session)
      this._mcpSelectionAtAttach.set(session.id, session.mcpServerSelection.get())
      const captured = session
      // Read-only foreign previews register so getById/timeline work, but must
      // not become the active session — that belongs to the current worktree.
      // Side tasks likewise stay inactive: the caller opens them in a
      // right-split tab without stealing the parent chat's active slot.
      const prior = this._sessionStore.replace(captured, {
        activate: options.activate !== false && !readOnly,
      })
      registered = true
      prior?.dispose()

      // The session is now registered, so getById hits and the editor swaps the
      // "Resuming…" placeholder for ChatBody — but the timeline is still empty
      // until session/load replays it below. Mark the replay so ChatBody keeps
      // showing a loading placeholder instead of flashing the empty-session hint.
      session.beginHistoryReplay()
      // Prompts retracted by a cancel-restore stay in the agent transcript —
      // filter them (and their interruption marker) out of the replay so the
      // reloaded timeline matches what the user saw after cancelling.
      session.setRetractedMessageIds(entry.retractedMessageIds)
      // Side tasks: the fork exists only as agent-side context — drop the
      // baseline replay from the timeline so the child looks like a fresh chat.
      // The flag lives on the history row (not a resume option) so it also
      // covers later reopens — restarts and closed-tab resumes, where no fork
      // caller is around to pass the option. The anchor (the side task's first
      // own prompt id, recorded by sendPrompt) lifts the suppression at the
      // replay boundary so the side task's own turns still land.
      if (entry.sideTaskOf !== undefined) {
        session.suppressReplayToTimeline(entry.sideTaskAnchorMessageId)
      }

      const mcpServers = await this._resolveSessionWireMcpServers(entry.agentId, mcpSelection, true)
      const { kept, dropped } = filterMcpServersByCapabilities(
        mcpServers,
        initResult.agentCapabilities?.mcpCapabilities,
      )
      this._warnDroppedMcpServers(this._registry.get(entry.agentId).name, dropped)
      const mcpSeed = kept.map((s) => ({ name: s.name, transport: mcpServerTransport(s) }))
      if (mcpSeed.length > 0) session.applyInitState({ mcpServers: mcpSeed })
      const extraModels = await this._extraModelsFor(entry.agentId, effectiveAuthority)
      this._maybeWarnMissingContextWindow(
        entry.agentId,
        extraModels,
        entry.configOptions?.['model'],
      )
      const loadParams: LoadSessionRequest = {
        sessionId: entry.sessionIdOnAgent,
        cwd: cwd ?? '',
        mcpServers: kept,
        ...(await this._builtinAgentDirs(effectiveAuthority)),
        _meta: buildResumeMeta(entry, extraModels),
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
   * The cooldown that collapses bursts lives in IAcpAuthGuidanceService.
   */
  private _wireAuthGuidance(session: IAcpSession): void {
    const prompt = this._authGuidance.createSessionAuthPrompt(session.agentId)
    this._register(session.onDidRequireAuth(prompt))
  }

  /**
   * Hot-reconnect orchestration. When a live session's agent process dies
   * (crash) or wedges (watchdog stall), the session parks itself in
   * `connecting` and fires `onDidLoseConnection`; this loop re-handshakes in
   * place — fresh spawn (the pool dropped the dead entry) + `session/resume`
   * against the same durable id, which restores the agent-side context
   * WITHOUT replaying history (the local timeline is already complete). On
   * success the session reattaches and resumes its interrupted turn; on
   * exhaustion it seals to `errored` with a manual-retry affordance.
   */
  private _wireRecovery(session: AcpSession): void {
    this._register(session.onDidLoseConnection((e) => void this._reconnectSession(session, e)))
  }

  /**
   * Resolve a session for an explicit user action, waking it first when the idle
   * reaper had stopped its agent process. The single place the wake tier is
   * applied on the facade, so `forkSideTask` / `rewindSession` / activation all
   * behave identically instead of each re-deriving "is this connection dead?".
   *
   * Returns undefined when there is nothing to operate on: no resident session,
   * a read-only foreign preview (must never spawn against another worktree), a
   * session the user closed, or a wake that failed. The caller decides the
   * failure shape — throw for a destructive action, degrade quietly otherwise.
   */
  private async _awakeSession(sessionId: string): Promise<AcpSession | undefined> {
    const session = this._findSession(sessionId)
    if (!session || session.readOnly) return undefined
    const outcome = await session.ensureAwake()
    return outcome === 'closed' || outcome === 'failed' ? undefined : session
  }

  private async _reconnectSession(
    session: AcpSession,
    event: AcpConnectionLostEvent,
  ): Promise<void> {
    if (this._reconnectingSessions.has(session.id)) return
    this._reconnectingSessions.add(session.id)
    try {
      // Mutable across retries: an empty-session rebuild (see `rebuild` below)
      // moves the session onto a NEW durable id, and a retry after that point
      // must look the history row up under the new key — reading the dead id
      // would find nothing, fall back to `session/resume` against a session the
      // agent no longer has, and burn the whole recovery budget.
      let sid = session.sessionIdOnAgent.get()
      if (sid === undefined) {
        // Never attached — there is no durable session to resume against.
        session.sealRecoveryFailure('connection lost before the session was established')
        return
      }
      // A stalled process is alive but wedged: kill it so the reconnect below
      // spawns fresh instead of reattaching to the same wedged turn. A restart
      // must kill it for the same reason plus one more — `connect()` leases from
      // a refcounted pool keyed by agentId+cwd, so without evicting we would
      // re-lease the *same* process and its spawn env (the whole point of the
      // restart) would never change. Other sessions sharing the pooled process
      // crash out and recover on their own `onDidLoseConnection`.
      if (event.reason === 'stalled' || event.reason === 'restart') {
        const stalledEntry = this._history.get(sid)
        this._client.killConnectionFor(session.agentId, stalledEntry?.cwd, stalledEntry?.authority)
      }
      const timeoutMs =
        this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
      const agentName = this._registry.get(session.agentId).name
      let lastError = 'unknown error'
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
        if (session.status.get() === 'closed' || !session.isReconnecting) return
        session.recovery.set({
          phase: 'reconnecting',
          attempt,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          reason: event.reason,
        })
        try {
          const entry = this._history.get(sid)
          const cwd = entry?.cwd ?? this._currentCwd()
          const authority = entry?.authority ?? this._currentAuthority()
          // An EMPTY session (created but never messaged) has no agent-side
          // transcript, so `session/resume` can only answer resourceNotFound —
          // three attempts of that burn the recovery budget and seal the session
          // as "automatic recovery failed". Rebuild it with `session/new`
          // instead: the local session object, its editor tab, draft and config
          // all survive; only the durable id moves (see `rebuiltSessionId`).
          //
          // A side task is the one empty session that DOES have a transcript:
          // `forkSideTask` copies the parent's full history on the agent before
          // the child sends anything, so rebuilding it would silently throw the
          // forked baseline away and leave the side chat without the context it
          // exists to discuss.
          const rebuild = entry?.hasMessages === false && entry.sideTaskOf === undefined
          if (rebuild) {
            this._logger.info(
              `session ${sid} has no agent-side transcript — rebuilding with session/new instead of resume`,
            )
          }
          const conn = await this._client.connect(session.agentId, {
            ...(cwd !== undefined ? { cwd } : {}),
            ...(authority !== undefined ? { authority } : {}),
            // A rebuild learns its durable id only from session/new, so the
            // lease's terminal-ownership tag is set by `attachSession` below —
            // pre-binding the dead id here would strand its terminals.
            ...(rebuild ? {} : { leaseFor: sid }),
            silent: true,
          })
          try {
            const initResult = await withTimeout(conn.initializeResult, timeoutMs, 'ACP initialize')
            if (!rebuild && initResult.agentCapabilities?.loadSession !== true) {
              throw new Error(`${agentName} does not support session/resume — cannot reconnect`)
            }
            const { kept, dropped } = filterMcpServersByCapabilities(
              await this._resolveSessionWireMcpServers(
                session.agentId,
                session.mcpServerSelection.get(),
                attempt === 1,
              ),
              initResult.agentCapabilities?.mcpCapabilities,
            )
            this._warnDroppedMcpServers(agentName, dropped)
            const extraModels = await this._extraModelsFor(session.agentId, authority)
            this._maybeWarnMissingContextWindow(
              session.agentId,
              extraModels,
              rebuild ? undefined : entry?.configOptions?.['model'],
            )
            const agentDirs = await this._builtinAgentDirs(authority)
            let rebuiltSessionId: string | undefined
            // The SDK types these as `T | null` (absent bag), so keep the null
            // and gate on `!= null` at the applyInitState call below.
            let reportedConfigOptions: readonly SessionConfigOption[] | null | undefined
            if (rebuild) {
              const newResult = await withTimeout(
                conn.conn.newSession({
                  cwd: cwd ?? '',
                  mcpServers: kept,
                  ...agentDirs,
                  _meta: buildNewSessionMeta(extraModels),
                }),
                timeoutMs,
                'ACP session/new',
              )
              rebuiltSessionId = newResult.sessionId
              reportedConfigOptions = newResult.configOptions
            } else {
              const resumeResult = await withTimeout(
                conn.conn.resumeSession({
                  sessionId: sid,
                  cwd: cwd ?? '',
                  mcpServers: kept,
                  ...agentDirs,
                  _meta: buildResumeMeta(entry, extraModels),
                }),
                timeoutMs,
                'ACP session/resume',
              )
              reportedConfigOptions = resumeResult.configOptions
            }
            if (session.status.get() === 'closed' || !session.isReconnecting) {
              conn.dispose()
              return
            }
            const attachId = rebuiltSessionId ?? sid
            // The rebuilt agent session re-seeds its config from settings.json
            // (runtime mode/effort/etc. are lost; only the model survives via
            // SDK live state). Re-seed the state machine with the session's
            // saved selections exactly like the startup-resume path does, so
            // the reconciled bag keeps showing the user's values and queues the
            // push-back RPCs the attach below flushes onto the agent.
            session.setConfigDesired({
              ...this._agentDefaults.getDefaults(session.agentId),
              ...(entry?.configOptions ?? {}),
            })
            if (reportedConfigOptions != null) {
              session.applyInitState({ configOptions: reportedConfigOptions })
            }
            // Move the durable history row onto the new id immediately BEFORE
            // the attach, so everything the attach touches (title/first-prompt
            // backfill, the active-session pointer autorun) already sees the new
            // key, while nothing that could still throw runs in between — a
            // throw after the rekey would leave the row on the new id and the
            // session on the old one. The row keeps its title/config/cwd/MCP
            // pin, so the rebuild is invisible to the session list. `sid` moves
            // too: a later retry must look the row up under the live key.
            if (rebuiltSessionId !== undefined) {
              this._history.rekey(sid, rebuiltSessionId)
              this._sessionFactory.messageAttachments.removeSession(sid)
              this._logger.info(`rebuilt empty session ${sid} as ${rebuiltSessionId} on restart`)
              sid = rebuiltSessionId
            }
            conn.attachSession(attachId)
            session.reattachConnection(conn, attachId)
            this._mcpSelectionAtAttach.set(session.id, session.mcpServerSelection.get())
          } catch (err) {
            conn.dispose()
            throw err
          }
          this._telemetry.publicLog('acp.session_recovered', {
            agentId: session.agentId,
            reason: event.reason,
            attempts: attempt,
          })
          session.recovery.clear()
          // The re-asserted config (mode/model) must land on the rebuilt agent
          // before the interrupted turn resumes — otherwise the continuation
          // prompt races ahead of the push-back and runs under the reset
          // defaults (e.g. asking for permission again after bypass was on).
          await session.whenConfigOptionsSettled()
          // Resume the turn that was in-flight when the connection died.
          await session.continueInterruptedTurn()
          return
        } catch (err) {
          lastError = (err as Error).message
          this._logger.warn(
            `reconnect attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS} for ${sid} failed: ${lastError}`,
          )
          if (attempt < MAX_RECOVERY_ATTEMPTS) {
            const delay = recoveryBackoffMs(attempt + 1)
            session.recovery.set({
              phase: 'reconnecting',
              attempt: attempt + 1,
              maxAttempts: MAX_RECOVERY_ATTEMPTS,
              reason: event.reason,
              nextAttemptAt: Date.now() + delay,
            })
            // Wakes early on cancelRecovery/close; the loop re-checks liveness.
            await session.recovery.sleep(delay).catch(() => {})
          }
        }
      }
      this._logger.warn(`reconnect exhausted for ${sid}: ${lastError}`)
      session.sealRecoveryFailure(
        `Agent connection lost and automatic reconnect failed: ${lastError}`,
      )
      this._telemetry.publicLogError('acp.session_recovery_failed', {
        agentId: session.agentId,
        reason: event.reason,
        error: lastError,
      })
    } finally {
      this._reconnectingSessions.delete(session.id)
      // A connection lost while this loop was finishing (after the reattach
      // cleared the session's latch) had its onDidLoseConnection swallowed by
      // the dedup above. Re-run so the session isn't stranded in `connecting`
      // forever. Healthy outcomes (reattached / sealed / closed / cancelled)
      // all leave isReconnecting false, so this is a no-op for them.
      if (session.isReconnecting && session.status.get() !== 'closed') {
        const st = session.recoveryState.get()
        // Preserve `stalled`/`restart` — collapsing either to `crash` skips the
        // pool eviction above, which for a restart means silently re-leasing the
        // old process with the old spawn env.
        const carried =
          st?.phase === 'reconnecting' && (st.reason === 'stalled' || st.reason === 'restart')
            ? st.reason
            : 'crash'
        void this._reconnectSession(session, { reason: carried })
      }
    }
  }

  /**
   * Stall watchdog: a session stuck in `running` with no inbound update for
   * `acp.turnStallTimeoutMs` (default 10min, 0 disables) is treated like a
   * crash — the agent process is alive but its turn is wedged (e.g. a hung
   * subprocess the agent spawned), so it is killed and hot-reconnected.
   * Sessions mid-recovery or in backoff are skipped: their wait is expected
   * silence, not a wedge. Sessions awaiting user input (AskUserQuestion /
   * permission card) are also skipped: the wire is silent while the user
   * thinks, and that wait is unbounded by nature. So are sessions running a
   * compaction: the fork reports its lifecycle via ext-notifications, never
   * session/update, so the wire stays quiet for as long as it takes.
   */
  private _startStallWatchdog(): void {
    const interval = setInterval(() => {
      this._checkStalledSessions()
      this._reclaimIdleConnections()
    }, STALL_WATCHDOG_TICK_MS)
    this._register({ dispose: () => clearInterval(interval) })
  }

  private _checkStalledSessions(): void {
    const stallMs = this._config.get<number>('acp.turnStallTimeoutMs') ?? DEFAULT_STALL_TIMEOUT_MS
    if (stallMs <= 0) return
    const now = Date.now()
    for (const session of this._sessionStore.sessions.get()) {
      if (!(session instanceof AcpSession)) continue
      if (session.readOnly || session.status.get() !== 'running') continue
      if (session.recovery.state.get() !== undefined) continue
      // Awaiting user input (question / permission card) is expected silence —
      // the agent is demonstrably alive (it just asked), and the wait lasts as
      // long as the user thinks.
      if (session.pendingElicitation.get() !== undefined) continue
      if (session.pendingPermission.get() !== undefined) continue
      // A running compaction is expected silence too: its lifecycle arrives
      // via ext-notifications rather than session/update, so it never bumps
      // lastActivityAt mid-run no matter how long it takes.
      if (session.compactionInProgress) continue
      // An autonomous follow-up turn (background-task wakeup) holds no prompt
      // RPC, so there is nothing to abort and resume — declaring it stalled
      // would kill a working turn. `_universe/background_activity` snapshots
      // keep lastActivityAt fresh while it runs.
      if (session.autonomousTurnActive) continue
      const silentMs = now - session.lastActivityAt
      if (silentMs < stallMs) continue
      this._logger.warn(
        `session ${session.id} (agent id ${session.sessionIdOnAgent.get() ?? 'unattached'}) stalled (no updates for ${Math.round(silentMs / 1000)}s) — hot-reconnecting`,
      )
      this._telemetry.publicLog('acp.session_stall_detected', { agentId: session.agentId })
      session.handleStall()
    }
  }

  /**
   * Idle-process reaper: when EVERY live session sharing one pooled connection
   * (agentId + cwd) has been idle for `acp.idleProcessTimeoutMs` (default 5min,
   * <=0 disables), the agent process is stopped to release memory. This is the
   * same fate as a mid-idle crash — every affected session silently seals and
   * re-handshakes on the next sendPrompt, so no session state is touched here.
   * A session whose pool cwd cannot be resolved (not yet attached, or its
   * history row lacks one) poisons the whole agent for this tick: the pool key
   * would be a guess and we never kill on a guess.
   */
  private _reclaimIdleConnections(): void {
    const idleMs =
      this._config.get<number>('acp.idleProcessTimeoutMs') ?? DEFAULT_IDLE_PROCESS_TIMEOUT_MS
    if (idleMs <= 0) return
    const now = Date.now()
    const poisonedAgents = new Set<string>()
    const groups = new Map<
      string,
      { agentId: string; cwd: string; authority: string | undefined; sessions: AcpSession[] }
    >()
    for (const session of this._sessionStore.sessions.get()) {
      if (!(session instanceof AcpSession)) continue
      const sid = session.sessionIdOnAgent.get()
      const entry = sid === undefined ? undefined : this._history.get(sid)
      const cwd = entry?.cwd
      if (cwd === undefined) {
        poisonedAgents.add(session.agentId)
        continue
      }
      const authority = entry?.authority
      const key = `${session.agentId}\0${authority ?? ''}\0${cwd}`
      let group = groups.get(key)
      if (!group) {
        group = { agentId: session.agentId, cwd, authority, sessions: [] }
        groups.set(key, group)
      }
      group.sessions.push(session)
    }
    for (const group of groups.values()) {
      if (poisonedAgents.has(group.agentId)) continue
      // An all-closed group has no live pool entry to kill: user-closed leases
      // are reaped by the pool's own grace eviction, and silently sealed ones
      // ride a connection the pool already evicted. Skipping also keeps a
      // sealed group from re-logging and re-reporting every tick forever.
      if (group.sessions.every((session) => session.status.get() === 'closed')) continue
      if (group.sessions.some((session) => !this._isIdleReclaimable(session, now, idleMs))) {
        continue
      }
      const silentSeconds = Math.round(
        Math.max(...group.sessions.map((session) => now - session.lastActivityAt)) / 1000,
      )
      this._logger.info(
        `all ${group.sessions.length} session(s) of ${group.agentId} (cwd ${group.cwd}${group.authority ? ` authority ${group.authority}` : ''}) idle for ${silentSeconds}s — stopping the agent process; it re-handshakes on the next prompt`,
      )
      this._telemetry.publicLog('acp.idle_process_reclaimed', {
        agentId: group.agentId,
        sessions: group.sessions.length,
      })
      this._client.killConnectionFor(group.agentId, group.cwd, group.authority)
    }
  }

  /**
   * One session may see its shared process reclaimed only when it is fully at
   * rest: no live turn, no recovery in flight, no card awaiting the user, no
   * compaction or background work — and, unless it is already closed or
   * read-only (both complete without the agent), it must carry a durable
   * transcript so `session/resume` can resurrect it after the kill.
   */
  private _isIdleReclaimable(session: AcpSession, now: number, idleMs: number): boolean {
    const status = session.status.get()
    if (status !== 'idle' && status !== 'errored' && status !== 'closed') return false
    if (session.recovery.state.get() !== undefined) return false
    if (session.pendingElicitation.get() !== undefined) return false
    if (session.pendingPermission.get() !== undefined) return false
    if (session.compactionInProgress) return false
    // The status filter already covers autonomous turns (they read as
    // 'running'); background tasks can outlive the turn while the session
    // reads 'idle', so they need their own signal.
    if (session.autonomousTurnActive) return false
    if (session.backgroundTaskCount.get() > 0) return false
    if (!session.readOnly && status !== 'closed') {
      const sid = session.sessionIdOnAgent.get()
      if (sid !== undefined && this._history.get(sid)?.hasMessages === false) return false
    }
    return now - session.lastActivityAt >= idleMs
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
      this._sessionFactory.messageAttachments.removeSession(entry.id)
    } else {
      this._logger.warn(`resumeSession failed: ${msg}`)
      this._notification.notify({
        severity: Severity.Error,
        message: localize('acp.sessionResumeFailed', 'Failed to resume agent session: {msg}', {
          msg,
        }),
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
    this._mcpSelectionAtAttach.delete(localId)
    AcpChatViewStateCache.clear(localId)
    AcpPromptDraftCache.clear(localId)
    AcpElicitationDraftCache.clearSession(localId)
    this._telemetry.publicLog('acp.session_closed', { sessionId: localId })
    this._onDidCloseSession.fire(localId)
  }

  getById(sessionId: string): IAcpSession | undefined {
    return this._findSession(sessionId)
  }

  async deleteOnAgent(sessionId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
    const result = await this._coordinator.deleteOnAgent(sessionId)
    await this._sessionFactory.messageAttachments.initialize().catch(() => {})
    this._sessionFactory.messageAttachments.removeSession(sessionId)
    return result
  }

  resolveTranscriptPath(sessionId: string): Promise<string | undefined> {
    return this._coordinator.fetchTranscriptPath(sessionId)
  }

  renameSession(sessionId: string, title: string): boolean {
    const trimmed = title.trim().replace(/\s+/g, ' ')
    if (trimmed.length === 0) return false
    const live = this._findSession(sessionId)
    if (live && !live.readOnly && isResidentLive(live)) {
      // Includes dormant sessions. Deliberately NOT woken: the local title +
      // manualTitle guard land immediately, and `renameTitle` buffers the value
      // so `attachConnection` pushes it to the agent on the next natural wake.
      // Spawning a process just to record a title would undo the idle reclaim.
      live.renameTitle(trimmed)
      this._telemetry.publicLog('acp.session_renamed', { live: true })
      return true
    }
    // History-only row (not live, or a closed/foreign-preview instance). Rename
    // it locally with the manualTitle guard so hydrate can't clobber it. The
    // agent-side push happens on the next live resume (its history row already
    // carries the title). Foreign rows are rejected: their title here is only a
    // hydrate cache the owning worktree reconciles back.
    const entry = this._history.get(sessionId)
    if (!entry) return false
    const currentCwd = this._currentCwd()
    const currentAuthority = this._currentAuthority()
    if (
      entry.cwd !== undefined &&
      currentCwd !== undefined &&
      (!this._uriIdentity.arePathsEqual(entry.cwd, currentCwd) ||
        this._entryAuthority(entry) !== currentAuthority)
    ) {
      return false
    }
    this._history.updateInfo(entry.id, { title: trimmed }, { overwriteProtectedTitle: true })
    this._history.setHistoryManualTitle(entry.id)
    this._telemetry.publicLog('acp.session_renamed', { live: false })
    return true
  }

  async forkSession(sessionId: string, messageId?: string): Promise<IAcpSession> {
    // Resolve the source session's durable coordinates. A live session carries
    // its agent-issued id; otherwise fall back to the persisted history row.
    const live = this._findSession(sessionId)
    const sourceAgentSessionId = live?.sessionIdOnAgent.get() ?? sessionId
    const entry = this._history.get(sourceAgentSessionId)
    if (!entry) throw new Error(`Unknown session to fork: ${sessionId}`)

    const forkMcpSelection = this._forkMcpSelection(live, entry)
    const newSessionId = await this._forkOnAgent(
      sourceAgentSessionId,
      entry,
      forkMcpSelection,
      messageId,
    )
    try {
      await this._sessionFactory.messageAttachments.initialize()
    } catch {
      // Fork remains usable even if its local attachment sidecar cannot load.
    }

    // Register the fork as a durable history row so resumeSession can load it.
    const forkTitle = localize('acp.session.forkTitle', '{title} (fork)', { title: entry.title })
    // Carry the source session's config (model / effort / …) onto the fork's row.
    // The forked agent thread starts on its own defaults; resumeSession seeds these
    // as the "desired" values and pushes them back to the agent, so the fork keeps
    // running the config the source was using instead of silently reverting to
    // defaults. Prefer the live session's current selections; fall back to the
    // source row's cached snapshot when the source isn't resident.
    const forkConfig = live
      ? snapshotConfigSelections(live.configOptions.get())
      : {
          values: entry.configOptions ?? {},
          labels: entry.configLabels ?? {},
        }
    const forkAuthority = this._entryAuthority(entry)
    this._history.add({
      agentId: entry.agentId,
      sessionIdOnAgent: newSessionId,
      title: forkTitle,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(forkAuthority !== undefined ? { authority: forkAuthority } : {}),
      hasMessages: true,
      ...(forkMcpSelection !== null ? { mcpServerNames: [...forkMcpSelection] } : {}),
      ...(Object.keys(forkConfig.values).length > 0
        ? { configOptions: forkConfig.values, configLabels: forkConfig.labels }
        : {}),
    })
    const copiedMessageIds = live
      ? messageIdsThrough(live.messages.get(), messageId)
      : messageId === undefined
        ? undefined
        : []
    this._sessionFactory.messageAttachments.copySession(
      sourceAgentSessionId,
      newSessionId,
      copiedMessageIds,
    )
    this._telemetry.publicLog('acp.session_forked', {
      agentId: entry.agentId,
      fromMessage: messageId !== undefined,
    })
    // Load + replay the fork's (truncated) history into a fresh live session and
    // make it active — resumeSession handles the session/load replay.
    return this.resumeSession(newSessionId)
  }

  async forkSideTask(
    parentSessionId: string,
    quote: { text: string; label: string },
  ): Promise<IAcpSession> {
    // Side tasks fork the parent's CURRENT tip, so the parent must be resident
    // (a history-only row would fork a stale tip) and writable (a read-only
    // foreign preview must not spawn side effects in another worktree). A parent
    // the idle reaper put to sleep is woken first — its tip is intact, only the
    // process was reclaimed.
    const live = await this._awakeSession(parentSessionId)
    if (!live) {
      throw new Error(`Cannot fork a side task from session: ${parentSessionId}`)
    }
    const sourceAgentSessionId = live.sessionIdOnAgent.get() ?? parentSessionId
    const entry = this._history.get(sourceAgentSessionId)
    if (!entry) throw new Error(`Unknown session to fork: ${parentSessionId}`)

    const forkMcpSelection = this._forkMcpSelection(live, entry)
    const newSessionId = await this._forkOnAgent(sourceAgentSessionId, entry, forkMcpSelection)

    // The child inherits the parent's config but is pinned to the agent's
    // read-only mode so the side chat can explain and query without touching
    // source / files / git. claude uses `dontAsk` (deny-not-pre-approved →
    // write tools refuse) rather than `plan`, which would run the plan/exit-plan
    // flow and drop a plan onto the side chat's timeline. codex keeps its
    // `read-only` sandbox mode. The user can still switch modes explicitly
    // afterwards. Agents whose mode list lacks the value simply ignore the push
    // (the config state machine skips unknown values).
    const readOnlyMode = entry.agentId === 'claude-code' ? 'dontAsk' : 'read-only'
    const forkConfig = snapshotConfigSelections(live.configOptions.get())
    const configOptions = { ...forkConfig.values, mode: readOnlyMode }
    const configLabels = { ...forkConfig.labels, mode: readOnlyMode }
    const forkAuthority = this._entryAuthority(entry)
    this._history.add({
      agentId: entry.agentId,
      sessionIdOnAgent: newSessionId,
      title: quote.label,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(forkAuthority !== undefined ? { authority: forkAuthority } : {}),
      hasMessages: false,
      sideTaskOf: sourceAgentSessionId,
      sideTaskQuote: quote.text,
      ...(forkMcpSelection !== null ? { mcpServerNames: [...forkMcpSelection] } : {}),
      configOptions,
      configLabels,
    })
    this._telemetry.publicLog('acp.side_task_forked', { agentId: entry.agentId })
    // The replay suppression is derived from the history row's sideTaskOf flag
    // inside _resumeSessionInner. The child is not made active — the caller
    // opens it in a right-split editor tab. The title service rides along so
    // the first turn replaces the quote-label placeholder with a derived +
    // AI-generated title.
    return this._resumeSessionInner(newSessionId, {
      readOnly: false,
      activate: false,
      withTitleService: true,
    })
  }

  /**
   * The MCP whitelist a fork inherits from its source: the live session's
   * current selection wins over the persisted row, so a session the user
   * trimmed servers off of forks trimmed as well instead of silently reverting
   * to the defaults.
   */
  private _forkMcpSelection(
    live: IAcpSession | undefined,
    entry: AcpSessionHistoryEntry,
  ): readonly string[] | null {
    return live && !live.readOnly
      ? live.mcpServerSelection.get()
      : entry.mcpServerNames !== undefined
        ? entry.mcpServerNames
        : null
  }

  /**
   * Shared fork RPC for {@link forkSession} / {@link forkSideTask}: guards the
   * cross-worktree split-brain case, leases a temp connection, validates the
   * agent's fork capability, and issues `session/fork`. Returns the new
   * agent-issued session id. The caller owns history-row registration and the
   * resume that turns the fork into a live session.
   */
  private async _forkOnAgent(
    sourceAgentSessionId: string,
    entry: AcpSessionHistoryEntry,
    mcpSelection: readonly string[] | null,
    messageId?: string,
  ): Promise<string> {
    // Fork spawns / resumes the agent against the source's cwd. Refuse a
    // cross-worktree fork for the same reason resume does — it would run the
    // agent against a directory this window isn't rooted in.
    const cwd = entry.cwd
    const currentCwd = this._currentCwd()
    const currentAuthority = this._currentAuthority()
    const effectiveAuthority = this._entryAuthority(entry)
    if (
      cwd !== undefined &&
      currentCwd !== undefined &&
      (!this._uriIdentity.arePathsEqual(cwd, currentCwd) || effectiveAuthority !== currentAuthority)
    ) {
      throw new AcpForeignWorktreeError(sourceAgentSessionId, cwd, currentCwd)
    }

    const timeoutMs = this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_STARTUP_TIMEOUT_MS
    const conn = await this._client.connect(entry.agentId, {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(effectiveAuthority !== undefined ? { authority: effectiveAuthority } : {}),
    })
    try {
      const initResult = await withTimeout(conn.initializeResult, timeoutMs, 'ACP initialize')
      if (initResult.agentCapabilities?.sessionCapabilities?.fork == null) {
        throw new Error('Agent does not advertise sessionCapabilities.fork — cannot fork')
      }
      const mcpServers = await this._resolveSessionWireMcpServers(entry.agentId, mcpSelection, true)
      const { kept } = filterMcpServersByCapabilities(
        mcpServers,
        initResult.agentCapabilities?.mcpCapabilities,
      )
      const result = await withTimeout(
        conn.conn.unstable_forkSession({
          sessionId: sourceAgentSessionId,
          cwd: cwd ?? '',
          mcpServers: kept,
          ...(await this._builtinAgentDirs(effectiveAuthority)),
          _meta: {
            // Fork assembles a fresh thread config, so the candidates + window
            // must ride along exactly as they do on new/load — otherwise the
            // forked thread runs its first turn on codex's 272K fallback until
            // the resume below re-injects them.
            ...buildForkMeta(entry, await this._extraModelsFor(entry.agentId, effectiveAuthority)),
            // Ask the fork to truncate at this user turn (回退 point) instead of the
            // session tip. Unknown/absent id → the agent forks from the tip.
            ...(messageId !== undefined ? { rewindTo: messageId } : {}),
          },
        }),
        timeoutMs,
        'ACP session/fork',
      )
      return result.sessionId
    } finally {
      // Drop the temp lease used only for the fork RPC; the resume below opens
      // its own lease (reusing the same pooled process) to load + replay.
      conn.dispose()
    }
  }

  async rewindSession(
    sessionId: string,
    messageId: string,
    options?: { dryRun?: boolean; rewindFiles?: boolean },
  ): Promise<RewindFilesResult | undefined> {
    // Rewind (including the dry-run impact preview) is an ext-method, so a
    // dormant session needs its process back before it can answer.
    const session = await this._awakeSession(sessionId)
    if (!session || !session.rewindSupported.get()) return undefined
    return session.rewindTo(messageId, options ?? {})
  }

  /**
   * Build the optimistic `configOptions` bag for a brand-new session of `agentId`
   * from the persisted cache, overriding each option's `currentValue` with the
   * user's saved per-agent default so the placeholder shows exactly the value the
   * session will end up with (avoiding a server-default → user-value flicker).
   * Returns an empty array when nothing is cached (cold start / first session).
   */
  private _seedConfigOptions(
    agentId: string,
    overrides?: Readonly<Record<string, string>>,
  ): readonly SessionConfigOption[] {
    const cached = this._configOptionsCache.get(agentId)
    if (cached.length === 0) return cached
    return overrideConfigOptionValues(cached, {
      ...this._agentDefaults.getDefaults(agentId),
      ...overrides,
    }).bag
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
    if (method === COMPACTION_METHOD) {
      this._handleCompactionNotification(params)
      return
    }
    if (method === RESURRECTION_METHOD) {
      this._handleResurrectionNotification(params)
      return
    }
    if (method === LIVENESS_PING_METHOD) {
      const sessionId = params['sessionId']
      if (typeof sessionId !== 'string') return
      this._findSession(sessionId)?.applyLivenessPing()
      return
    }
    if (method === BACKGROUND_ACTIVITY_METHOD) {
      const sessionId = params['sessionId']
      const backgroundTasks = params['backgroundTasks']
      const autonomousTurn = params['autonomousTurn']
      if (
        typeof sessionId !== 'string' ||
        typeof backgroundTasks !== 'number' ||
        typeof autonomousTurn !== 'boolean'
      ) {
        return
      }
      this._findSession(sessionId)?.applyBackgroundActivity({ backgroundTasks, autonomousTurn })
      return
    }
    if (method === MCP_SERVER_STATUS_METHOD) {
      const sessionId = params['sessionId']
      if (typeof sessionId !== 'string' || !Array.isArray(params['servers'])) return
      this._findSession(sessionId)?.applyMcpServerSnapshot(readMcpServerStatuses(params['servers']))
      return
    }
    if (method !== SDK_MESSAGE_EXT_METHOD) return
    const sessionId = params['sessionId']
    const message = params['message']
    if (typeof sessionId !== 'string' || message == null || typeof message !== 'object') return
    const m = message as { type?: unknown; subtype?: unknown; mcp_servers?: unknown }
    if (m.type !== 'system' || m.subtype !== 'init' || !Array.isArray(m.mcp_servers)) return
    const session = this._findSession(sessionId)
    if (!session) return
    session.applyMcpServerSnapshot(readMcpServerStatuses(m.mcp_servers))
  }

  private _handleCompactionNotification(params: Record<string, unknown>): void {
    const sessionId = params['sessionId']
    const id = params['id']
    const phase = params['phase']
    if (typeof sessionId !== 'string' || typeof id !== 'string') return
    if (phase !== 'start' && phase !== 'success' && phase !== 'failed') return
    const session = this._findSession(sessionId)
    if (!session) return
    const reason = typeof params['reason'] === 'string' ? params['reason'] : undefined
    session.applyCompaction(id, phase === 'start' ? 'running' : phase, reason)
  }

  private _handleResurrectionNotification(params: Record<string, unknown>): void {
    const sessionId = params['sessionId']
    const id = params['id']
    const phase = params['phase']
    if (typeof sessionId !== 'string' || typeof id !== 'string') return
    if (phase !== 'start' && phase !== 'success' && phase !== 'failed') return
    const session = this._findSession(sessionId)
    if (!session) return
    const replayCount =
      typeof params['replayCount'] === 'number' ? params['replayCount'] : undefined
    const reason = typeof params['reason'] === 'string' ? params['reason'] : undefined
    session.applyResurrection(id, phase === 'start' ? 'running' : phase, {
      ...(replayCount !== undefined ? { replayCount } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  async onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // switch_mode（ExitPlanMode）永不走静默自动批准：它的自动化由
    // `acp.plan.autoExecute` 显式驱动，落到下方卡片上可见、可打断的倒计时路径。
    const auto = this._permission.tryAutoApprove(params)
    if (auto && params.toolCall.kind !== 'switch_mode') {
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
    // plan 审查的自动执行：设置非 off 且目标选项确实在本次 options 里才附加
    // （例如 ALLOW_BYPASS 关闭时 bypassPermissions 缺席，降级为普通弹卡）。
    const autoResolve = this._planAutoResolve(params)
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
        ...(autoResolve ? { autoResolve } : {}),
        resolve: (optionId, feedback) => {
          if (
            allowAlways &&
            optionId === allowAlways.optionId &&
            params.toolCall.kind &&
            params.toolCall.kind !== 'switch_mode'
          ) {
            this._permission.persistAllow(params.toolCall.kind)
          }
          this._telemetry.publicLog('acp.permission_resolved', { optionId })
          const trimmed = feedback?.trim()
          settle({
            outcome: {
              outcome: 'selected',
              optionId,
              // ExitPlanMode 的「继续规划」意见走 ACP `_meta` 透传给 fork，由其作为
              // deny message 反馈给 agent（fork 端读 `_meta.feedback`）。
              ...(trimmed ? { _meta: { feedback: trimmed } } : {}),
            },
          })
        },
        cancel: () => {
          this._telemetry.publicLog('acp.permission_cancelled', {})
          settle({ outcome: { outcome: 'cancelled' } })
        },
      }
      session.presentPermission(pending)
    })
  }

  /**
   * ExitPlanMode（kind 'switch_mode'）的自动执行判定。返回 undefined 表示走普通人工弹卡：
   * 设置 off / 非 plan 请求 / 设置值对应的选项不在本次 options 里。
   */
  private _planAutoResolve(
    params: RequestPermissionRequest,
  ): { optionId: string; delayMs: number } | undefined {
    if (params.toolCall.kind !== 'switch_mode') return undefined
    const mode = this._config.get<string>('acp.plan.autoExecute')
    if (!mode || mode === 'off') return undefined
    if (!params.options.some((o) => o.optionId === mode)) return undefined
    return { optionId: mode, delayMs: PLAN_AUTO_EXECUTE_DELAY_MS }
  }

  async onCreateElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    // Session-scoped elicitations route by sessionId; request-scoped ones
    // (auth/config phases before any session exists) have no card host, so
    // they settle as cancel — the agent falls back to a non-interactive path.
    // (The custom-mode variant's index signature types `sessionId` as unknown
    // — guard it back to a string before use.)
    const rawSessionId = 'sessionId' in params ? params.sessionId : undefined
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined
    const session = sessionId !== undefined ? this._findSession(sessionId) : undefined
    if (!session) {
      this._logger.warn(`elicitation/create for unknown session ${sessionId ?? '(request-scoped)'}`)
      return { action: 'cancel' }
    }
    const isUrl = params.mode === 'url'
    const rawElicitationId = 'elicitationId' in params ? params.elicitationId : undefined
    const elicitationId = typeof rawElicitationId === 'string' ? rawElicitationId : undefined
    this._telemetry.publicLog('acp.elicitation_shown', {
      sessionId,
      mode: params.mode,
    })
    return await new Promise<CreateElicitationResponse>((resolve) => {
      let settled = false
      const urlState = isUrl
        ? observableValue<AcpUrlElicitationState>(
            `acp.elicitation.urlState.${session.id}`,
            'consent',
          )
        : undefined
      const teardown = (): void => {
        if (session.pendingElicitation.get() === pending) {
          session.pendingElicitation.set(undefined, undefined)
        }
        if (elicitationId !== undefined) this._pendingUrlElicitations.delete(elicitationId)
      }
      const settle = (result: CreateElicitationResponse): void => {
        if (settled) return
        settled = true
        this._telemetry.publicLog('acp.elicitation_resolved', {
          sessionId,
          mode: params.mode,
          action: typeof result.action === 'string' ? result.action : 'unknown',
        })
        // url accept keeps the card up in the waiting state until the agent's
        // elicitation/complete arrives (or the user dismisses it); every other
        // exit tears the card down immediately.
        if (urlState && result.action === 'accept') {
          urlState.set('waiting', undefined)
        } else {
          teardown()
        }
        resolve(result)
      }
      const pending: AcpPendingElicitation = {
        request: params,
        ...(urlState ? { urlState } : {}),
        resolve: (result) => settle(result),
        cancel: () => {
          // Always tear the card down — after a url accept the promise is
          // already settled (a late cancel is a wire no-op) but session close /
          // supersede must still unregister the elicitationId and clear the card.
          teardown()
          settle({ action: 'cancel' })
        },
        ...(urlState ? { dismiss: () => teardown() } : {}),
      }
      if (urlState && elicitationId !== undefined) {
        this._pendingUrlElicitations.set(elicitationId, urlState)
      }
      session.presentElicitation(pending)
    })
  }

  onCompleteElicitation(params: CompleteElicitationNotification): void {
    const rawId = 'elicitationId' in params ? params.elicitationId : undefined
    const elicitationId = typeof rawId === 'string' ? rawId : undefined
    const urlState =
      elicitationId !== undefined ? this._pendingUrlElicitations.get(elicitationId) : undefined
    // Per spec, unknown elicitation ids must be silently ignored.
    if (!urlState) {
      this._logger.info(
        `elicitation/complete for unknown elicitation ${elicitationId ?? '(no id)'}`,
      )
      return
    }
    // Only a consented card transitions; a complete racing the consent card is
    // the agent's protocol violation — keep the consent UI decisive.
    if (urlState.get() === 'waiting') urlState.set('done', undefined)
  }

  /**
   * The `acp.mcpServers` raw values of every layer, lowest priority first:
   * the extension-contributed runtime record (declarative
   * `contributes.mcpServers`, never persisted), then the settings layers
   * (mirrors `IConfigurationService.get` precedence). Layers compose per
   * server name — a workspace entry overrides only the same-named global one,
   * never the whole map; a user entry likewise overrides an extension one.
   */
  private _mcpSettingsLayers(): McpServerRawLayer[] {
    const raw = (t: ConfigurationTarget): unknown =>
      this._config.getLayerSnapshot(t)['acp.mcpServers']
    return [
      { source: 'extension', raw: this._extensionMcpServers.rawRecord },
      { source: 'global', raw: raw(ConfigurationTarget.VSCodeUser) },
      { source: 'global', raw: raw(ConfigurationTarget.User) },
      { source: 'project', raw: raw(ConfigurationTarget.VSCodeWorkspace) },
      { source: 'project', raw: raw(ConfigurationTarget.Project) },
      { source: 'global', raw: raw(ConfigurationTarget.Memory) },
    ]
  }

  private _readMcpServers(): McpServer[] {
    return normalizeMcpServers(mergeMcpServerRawLayers(this._mcpSettingsLayers()), (m) =>
      this._logger.warn(`mcpServers: ${m}`),
    )
  }

  // -- MCP definition pool & session selection ---------------------------

  /** Pool `disabled` annotation source: the storage-backed enablement overrides. */
  private readonly _isMcpDefaultDisabled = (name: string): boolean =>
    !this._mcpEnablement.isEnabled(name)

  private _readGlobalMcpDefinitions(): readonly McpServerDefinition[] {
    return readMcpServerDefinitionsLayered(
      this._mcpSettingsLayers(),
      (m) => this._logger.warn(`mcpServers: ${m}`),
      this._isMcpDefaultDisabled,
    )
  }

  /**
   * Read + parse the project `.mcp.json` at the workspace root. Returns an
   * empty record when there is no workspace, no file, or the file is broken —
   * the project layer is purely additive and must never break session flows.
   */
  async readProjectMcpJson(): Promise<Record<string, unknown>> {
    const folder = this._workspace.current?.folder
    if (!folder) return {}
    try {
      const bytes = await this._fileService.readFile(URI.joinPath(folder, '.mcp.json'))
      return parseMcpJson(new TextDecoder().decode(bytes), (m) => this._logger.warn(m))
    } catch {
      return {}
    }
  }

  async refreshMcpServerDefinitions(): Promise<void> {
    // Cold-start barriers: the extension layer resolves asynchronously
    // (execPath snapshot fetch) and the enablement overrides hydrate from
    // storage — don't publish a pool that silently misses either.
    await Promise.all([this._extensionMcpServers.whenReady, this._mcpEnablement.whenReady])
    const globalDefs = this._readGlobalMcpDefinitions()
    const projectRaw = await this.readProjectMcpJson()
    const projectDefs = readMcpServerDefinitions(
      projectRaw,
      'project',
      (m) => this._logger.warn(`mcpServers(.mcp.json): ${m}`),
      this._isMcpDefaultDisabled,
    ).map((d) => ({ ...d, fromMcpJson: true }))
    // `.mcp.json` winners never carry the user-level annotation from the
    // layered read (the file is not a settings layer) — propagate it so a
    // same-named user-level definition still offers the user-level toggle.
    const userLevelNames = new Set(
      globalDefs.filter((d) => d.hasUserLevelDefinition).map((d) => d.name),
    )
    const annotatedProjectDefs = projectDefs.map((d) =>
      !d.hasUserLevelDefinition && userLevelNames.has(d.name)
        ? { ...d, hasUserLevelDefinition: true }
        : d,
    )
    this.mcpServerDefinitions.set(
      mergeMcpServerDefinitions(globalDefs, annotatedProjectDefs),
      undefined,
    )
  }

  /**
   * Resolve a session's effective MCP wire list: merged pool (global config +
   * project `.mcp.json`) → whitelist filter (`null` selection = every
   * non-`disabled` pool entry) → warning for whitelisted names that no longer
   * exist in the pool.
   */
  private async _resolveSessionWireMcpServers(
    agentId: string,
    selection: readonly string[] | null,
    warnStale: boolean,
  ): Promise<McpServer[]> {
    await Promise.all([this._extensionMcpServers.whenReady, this._mcpEnablement.whenReady])
    const projectRaw = await this.readProjectMcpJson()
    const projectWire = normalizeMcpServers(projectRaw, (m) =>
      this._logger.warn(`mcpServers(.mcp.json): ${m}`),
    )
    const mergedWire = mergeWireMcpServers(this._readMcpServers(), projectWire)
    // Recompute the pool from the same snapshot instead of reading the async
    // mirror: the mirror's refresh (config-change → fs read) races session
    // creation, and a stale mirror silently filters the wire list down to [].
    const projectDefs = readMcpServerDefinitions(
      projectRaw,
      'project',
      (m) => this._logger.warn(`mcpServers(.mcp.json): ${m}`),
      this._isMcpDefaultDisabled,
    )
    const pool = mergeMcpServerDefinitions(this._readGlobalMcpDefinitions(), projectDefs)
    const { enabledNames, staleNames } = resolveMcpServerSelection(pool, selection)
    if (warnStale && staleNames.length > 0) {
      this._logger.warn(
        `mcpServers: session whitelist names not in the definition pool, skipped: ${staleNames.join(', ')}`,
      )
    }
    return filterWireByNames(mergedWire, new Set(enabledNames))
  }

  setSessionMcpServers(sessionId: string, names: readonly string[] | null): void {
    const session = this._findSession(sessionId)
    if (!session || session.readOnly || !isResidentLive(session)) return
    const next = names === null ? null : [...names]
    if (selectionEquals(session.mcpServerSelection.get(), next)) return
    // Session-scoped pin only: the default set for new sessions is governed
    // exclusively by the enablement overrides (IMcpServerEnablementService),
    // never by the latest picker choice.
    session.mcpServerSelection.set(next, undefined)
    this._telemetry.publicLog('acp.session_mcp_selection_changed', {
      agentId: session.agentId,
      inherit: next === null,
      count: next?.length ?? 0,
    })
    const sid = session.sessionIdOnAgent.get()
    if (sid !== undefined) this._history.setHistoryMcpServerNames(sid, next)
    if (session.isDormant.get()) {
      // The pin is persisted; making it take effect needs a `session/load`, so
      // wake the reclaimed process first. `_wireMcpDrift` would also converge
      // once the status flips back to idle — the explicit call just removes the
      // dependency on that autorun's ordering, and the attach-snapshot equality
      // guard in `_convergeMcpDrift` keeps the two from reloading twice.
      void session.ensureAwake().then(() => this._convergeMcpDrift(session))
      return
    }
    this._convergeMcpDrift(session)
  }

  /**
   * Subscribe a session for MCP drift: when the current selection diverges
   * from what the connection attached with (and the turn is not mid-flight),
   * seamlessly reload the session so the agent process restarts its MCP
   * servers with the new list. A drift surfacing while `running` simply waits
   * — the autorun re-fires when the status flips back to idle.
   */
  private _wireMcpDrift(session: AcpSession): void {
    this._register(
      autorun((r) => {
        const selection = session.mcpServerSelection.read(r)
        const status = session.status.read(r)
        const sid = session.sessionIdOnAgent.read(r)
        const replaying = session.isReplayingHistory.read(r)
        if (sid === undefined || status === 'closed') return
        if (session.readOnly) return
        // Mid-replay the session is attached but its history is still loading;
        // reloading now would race the replay. The autorun re-fires when
        // endHistoryReplay flips this back.
        if (replaying) return
        if (status !== 'idle') return
        const attached = this._mcpSelectionAtAttach.get(session.id)
        if (selectionEquals(attached ?? null, selection)) return
        this._convergeMcpDrift(session)
      }),
    )
  }

  private _convergeMcpDrift(session: IAcpSession): void {
    const sid = session.sessionIdOnAgent.get()
    if (sid === undefined) {
      // Still connecting: `_connectSession` snapshots the pin at the moment
      // session/new is issued; a change made afterwards is caught by the
      // drift autorun once the session attaches. Nothing to do here.
      return
    }
    if (session.status.get() !== 'idle' || session.isReplayingHistory.get()) return
    const attached = this._mcpSelectionAtAttach.get(session.id)
    const selection = session.mcpServerSelection.get()
    // Both callers re-check the snapshot: the drift autorun fires on the
    // explicit change itself (attached still holds the pre-change pin), and a
    // 'drift' converge unconditionally reloading alongside the 'explicit' one
    // double-reloads the session — the close+resume pair races itself.
    if (!selectionEquals(attached ?? null, selection)) {
      void this._reloadSessionForMcpChange(session)
    }
  }

  /**
   * Seamless MCP reload: close the live session and immediately resume it via
   * `session/load`. The agent forks detect the changed `mcpServers` fingerprint
   * and recreate the underlying session process with the new MCP set, replaying
   * the conversation — the user keeps the timeline, the MCP servers restart.
   * We warn up front because the restart invalidates the model's prompt cache,
   * making the next turn slower (and, on metered plans, pricier).
   */
  private async _reloadSessionForMcpChange(session: IAcpSession): Promise<void> {
    const sid = session.sessionIdOnAgent.get()
    if (sid === undefined || this._mcpReloadingSessions.has(sid)) return
    this._mcpReloadingSessions.add(sid)
    try {
      this._notification.notify({
        severity: Severity.Info,
        message: localize(
          'acp.mcp.reloading',
          'MCP servers changed — restarting the session to apply. This invalidates the model prompt cache, so the next turn may be slower.',
        ),
      })
      this._telemetry.publicLog('acp.session_mcp_reload', { agentId: session.agentId })
      this._logger.info(`reloading session ${sid} to apply MCP server changes`)
      // The reload swaps the session object (and, for a non-empty session, its
      // local id). Rescue the unsent prompt draft before closeSession wipes it
      // so the remounted input restores what the user had typed.
      const draft = AcpPromptDraftCache.load(session.id)
      // An empty session (created but never messaged) was never persisted by
      // the agent, so session/load cannot revive it — replace it with a fresh
      // session pinned to the new selection instead of resuming the old one.
      const entry = this._history.get(sid)
      if (entry?.hasMessages === false) {
        const pin = session.mcpServerSelection.get()
        const title = session.title
        await this.closeSession(sid)
        this._history.remove(entry.id)
        this._sessionFactory.messageAttachments.removeSession(entry.id)
        const fresh = await this.createSession(session.agentId, {
          title,
          ...(pin !== null ? { mcpServerNames: pin } : {}),
          // createSession seeds this under the new id BEFORE activation — the
          // prompt input reads the draft cache once at mount, so handing it
          // over afterwards would be too late.
          ...(draft !== undefined ? { promptDraft: draft } : {}),
        })
        // The title override is unlocked, so a user-chosen (manual) title must
        // be re-locked to keep its protection against auto titles.
        if (entry.manualTitle === true) fresh.renameTitle(title)
        this.setActive(fresh.id)
        return
      }
      await this.closeSession(sid)
      // A resumed session is keyed by the agent id (id === sid), so the draft
      // can be re-seeded up front — before resumeSession registers (and
      // activates) the session, which is what mounts the prompt input.
      if (draft !== undefined) AcpPromptDraftCache.save(sid, draft)
      const resumed = await this.resumeSession(sid)
      this.setActive(resumed.id)
    } catch (err) {
      this._logger.warn(`MCP session reload failed: ${(err as Error).message}`)
      this._notification.notify({
        severity: Severity.Error,
        message: localize('acp.mcp.reloadFailed', 'Failed to restart the session: {message}', {
          message: (err as Error).message,
        }),
      })
    } finally {
      this._mcpReloadingSessions.delete(sid)
    }
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
      message: localize(
        'acp.mcpTransportUnsupported',
        '{agent} does not support the configured MCP transport for {names}; these servers were skipped.',
        { agent: agentName, names },
      ),
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

/** Order-sensitive equality for two selection values (`null` = inherit). */
function selectionEquals(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

/**
 * Normalize an MCP status payload (claude's system-init `mcp_servers` or the
 * codex fork's `_universe/mcp_server_status` `servers`) into the shape
 * {@link AcpSession.applyMcpServerSnapshot} accepts, dropping malformed entries.
 */
function readMcpServerStatuses(raw: readonly unknown[]): Array<{ name: string; status: string }> {
  return raw
    .filter((s): s is { name: string; status: string } => {
      if (s == null || typeof s !== 'object') return false
      const o = s as { name?: unknown; status?: unknown }
      return typeof o.name === 'string' && typeof o.status === 'string'
    })
    .map((s) => ({ name: s.name, status: s.status }))
}

function messageIdsThrough(
  messages: readonly { readonly role: string; readonly messageId?: string }[],
  anchorMessageId?: string,
): readonly string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' || message.messageId === undefined) continue
    ids.push(message.messageId)
    if (anchorMessageId !== undefined && message.messageId === anchorMessageId) return ids
  }
  return anchorMessageId === undefined ? ids : []
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
