/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ISubscriptionUsageService — owns the official-subscription usage snapshots
 *  (Claude's claude.ai plan windows, Codex's ChatGPT plan rate limits), keyed by
 *  agent id.
 *
 *  Two rules shape the design:
 *   1. Only the agent process can answer, so the data is read over an ACP
 *      ext-method on a session's EXISTING connection. This service never calls
 *      `IAcpClientService.connect()` — the pool stops an idle agent 30s after the
 *      last lease is released, and waking a child process just to read a status
 *      would defeat that. No live session ⇒ serve the cached snapshot, marked
 *      stale.
 *   2. Polling is slow (60s, vs the gateway readout's 10s) because every round
 *      trip reaches an agent child process. The claude fork already had to delete
 *      a per-turn `getContextUsage()` call for exactly this reason.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  Disposable,
  IConfigurationService,
  ILoggerService,
  IStorageService,
  IWorkspaceService,
  observableValue,
  StorageScope,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../acp/session/acpSessionService.js'
import { ACP_EXT_METHODS } from '../acp/session/acpExtMethods.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import {
  isStale as isSnapshotStale,
  normalizeSubscriptionUsage,
  type SubscriptionUsageSnapshot,
} from './subscriptionUsage.js'

/** Outcome of redeeming a rate-limit reset credit (codex). */
export type ResetCreditOutcome =
  | 'reset'
  | 'nothingToReset'
  | 'noCredit'
  | 'alreadyRedeemed'
  /** No live agent connection to ask — nothing was consumed. */
  | 'unavailable'
  /** The agent rejected or the round trip failed — nothing is known to be consumed. */
  | 'failed'

export interface ISubscriptionUsageService {
  readonly _serviceBrand: undefined
  /**
   * Latest snapshot for `agentId` — stable observable identity across calls, so
   * React components can subscribe directly. `undefined` until one has been read
   * (or restored from the previous run).
   */
  snapshotFor(agentId: string): IObservable<SubscriptionUsageSnapshot | undefined>
  /**
   * Read a fresh snapshot from a live session of `agentId`. Concurrent calls for
   * the same agent share one round trip. A no-op when the agent has already
   * answered "not a subscription" unless `force` is set (the user opening the
   * popover is a good reason to re-ask).
   */
  refresh(agentId: string, options?: { force?: boolean }): Promise<void>
  /** Whether a snapshot is past the configured freshness window, or its windows rolled over. */
  isStale(snapshot: SubscriptionUsageSnapshot | undefined, now?: number): boolean
  /**
   * Redeem the next available rate-limit reset credit (codex). `idempotencyKey`
   * identifies ONE user-confirmed attempt: retrying a transient failure must
   * reuse the same key, or the retry burns a second credit. `alreadyRedeemed`
   * therefore counts as success.
   */
  consumeResetCredit(agentId: string, idempotencyKey: string): Promise<ResetCreditOutcome>
}

export const ISubscriptionUsageService = createDecorator<ISubscriptionUsageService>(
  'subscriptionUsageService',
)

const STORAGE_KEY_PREFIX = 'acp.subscriptionUsage'
const STALE_AFTER_KEY = 'acp.subscriptionUsage.staleAfterMs'
const REFRESH_INTERVAL_KEY = 'acp.subscriptionUsage.refreshIntervalMs'
const DEFAULT_STALE_AFTER_MS = 10 * 60_000
const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 15_000

const RESET_CREDIT_OUTCOMES: ReadonlySet<string> = new Set([
  'reset',
  'nothingToReset',
  'noCredit',
  'alreadyRedeemed',
])

type PersistedSnapshots = Record<string, SubscriptionUsageSnapshot>

export class SubscriptionUsageService extends Disposable implements ISubscriptionUsageService {
  declare readonly _serviceBrand: undefined

  private readonly _snapshots = new Map<
    string,
    ISettableObservable<SubscriptionUsageSnapshot | undefined>
  >()
  private readonly _inflight = new Map<string, Promise<void>>()
  /**
   * Agents that answered "no subscription readout here" — polled no further.
   * The verdict belongs to the ACCOUNT that answered, not to the agent, so it is
   * dropped again whenever a new session appears (see the autorun below).
   */
  private readonly _unsupported = new Set<string>()
  /** Session ids already accounted for, so a new one is recognizable. */
  private _seenSessionIds = new Set<string>()
  private readonly _logger: ILogger

  private _intervalTimer: ReturnType<typeof setInterval> | undefined
  private _restored: Promise<void>

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'subscriptionUsage',
      name: 'Subscription Usage',
    })
    this._restored = this._restore()

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this._stopPolling()
      } else {
        void this._tick()
        this._restartPolling()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    this._register({
      dispose: () => document.removeEventListener('visibilitychange', onVisibility),
    })

    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(REFRESH_INTERVAL_KEY)) this._restartPolling()
      }),
    )

    // Switching local ↔ remote changes which host's account answers, so the
    // cached snapshots belong to a different bucket entirely — drop everything
    // (including the "unsupported" verdicts) and re-read from the new bucket.
    this._register(
      this._workspace.onDidChangeWorkspace(() => {
        this._unsupported.clear()
        for (const observable of this._snapshots.values()) observable.set(undefined, undefined)
        this._restored = this._restore()
        void this._restored.then(() => this._tick())
      }),
    )

    // A "not a subscription" verdict is only true for the account that answered
    // it. Someone who logs in to claude.ai / ChatGPT gets a fresh agent process,
    // and its first session is our cue to ask again — otherwise the indicator
    // would stay hidden for the rest of the window's life, with the only
    // re-probe path (the popover's forced refresh) living inside the very
    // popover that no longer renders.
    this._register(
      autorun((reader) => {
        const sessions = this._sessions.sessions.read(reader)
        const live = new Set<string>()
        const reprobe = new Set<string>()
        for (const session of sessions) {
          live.add(session.id)
          if (!this._seenSessionIds.has(session.id) && this._unsupported.delete(session.agentId)) {
            reprobe.add(session.agentId)
          }
        }
        // Closed sessions drop out, keeping this bounded by the live set.
        this._seenSessionIds = live
        for (const agentId of reprobe) void this.refresh(agentId)
      }),
    )

    void this._restored.then(() => this._tick())
    this._restartPolling()
  }

  snapshotFor(agentId: string): IObservable<SubscriptionUsageSnapshot | undefined> {
    return this._observableFor(agentId)
  }

  isStale(snapshot: SubscriptionUsageSnapshot | undefined, now = Date.now()): boolean {
    return isSnapshotStale(snapshot, now, this._staleAfterMs())
  }

  async refresh(agentId: string, options?: { force?: boolean }): Promise<void> {
    if (options?.force === true) this._unsupported.delete(agentId)
    else if (this._unsupported.has(agentId)) return

    const pending = this._inflight.get(agentId)
    if (pending !== undefined) return pending

    const run = this._fetch(agentId).finally(() => {
      this._inflight.delete(agentId)
    })
    this._inflight.set(agentId, run)
    return run
  }

  async consumeResetCredit(agentId: string, idempotencyKey: string): Promise<ResetCreditOutcome> {
    const session = this._liveSessionFor(agentId)
    if (session === undefined) return 'unavailable'
    // Redeeming is an explicit click, so unlike the polling path above it is
    // worth waking a session the idle reaper put to sleep — `requestExtMethod`
    // never opens a connection and would just report 'unavailable'.
    if ((await session.ensureAwake()) !== 'ready') return 'unavailable'
    try {
      const raw = await session.requestExtMethod<Record<string, unknown>>(
        ACP_EXT_METHODS.consumeResetCredit,
        { idempotencyKey },
      )
      if (raw === undefined) return 'unavailable'
      const outcome = raw['outcome']
      this._logger.info(`consumeResetCredit(${agentId}) -> ${String(outcome)}`)
      if (typeof outcome === 'string' && RESET_CREDIT_OUTCOMES.has(outcome)) {
        // The window may have moved; re-read so the UI reflects the redemption.
        void this.refresh(agentId, { force: true })
        return outcome as ResetCreditOutcome
      }
      return 'failed'
    } catch (error) {
      this._logger.error(`consumeResetCredit(${agentId}) failed: ${String(error)}`)
      return 'failed'
    }
  }

  override dispose(): void {
    this._stopPolling()
    super.dispose()
  }

  private _observableFor(
    agentId: string,
  ): ISettableObservable<SubscriptionUsageSnapshot | undefined> {
    let observable = this._snapshots.get(agentId)
    if (observable === undefined) {
      observable = observableValue<SubscriptionUsageSnapshot | undefined>(
        `subscriptionUsage:${agentId}`,
        undefined,
      )
      this._snapshots.set(agentId, observable)
    }
    return observable
  }

  private _storageKey(): string {
    const authority = currentRemoteAuthority(this._workspace.current)
    // The account answering is the agent host's, so a remote window must not
    // read the local window's cache (or vice versa).
    return authority === undefined ? STORAGE_KEY_PREFIX : `${STORAGE_KEY_PREFIX}.${authority}`
  }

  private async _restore(): Promise<void> {
    try {
      const stored = await this._storage.get<PersistedSnapshots>(
        this._storageKey(),
        StorageScope.GLOBAL,
      )
      if (stored === undefined || stored === null || typeof stored !== 'object') return
      for (const [agentId, snapshot] of Object.entries(stored)) {
        if (snapshot === null || typeof snapshot !== 'object') continue
        if (!Array.isArray(snapshot.windows) || typeof snapshot.fetchedAt !== 'number') continue
        // A truncated write or an older shape would otherwise reach the UI as
        // NaN percentages.
        if (
          !snapshot.windows.every(
            (window) =>
              typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent),
          )
        ) {
          continue
        }
        // Only seed an empty slot: a snapshot read this session is authoritative.
        const observable = this._observableFor(agentId)
        if (observable.get() === undefined) observable.set(snapshot, undefined)
      }
    } catch (error) {
      this._logger.warn(`failed to restore cached snapshots: ${String(error)}`)
    }
  }

  private async _persist(): Promise<void> {
    const payload: PersistedSnapshots = {}
    for (const [agentId, observable] of this._snapshots) {
      const snapshot = observable.get()
      if (snapshot !== undefined) payload[agentId] = snapshot
    }
    try {
      await this._storage.set(this._storageKey(), payload, StorageScope.GLOBAL)
    } catch (error) {
      this._logger.warn(`failed to persist snapshots: ${String(error)}`)
    }
  }

  private _staleAfterMs(): number {
    const value = this._configuration.get<number>(STALE_AFTER_KEY)
    return typeof value === 'number' && value > 0 ? value : DEFAULT_STALE_AFTER_MS
  }

  private _intervalMs(): number {
    const value = this._configuration.get<number>(REFRESH_INTERVAL_KEY)
    return typeof value === 'number' && value >= MIN_INTERVAL_MS ? value : DEFAULT_INTERVAL_MS
  }

  private _restartPolling(): void {
    this._stopPolling()
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    this._intervalTimer = setInterval(() => void this._tick(), this._intervalMs())
  }

  private _stopPolling(): void {
    if (this._intervalTimer !== undefined) {
      clearInterval(this._intervalTimer)
      this._intervalTimer = undefined
    }
  }

  /** Refresh every agent that currently has a live session — never wake a stopped one. */
  private async _tick(): Promise<void> {
    const agentIds = new Set(this._sessions.sessions.get().map((session) => session.agentId))
    await Promise.all([...agentIds].map((agentId) => this.refresh(agentId)))
  }

  /**
   * Ride along on any live session of `agentId`. `requestExtMethod` answers
   * `undefined` when there is no connection, which is the "keep the cached
   * snapshot, let the UI mark it stale" path — not an error.
   *
   * Read-only foreign previews are skipped: they can never wake (spawning
   * against another worktree is exactly what they exist to avoid), so handing
   * one to the redeem path would make it look permanently unavailable while a
   * perfectly wakeable session sat later in the list.
   */
  private _liveSessionFor(agentId: string): IAcpSession | undefined {
    return this._sessions.sessions
      .get()
      .find((session) => session.agentId === agentId && !session.readOnly)
  }

  private async _fetch(agentId: string): Promise<void> {
    const session = this._liveSessionFor(agentId)
    if (session === undefined) return
    let raw: unknown
    try {
      raw = await session.requestExtMethod(ACP_EXT_METHODS.subscriptionUsage)
    } catch (error) {
      // methodNotFound from an agent that doesn't implement it, or a transient
      // failure. Either way stop polling it; the popover can force a re-ask.
      this._unsupported.add(agentId)
      this._logger.info(`subscription usage unavailable for ${agentId}: ${String(error)}`)
      return
    }
    if (raw === undefined) return

    const snapshot = normalizeSubscriptionUsage(agentId, raw, Date.now())
    if (snapshot === undefined) {
      this._unsupported.add(agentId)
      this._logger.info(`${agentId} reports no subscription usage (gateway / API key session)`)
      // A previously-cached snapshot is no longer true for this account.
      this._observableFor(agentId).set(undefined, undefined)
      void this._persist()
      return
    }
    this._logger.trace(
      `${agentId} usage: ${snapshot.windows.map((w) => `${w.id}=${w.usedPercent}%`).join(' ')}`,
    )
    this._observableFor(agentId).set(snapshot, undefined)
    void this._persist()
  }
}
