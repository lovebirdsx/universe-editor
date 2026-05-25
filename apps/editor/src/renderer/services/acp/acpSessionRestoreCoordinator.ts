/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionRestoreCoordinator — owns the bootstrap-time + workspace-swap
 *  restore protocol for the ACP session facade:
 *
 *    - persists/restores the previously-active historyId across editor launches
 *    - runs `session/list` against each known agent to surface CLI-created
 *      sessions in the sidebar
 *    - relays `session/delete` requests, with capability-aware fallback
 *
 *  Extracted from AcpSessionService so the facade stays focused on session
 *  registration + observable aggregation. The coordinator only knows the
 *  facade through three callbacks (resume / hasActive / getCwd).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  ILoggerService,
  INotificationService,
  ITelemetryService,
  Severity,
  StorageScope,
  arePathsEqual,
  type HostPlatform,
  type ILogger,
} from '@universe-editor/platform'
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type DeleteSessionRequest,
  type InitializeRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
} from '@agentclientprotocol/sdk'
import type {
  IAcpClientService,
  IAcpClientConnection,
  IAcpClientNotificationSink,
} from './acpClientService.js'
import type { IAcpAgentRegistry } from './acpAgentRegistry.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpSession } from './acpSession.js'

export const ACP_ACTIVE_SESSION_STORAGE_KEY = 'acp.activeSessionHistoryId'

/** Page cap for the hydrate sweep — 5 pages × default page size keeps cold-start latency bounded even on big histories. */
const HYDRATE_MAX_PAGES = 5
/** Per-agent timeout for the initialize+listSessions roundtrip. */
const HYDRATE_TIMEOUT_MS = 10_000

/**
 * Notification sink for listing-only connections. These connections live just
 * long enough to call `initialize` + `listSessions` and then dispose, so they
 * should never receive `session/update` or `session/request_permission`. We
 * still need a real implementation because `IAcpClientService.connect` requires
 * one — refuse permissions and drop updates on the floor.
 */
const NULL_SINK: IAcpClientNotificationSink = {
  onSessionUpdate: () => {},
  onRequestPermission: async (
    _params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
}

export interface RestoreCoordinatorCallbacks {
  /** Resume a session by historyId — facade's `resumeSession`. */
  resumeSession(historyId: string): Promise<IAcpSession>
  /** True if a session is currently active — facade's `activeSessionId.get() !== undefined`. */
  hasActiveSession(): boolean
  /** Current workspace cwd, used for hydrate scoping. */
  getCurrentCwd(): string | undefined
  /**
   * Resolves once the workspace service has finished its initial hydration.
   * `requestHydrate()` awaits this before reading `getCurrentCwd()` so the
   * first sweep does not race the renderer's IPC roundtrip and end up
   * passing `cwd: null` to `session/list` (which agents treat as "no filter"
   * and return sessions across all workspaces).
   */
  whenWorkspaceReady(): Promise<void>
  /**
   * Snapshot of currently-live session historyIds. Used by the
   * user-initiated refresh path to protect live sessions from being pruned
   * when an agent's `session/list` response does not yet include them
   * (e.g. a session that was just created and hasn't been persisted on the
   * agent side yet).
   */
  getLiveHistoryIds(): ReadonlySet<string>
}

export class AcpSessionRestoreCoordinator extends Disposable {
  /**
   * Workspace-persisted historyId of the previously-active session, captured on
   * startup and consumed by `tryRestoreActiveSession()` once. Cleared after the
   * first successful (or attempted) restore so the autorun-driven persistence
   * loop doesn't keep re-firing the lazy resume.
   */
  private _pendingRestoreHistoryId: string | undefined
  /**
   * Resolves once `_loadPendingRestore()` has hydrated `_pendingRestoreHistoryId`.
   * Mutable so we can re-run the restore after a workspace swap pulls in a
   * different `acp.activeSessionHistoryId` from the new bucket.
   */
  private _loadPendingRestorePromise: Promise<void> = Promise.resolve()

  /**
   * Generation token for `_hydrateHistoryFromAgents`. Workspace swaps and
   * back-to-back hydrate triggers increment this; in-flight calls capture
   * `myGen` at entry and drop their results when it no longer matches —
   * race-safe against user A→B→A flips where cwd strings would alias.
   */
  private _hydrateGen = 0
  /**
   * cwd of the last successful hydrate. `requestHydrate()` is a no-op when it
   * matches the current cwd (idempotency); workspace swaps reset this back to
   * `undefined` so the next visibility trigger re-hydrates the new bucket.
   */
  private _hydratedForCwd: string | undefined
  /**
   * In-flight hydrate promise, so concurrent `requestHydrate()` calls dedupe
   * onto the same sweep instead of spawning N agent subprocesses in parallel.
   */
  private _hydrateInFlight: Promise<void> | undefined
  /**
   * Capability snapshot per agentId, refreshed every time the hydrate sweep
   * finishes a connection's `initialize`. Read by `deleteOnAgent` to decide
   * whether to attempt `unstable_deleteSession` or fall back to local-only.
   */
  private readonly _agentCaps = new Map<string, AgentCapabilities>()

  private readonly _logger: ILogger

  constructor(
    private readonly _client: IAcpClientService,
    private readonly _registry: IAcpAgentRegistry,
    private readonly _history: IAcpSessionHistoryService,
    private readonly _storage: IStorageService,
    private readonly _notification: INotificationService,
    private readonly _telemetry: ITelemetryService,
    loggerService: ILoggerService,
    private readonly _platform: HostPlatform,
    private readonly _callbacks: RestoreCoordinatorCallbacks,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'acpSessionRestore',
      name: 'ACP Session Restore',
    })
  }

  /** Kick off bootstrap-time restore. Fire-and-forget. */
  start(): void {
    this._loadPendingRestorePromise = this._loadPendingRestore()
  }

  /**
   * Called by the facade after it has cleared its own observable state and
   * closed all live sessions on a workspace swap. We re-load the pending
   * restore id from the new bucket and reset hydrate state — the next time
   * the Agents view becomes visible, `requestHydrate()` will re-sweep the
   * new cwd. In-flight hydrates from the old cwd are aborted via
   * `_hydrateGen`.
   */
  async onWorkspaceSwap(): Promise<void> {
    this._pendingRestoreHistoryId = undefined
    this._hydratedForCwd = undefined
    this._hydrateInFlight = undefined
    this._hydrateGen++
    this._loadPendingRestorePromise = this._loadPendingRestore()
    await this._loadPendingRestorePromise
    void this.tryRestoreActiveSession()
  }

  /**
   * Lazy hydrate trigger. Wired to the Agents view visibility autorun so the
   * `session/list` sweep — which spawns a `claude-code` subprocess inside
   * the workspace cwd — only runs when the user actually opens the Agents
   * UI. Idempotent per cwd; concurrent calls dedupe onto the same in-flight
   * promise. Fire-and-forget by design.
   */
  requestHydrate(): void {
    if (this._hydrateInFlight) return
    void this._kickHydrate(false)
  }

  /**
   * User-initiated refresh. Bypasses the `_hydratedForCwd` idempotency gate so
   * repeated clicks actually re-run `session/list` against each agent, and
   * also flips the hydrate sweep into "replace" mode so stale local entries
   * the agent no longer reports get pruned (live sessions are protected via
   * `getLiveHistoryIds`). Still shares `_hydrateInFlight` for concurrent
   * dedup — back-to-back clicks collapse onto the same sweep instead of
   * spawning N subprocesses.
   */
  refresh(): Promise<void> {
    this._hydratedForCwd = undefined
    if (this._hydrateInFlight) return this._hydrateInFlight
    return this._kickHydrate(true)
  }

  private _kickHydrate(replace: boolean): Promise<void> {
    const run = (async () => {
      await this._callbacks.whenWorkspaceReady()
      const cwd = this._callbacks.getCurrentCwd()
      if (cwd === undefined) return
      if (arePathsEqual(this._hydratedForCwd, cwd, this._platform)) return
      try {
        await this._hydrateHistoryFromAgents(cwd, replace)
        if (arePathsEqual(this._callbacks.getCurrentCwd(), cwd, this._platform)) {
          this._hydratedForCwd = cwd
        }
      } catch (err) {
        this._logger.warn(`hydrate failed: ${(err as Error).message}`)
      }
    })()
    this._hydrateInFlight = run.finally(() => {
      this._hydrateInFlight = undefined
    })
    return this._hydrateInFlight
  }

  async tryRestoreActiveSession(): Promise<void> {
    await this._loadPendingRestorePromise
    if (this._pendingRestoreHistoryId === undefined) return
    if (this._callbacks.hasActiveSession()) {
      // User already created/switched a session — drop the pending restore so
      // the autorun-driven persist stays in sync with the live active session.
      this._pendingRestoreHistoryId = undefined
      return
    }
    // History is loaded fire-and-forget at bootstrap; wait for it before
    // looking up the entry so the very first call after restart still works.
    try {
      await this._history.initialize()
    } catch {
      // best-effort
    }
    // Claim the pending id before awaiting resume so concurrent triggers
    // (e.g. autorun firing twice for visibility + active container) restore once.
    const historyId = this._pendingRestoreHistoryId
    this._pendingRestoreHistoryId = undefined
    try {
      await this._callbacks.resumeSession(historyId)
    } catch (err) {
      this._logger.warn(`tryRestoreActiveSession failed: ${(err as Error).message}`)
    }
  }

  async deleteOnAgent(historyId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
    const entry = this._history.get(historyId)
    if (!entry) return 'unknown'
    const caps = this._agentCaps.get(entry.agentId)
    if (caps?.sessionCapabilities?.delete == null) return 'unsupported'
    const cwd = entry.cwd
    let conn: IAcpClientConnection | undefined
    try {
      conn = await this._client.connect(entry.agentId, NULL_SINK, cwd !== undefined ? { cwd } : {})
      const initParams: InitializeRequest = {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }
      await withTimeout(
        conn.conn.initialize(initParams),
        HYDRATE_TIMEOUT_MS,
        'ACP delete initialize',
      )
      const params: DeleteSessionRequest = { sessionId: entry.sessionIdOnAgent }
      await withTimeout(
        conn.conn.unstable_deleteSession(params),
        HYDRATE_TIMEOUT_MS,
        'ACP session/delete',
      )
      this._telemetry.publicLog('acp.session_delete_ok', { agentId: entry.agentId })
      return 'ok'
    } catch (err) {
      this._logger.warn(`deleteOnAgent failed: ${(err as Error).message}`)
      this._telemetry.publicLogError('acp.session_delete_failed', {
        agentId: entry.agentId,
        error: (err as Error).message,
      })
      return 'error'
    } finally {
      if (conn) conn.dispose()
    }
  }

  /** Surface load/restore failures via a user notification (caller decides when). */
  notifyFailure(message: string): void {
    this._notification.notify({ severity: Severity.Error, message })
  }

  private async _loadPendingRestore(): Promise<void> {
    try {
      const historyId = await this._storage.get<string>(
        ACP_ACTIVE_SESSION_STORAGE_KEY,
        StorageScope.WORKSPACE,
      )
      if (typeof historyId === 'string' && historyId.length > 0) {
        this._pendingRestoreHistoryId = historyId
      }
    } catch (err) {
      this._logger.warn(`failed to read pending restore: ${(err as Error).message}`)
    }
  }

  /**
   * Per-agent: spawn a short-lived ACP connection, call `initialize` to learn
   * capabilities, and — if the agent advertises `sessionCapabilities.list` —
   * walk `session/list` to discover sessions we don't have local rows for.
   *
   * All errors are swallowed: listing failures must never break the editor's
   * createSession / resumeSession / closeSession paths. The local
   * IStorageService-backed history remains the fallback source of truth.
   *
   * Generation-token pattern (`_hydrateGen`): each call increments the
   * counter, captures `myGen`, and aborts if the counter has moved on by the
   * time the async result lands. This is race-safe against workspace
   * A→B→A flips where a naive cwd-string comparison would alias.
   */
  private async _hydrateHistoryFromAgents(
    cwd: string | undefined,
    replace: boolean,
  ): Promise<void> {
    const myGen = ++this._hydrateGen
    try {
      await this._history.initialize()
    } catch {
      // best-effort — proceed even if local hydrate is empty
    }
    if (myGen !== this._hydrateGen) return
    const agentIds = this._registry.allAgentIds()
    await Promise.all(
      agentIds.map((agentId) => this._hydrateOneAgent(agentId, cwd, myGen, replace)),
    )
  }

  private async _hydrateOneAgent(
    agentId: string,
    cwd: string | undefined,
    myGen: number,
    replace: boolean,
  ): Promise<void> {
    let conn: IAcpClientConnection | undefined
    try {
      conn = await this._client.connect(agentId, NULL_SINK, cwd !== undefined ? { cwd } : {})
      if (myGen !== this._hydrateGen) return
      const initParams: InitializeRequest = {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }
      const init = await withTimeout(
        conn.conn.initialize(initParams),
        HYDRATE_TIMEOUT_MS,
        'ACP hydrate initialize',
      )
      if (myGen !== this._hydrateGen) return
      this._agentCaps.set(agentId, init.agentCapabilities ?? {})
      const listCap = init.agentCapabilities?.sessionCapabilities?.list
      if (listCap == null) return
      const collected: SessionInfo[] = []
      let cursor: string | null | undefined
      for (let page = 0; page < HYDRATE_MAX_PAGES; page++) {
        const params: ListSessionsRequest = {
          cwd: cwd ?? null,
          ...(cursor !== undefined ? { cursor } : {}),
        }
        const resp: ListSessionsResponse = await withTimeout(
          conn.conn.listSessions(params),
          HYDRATE_TIMEOUT_MS,
          'ACP session/list',
        )
        if (myGen !== this._hydrateGen) return
        collected.push(...resp.sessions)
        cursor = resp.nextCursor ?? undefined
        if (!cursor) break
      }
      if (myGen !== this._hydrateGen) return
      // In replace mode we still call into history even when the agent
      // returned 0 sessions — that's a valid "the agent has nothing for this
      // workspace" signal and stale local rows should be pruned. In merge
      // mode we skip the empty case to avoid a wasted write+publish.
      if (replace) {
        this._history.replaceAgentEntries(
          agentId,
          collected,
          cwd,
          this._callbacks.getLiveHistoryIds(),
        )
      } else if (collected.length > 0) {
        this._history.bulkMergeFromAgent(agentId, collected, cwd)
      }
      this._logger.info(`hydrated ${collected.length} sessions from ${agentId} for cwd=${cwd}`)
      this._telemetry.publicLog('acp.session_hydrate_ok', {
        agentId,
        count: collected.length,
      })
    } catch (err) {
      this._logger.warn(`hydrate failed for ${agentId}: ${(err as Error).message}`)
      this._telemetry.publicLogError('acp.session_hydrate_failed', {
        agentId,
        error: (err as Error).message,
      })
    } finally {
      if (conn) conn.dispose()
    }
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
