/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Raises an OS-level desktop notification when a new review appears in the Swarm
 *  "Needs My Action" list while the editor window is blurred. Mirrors
 *  AgentNotificationContribution: focus gating lives main-side, clicking jumps to
 *  the review (single) or the Swarm Reviews view (several). When the OS toast is
 *  gated away (window focused / notifications unsupported) it falls back to an
 *  in-app notification instead — the rising edge is consumed either way, so
 *  dropping it silently would lose the review's one chance to notify.
 *
 *  The notification is driven by the list *as finally displayed* — the same
 *  author / approvable-only filters (swarmReviewFilter) and the client-side ignore
 *  set (swarmIgnoreStore) the sidebar view applies — minus the transient keyword
 *  box, which is a lookup, not a scope. Polling is driven primarily by the perforce
 *  extension host's timer (via `_workbench.swarmPollTick`), which — unlike this
 *  renderer's own setInterval — Chromium never background-throttles, so new reviews
 *  surface even while the window sits in the background (and even when the
 *  only-mounts-while-visible view is closed). The renderer timer remains as a
 *  foreground-only backstop.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  ICommandService,
  IConfigurationService,
  IHostService,
  ILoggerService,
  INotificationService,
  IStorageService,
  IWorkbenchContribution,
  IWorkspaceService,
  Severity,
  localize,
  type ILogger,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmReviewDto,
  type SwarmTransitionDto,
} from '@universe-editor/extensions-common'
import { swarmIgnoreStore, splitIgnored } from '../services/swarm/swarmIgnoreStore.js'
import {
  requestSwarmReviewsRefresh,
  swarmNeedsActionCount,
  swarmReviewsViewState,
} from '../services/swarm/swarmViewState.js'
import { filterNeedsAction, readSwarmFilterConfig } from '../services/swarm/swarmReviewFilter.js'
import { swarmNotificationE2E } from '../services/swarm/swarmNotificationE2E.js'
import { setSwarmNotificationTickHandler } from '../services/swarm/swarmNotificationTick.js'
import { OpenSwarmReviewAction, OpenSwarmReviewsAction } from '../actions/swarmActions.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

const POLL_INTERVAL_MS = 60_000

/** Ceiling for one dashboard RPC before the poll declares it wedged. The host's
 *  own worst case is ~2 credential probes (15s each) plus one fetch (30s), so
 *  120s only fires when something below the RPC never settles at all — the
 *  44-minute wedge, where a hung p4 spawn held the whole chain before any HTTP
 *  happened and every later tick was dropped on the `_running` latch. */
const DASHBOARD_DEADLINE_MS = 120_000
/** Same defense for each per-review transitions lookup. */
const TRANSITIONS_DEADLINE_MS = 60_000

/** Phase-timing elevation threshold. A healthy poll's dashboard phase settles in
 *  seconds (host fetch timeout is 30s); anything past this points at the same
 *  hung-host class the deadlines guard against, so the phase line is raised to
 *  info (visible at the default log level) instead of debug. */
const SLOW_PHASE_MS = 30_000

/** Marker error so callers can tell a deadline rejection apart from an RPC failure. */
class DeadlineError extends Error {}

/** Race a promise against a wall-clock deadline. The renderer↔host RPC has no
 *  global timeout (and a hung host handler neither resolves nor rejects), so
 *  without this a single wedged call holds its caller — here the poll latch —
 *  forever. The loser keeps running in the background; its settlement is still
 *  observed (and ignored) by the handlers below, so no unhandled rejection. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineError(`${label} did not settle within ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** Master switch for the whole background poll (badge + notifications + status
 *  bar count). Off by default: the reviews list still refreshes on open and via
 *  its manual Refresh button, but nothing polls while the view sits closed. */
const BACKGROUND_POLL_CONFIG_KEY = 'perforce.swarm.backgroundPoll.enabled'

/** The host-side `setBackgroundPoll` command registers a few seconds after this
 *  contribution (extension-host activation race). Retry the push with the same
 *  250ms x20 backoff pattern as SwarmReviewsView.load instead of dropping it —
 *  the host driver's configured/enabled/interval state would otherwise stay
 *  wrong until the next configuration change. */
const PUSH_RETRY_DELAY_MS = 250
const PUSH_RETRY_LIMIT = 20

export class SwarmReviewNotificationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _timer: ReturnType<typeof setInterval> | undefined
  private _running = false
  /** Ids that were actionable on the last poll; drives rising-edge notifications. */
  private _known = new Set<string>()
  /** First poll only primes the baseline (avoids a startup burst of notifications). */
  private _primed = false
  /** Last time a poll cycle reached the dashboard successfully. Drives the
   *  visibilitychange catch-up tick. */
  private _lastSuccessfulPollAt = Date.now()
  /** Last time the host-driven tick handler fired. Drives the tick-gap log. */
  private _lastTickAt = Date.now()
  /** Fingerprint of the last poll's counts (actionable + per-filter drops). A
   *  changed fingerprint raises `poll ok` to info, so filter-layer suppression
   *  shows up in the log at the default level — the fifth silent-notification
   *  incident stayed invisible behind a debug-only "N actionable" line. */
  private _lastPollCounts: string | undefined
  private _pushRetryTimer: ReturnType<typeof setTimeout> | undefined
  private _pushRetryAttempt = 0
  private readonly _logger: ILogger

  constructor(
    @ICommandService private readonly _commands: ICommandService,
    @IHostService private readonly _host: IHostService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IStorageService storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @INotificationService private readonly _notification: INotificationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'swarmNotify', name: 'Swarm Notifications' })
    // The ignore set feeds the "final displayed" computation; attach is idempotent
    // (the view / detail tab / view contribution may already have attached it).
    void swarmIgnoreStore.attach(storage)

    // The primary poll driver is the perforce extension host's timer, which invokes
    // `_workbench.swarmPollTick` → this handler. The host runs in a Node child
    // process Chromium never background-throttles, so it keeps ticking while the
    // window sits in the background — where the renderer's own setInterval below
    // freezes (the reason notifications never fired overnight). The renderer timer
    // stays as a foreground-only backstop (and covers windows whose perforce host
    // isn't driving ticks); refresh() is serialized + de-duped so both driving it
    // is harmless.
    setSwarmNotificationTickHandler(() => {
      // Gap detection: the host driver fires on a fixed interval, so ticks
      // arriving more than 3x apart mean the chain stalled somewhere (host
      // driver wedged, or this renderer was background-throttled). Zero noise
      // in the steady state, direct evidence of the stall duration otherwise.
      const now = Date.now()
      const gapMs = now - this._lastTickAt
      this._lastTickAt = now
      if (gapMs > 3 * this._pollIntervalMs()) {
        this._logger.info(
          `tick gap ${Math.round(gapMs / 1000)}s (host driver stalled or renderer was throttled)`,
        )
      }
      // The tick itself proves the perforce host's command surface is alive, so
      // if the polling-state push exhausted its retry budget earlier (a cold
      // host can take longer than the 5s the backoff covers), redo it now —
      // otherwise the host driver keeps running on a stale enabled/interval
      // snapshot until the next configuration change.
      if (this._pushRetryAttempt >= PUSH_RETRY_LIMIT) {
        this._logger.info(
          'host tick arrived after push retries were exhausted — re-pushing polling state',
        )
        this._pushRetryAttempt = 0
        this._pushPollingState()
      }
      return this.refresh()
    })

    this._register({ dispose: () => this._stop() })
    // Coarse-grained on purpose: the pushed snapshot (enabled switch + interval +
    // configured flag) reads several `perforce.swarm.*` keys, so re-push on any
    // change under that section (changes are rare; the push is one RPC).
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('perforce.swarm')) this._syncPolling()
      }),
    )
    // Catch-up tick on window foregrounding: when the renderer was
    // background-throttled (or the host tick chain wedged) long enough that no
    // poll succeeded for over an interval, refreshing on `visible` turns
    // "reviews appear the moment the user comes back" from a throttling side
    // effect into an explicit guarantee.
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return
        const elapsedMs = Date.now() - this._lastSuccessfulPollAt
        if (elapsedMs > this._pollIntervalMs()) {
          this._logger.info(
            `window visible after ${Math.round(elapsedMs / 1000)}s without a successful poll → catch-up tick`,
          )
          void this.refresh()
        }
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      this._register({
        dispose: () => document.removeEventListener('visibilitychange', onVisibilityChange),
      })
    }
    // E2E: let a spec drive one poll synchronously (the 60s timer is far too slow
    // for a test, and the window is focused so the OS toast is gated away anyway).
    if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) {
      swarmNotificationE2E.driveRefresh = () => this.refresh()
    }
    this._syncPolling()
  }

  /** Start/stop the renderer backstop timer + prime, and push the polling
   *  snapshot to the host-side poll driver (which has no config-change event of
   *  its own). */
  private _syncPolling(): void {
    const enabled = this._pollEnabled()
    if (enabled && !this._timer) {
      this._logger.info('background poll enabled: backstop timer started, priming baseline')
      this._timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS)
      // Prime + start immediately so a review that appeared before launch doesn't
      // notify on first paint, but a genuinely new one during this session does.
      void this.refresh()
    } else if (!enabled && this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
      // Nothing will refresh the badge while polling is off — clear the stale count.
      swarmNeedsActionCount.set(0)
      this._logger.info('background poll disabled: backstop timer stopped')
    }
    this._pushPollingState()
  }

  /** Push the full polling snapshot to the host driver. `configured` mirrors the
   *  host's readSwarmConfig verdict (both sides read the same
   *  IConfigurationService, so they cannot diverge); `pollIntervalSeconds` is
   *  the RAW setting — the ms conversion (and the e2e env override) is
   *  host-side. When the host command isn't registered yet (activation race),
   *  retry with a bounded backoff instead of silently skipping. */
  private _pushPollingState(): void {
    if (!CommandsRegistry.getCommand(SwarmCommands.setBackgroundPoll)) {
      if (this._pushRetryTimer) return // a retry already reads the latest state when it fires
      if (this._pushRetryAttempt >= PUSH_RETRY_LIMIT) return
      this._pushRetryAttempt++
      if (this._pushRetryAttempt === PUSH_RETRY_LIMIT) {
        this._logger.warn(
          'setBackgroundPoll command still unregistered after 20 retries — host poll driver not synced',
        )
      }
      this._pushRetryTimer = setTimeout(() => {
        this._pushRetryTimer = undefined
        this._pushPollingState()
      }, PUSH_RETRY_DELAY_MS)
      return
    }
    this._pushRetryAttempt = 0
    void this._commands
      .executeCommand(SwarmCommands.setBackgroundPoll, {
        enabled: this._pollEnabled(),
        pollIntervalSeconds: this._config.get<number>('perforce.swarm.pollInterval') ?? 0,
        configured: this._swarmConfigured(),
      })
      .catch(() => {})
  }

  /** Same verdict as the host's readSwarmConfig: `perforce.swarm.enabled`
   *  (default true) and a non-empty `perforce.swarm.url` (default non-empty). */
  private _swarmConfigured(): boolean {
    const enabled = this._config.get<boolean>('perforce.swarm.enabled') ?? true
    const url = (
      this._config.get<string>('perforce.swarm.url') ?? 'http://swarm.aki.kuro.com/'
    ).trim()
    return enabled && url.length > 0
  }

  /** Renderer-side mirror of the host's resolveSwarmPollIntervalMs, minus the
   *  e2e env override (a host-process env the renderer cannot see — a slightly
   *  stale interval here only makes the visibility catch-up more conservative). */
  private _pollIntervalMs(): number {
    const seconds = this._config.get<number>('perforce.swarm.pollInterval') ?? 0
    return seconds > 0 ? Math.max(10, seconds) * 1000 : POLL_INTERVAL_MS
  }

  private _stop(): void {
    setSwarmNotificationTickHandler(undefined)
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
    }
    if (this._pushRetryTimer) {
      clearTimeout(this._pushRetryTimer)
      this._pushRetryTimer = undefined
    }
  }

  private _enabled(): boolean {
    return this._config.get<boolean>('perforce.swarm.notifications.enabled') ?? true
  }

  private _pollEnabled(): boolean {
    return this._config.get<boolean>(BACKGROUND_POLL_CONFIG_KEY) ?? false
  }

  /** Re-poll the dashboard and notify on newly-actionable reviews. Public so a test
   *  can drive it deterministically. Serialized: overlapping timer ticks are dropped. */
  async refresh(): Promise<void> {
    // Dropped ticks are the FIRST symptom of a wedged poll (a hung dashboard fetch
    // holds `_running` and every later tick lands here) — always visible in the log.
    if (this._running) {
      this._logger.info('poll tick dropped: previous refresh still running')
      return
    }
    if (!this._pollEnabled()) return
    // On a workspace without Perforce the command never registers; polling it
    // would only spam "command not found" every interval.
    if (!CommandsRegistry.getCommand(SwarmCommands.dashboard)) return
    this._running = true
    const startedAt = Date.now()
    let dashboardMs = 0
    let transitionsMs = 0
    try {
      // `force: true` bypasses the dashboard's 60s TTL cache: this poll is the
      // only thing driving new-review detection, so a stale cached list would
      // never surface a review that appeared within the window and we'd never
      // notify. (Mirrors the old status-bar poll, which also forced.)
      const dashboardStartedAt = Date.now()
      const dashboard = await withDeadline(
        this._commands.executeCommand<SwarmDashboardResult>(SwarmCommands.dashboard, {
          force: true,
        }),
        DASHBOARD_DEADLINE_MS,
        'dashboard RPC',
      )
      dashboardMs = Date.now() - dashboardStartedAt
      // `undefined` = the perforce extension host hasn't registered the command yet
      // (activation race). Skip this tick without disturbing the primed baseline.
      if (dashboard === undefined) return
      this._lastSuccessfulPollAt = Date.now()
      const transitionsStartedAt = Date.now()
      const { displayed, pool, authorFiltered, notApprovable, ignored } =
        await this._computeDisplayed(dashboard)
      transitionsMs = Date.now() - transitionsStartedAt
      // The Activity Bar badge mirrors the sidebar's group scope, which — unlike
      // the notification set below — includes open reviews authored by the user.
      swarmNeedsActionCount.set(displayed.length)
      const authoredIds = new Set(dashboard.authored.map((review) => review.id))
      const actionable = displayed.filter((review) => !authoredIds.has(review.id))
      const authored = displayed.length - actionable.length
      if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) {
        swarmNotificationE2E.lastActionable = actionable.map((r) => r.id)
      }
      // Per-phase timing is what the 44-minute wedge lacked: a poll stuck in the
      // dashboard phase points at the host-side p4 credential probes; stuck in
      // the transitions phase points at per-review getTransitions. Slow phases
      // are raised to info so they show at the default log level. The filter
      // breakdown is what the FIFTH incident lacked: reviews silently dropped by
      // the approvable filter never appeared in any log, so "0 actionable" was
      // indistinguishable from "0 candidates" — any count change now logs at
      // info with the per-filter drops.
      const counts =
        `${actionable.length} actionable ` +
        `(pool ${pool}, dropped: ${authorFiltered} author-filtered, ` +
        `${notApprovable} not-approvable, ${ignored} ignored, ${authored} authored)`
      const okMessage =
        `poll ok in ${Date.now() - startedAt}ms ` +
        `(dashboard ${dashboardMs}ms, transitions ${transitionsMs}ms): ${counts}`
      if (dashboardMs > SLOW_PHASE_MS || transitionsMs > SLOW_PHASE_MS) {
        this._logger.info(`slow phase — ${okMessage}`)
      } else if (counts !== this._lastPollCounts) {
        this._logger.info(okMessage)
      } else {
        this._logger.debug(okMessage)
      }
      this._lastPollCounts = counts
      this._notifyNew(actionable)
    } catch (err) {
      // Swarm unconfigured / offline / timed out — stay quiet on the UI, but NOT
      // in the log: a failing poll that swallows its error is invisible (the
      // "zero notifications, no diagnostics" bug class).
      this._logger.warn(
        `poll failed after ${Date.now() - startedAt}ms ` +
          `(dashboard ${dashboardMs}ms, transitions ${transitionsMs}ms): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      this._running = false
    }
  }

  /** Reproduce the sidebar's "Needs My Action" group scope, sans the keyword box:
   *  apply author / approvable-only filters, then drop the client-side ignored
   *  set. Notifications additionally exclude reviews authored by the current user
   *  (the caller does that); the badge count uses this list as-is. Returns the
   *  per-filter drop counts alongside so the poll log can show WHERE candidates
   *  disappeared (running filterNeedsAction twice keeps the shared filter the
   *  single source of truth; the inputs are ≤50 rows). */
  private async _computeDisplayed(dashboard: SwarmDashboardResult): Promise<{
    displayed: SwarmReviewDto[]
    pool: number
    authorFiltered: number
    notApprovable: number
    ignored: number
  }> {
    const config = readSwarmFilterConfig(this._config)
    const transitions = config.needsActionApprovableOnly
      ? await this._loadTransitions(dashboard.needsAction)
      : {}
    const afterAuthor = filterNeedsAction(
      dashboard.needsAction,
      { ...config, needsActionApprovableOnly: false },
      {},
    )
    const filtered = filterNeedsAction(
      afterAuthor,
      { ...config, needsActionAuthors: [] },
      transitions,
    )
    const ignoredIds = new Set(swarmIgnoreStore.list())
    const displayed = splitIgnored(filtered, ignoredIds).active
    return {
      displayed,
      pool: dashboard.needsAction.length,
      authorFiltered: dashboard.needsAction.length - afterAuthor.length,
      notApprovable: afterAuthor.length - filtered.length,
      ignored: filtered.length - displayed.length,
    }
  }

  /** Fetch (and cache) transitions for the candidate reviews so approvable-only is
   *  decided accurately, not optimistically. Reuses the view-state cache the sidebar
   *  shares, so an open view doesn't re-fetch what we just loaded.
   *
   *  An entry is stale once the review's `updated` stamp moved past the one it was
   *  fetched under: a teammate's vote (or a re-shelve) flips the server's approve
   *  verdict, and this deployment's workflow withholds `approved` from a fresh
   *  review until its vote conditions are met. Holding the first "cannot approve"
   *  verdict forever kept every such review filtered out of this poll — zero
   *  background notifications until a manual sidebar refresh re-fetched verdicts
   *  (the fifth silent-notification incident). Stale entries re-fetch with
   *  `force` so the host-side 60s TTL cache cannot echo the old verdict back. */
  private async _loadTransitions(
    reviews: readonly SwarmReviewDto[],
  ): Promise<Record<string, SwarmTransitionDto[]>> {
    const cache = swarmReviewsViewState.transitions
    const seenUpdated = swarmReviewsViewState.transitionsSeenUpdated
    let refetched = 0
    await Promise.all(
      reviews.map(async (review) => {
        const cached = cache[review.id]
        // Stale = a verdict was fetched under an older `updated` stamp. A first
        // fetch (no entry) is NOT stale: there is no pinned verdict to flush, so
        // it takes the host's TTL-cached value instead of forcing a server hit.
        const stale = cached !== undefined && seenUpdated[review.id] !== review.updated
        if (cached !== undefined && !stale) return
        if (stale) refetched++
        const result = await withDeadline(
          this._commands.executeCommand<SwarmTransitionDto[]>(
            SwarmCommands.getTransitions,
            review.id,
            /* force */ stale,
            /* silent */ true,
          ),
          TRANSITIONS_DEADLINE_MS,
          `getTransitions RPC (review #${review.id})`,
        ).catch((err: unknown) => {
          // A wedged transitions lookup must not wedge the poll: skip the
          // review's transitions and log it — the same hung-host class as the
          // dashboard deadline, one level down.
          if (err instanceof DeadlineError) this._logger.warn(err.message)
          return undefined
        })
        // On failure leave the entry ABSENT, not empty: filterNeedsAction keeps
        // a review whose transitions haven't loaded (optimistic) but drops one
        // whose loaded transitions lack Approve — caching `[]` here would
        // silently hide the review (and poison the sidebar's shared cache).
        // The seen-updated stamp is only written on success so the next tick
        // retries a failed refetch instead of trusting the stale verdict.
        if (result !== undefined) {
          cache[review.id] = result
          seenUpdated[review.id] = review.updated
        }
      }),
    )
    if (refetched > 0) {
      this._logger.debug(`transitions refetched for ${refetched} review(s) (updated moved)`)
    }
    swarmReviewsViewState.transitions = cache
    return cache
  }

  private _notifyNew(reviews: readonly SwarmReviewDto[]): void {
    const ids = reviews.map((r) => r.id)
    const current = new Set(ids)
    if (!this._primed) {
      this._known = current
      this._primed = true
      this._logger.info(`baseline primed: ${current.size} actionable review(s)`)
      return
    }
    const fresh = reviews.filter((r) => !this._known.has(r.id))
    this._known = current
    if (fresh.length === 0) return
    // The poll just force-fetched the dashboard, so the host-side list cache is
    // fresh — pull a mounted reviews view forward with a soft (non-force)
    // refresh now, and the list is already current whenever the user switches
    // to the window (notification click or not). Independent of the
    // notifications-enabled switch: data freshness is not a notification.
    this._logger.debug(`${fresh.length} new review(s) → requesting reviews view refresh (soft)`)
    void requestSwarmReviewsRefresh(false)
    if (!this._enabled()) {
      this._logger.info(
        `${fresh.length} new review(s) but notifications disabled: ${fresh.map((r) => `#${r.id}`).join(', ')}`,
      )
      return
    }
    if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) {
      swarmNotificationE2E.notified.push(fresh.map((r) => r.id))
    }
    void this._fire(fresh)
  }

  private async _fire(fresh: readonly SwarmReviewDto[]): Promise<void> {
    const title = localize('swarm.notify.needsAction.title', 'New Swarm review needs your action')
    const first = fresh[0]!
    const body =
      fresh.length === 1
        ? this._reviewLine(first)
        : localize('swarm.notify.needsAction.many', '{0} new reviews need your action', {
            0: String(fresh.length),
          })
    this._logger.info(
      `notifying ${fresh.length} new review(s): ${fresh.map((r) => `#${r.id}`).join(', ')}`,
    )
    const res = await this._host.notify({ title, body })
    if (res.clicked) {
      this._openTarget(fresh)
      return
    }
    // Gated main-side (window focused with the user present) or OS notifications
    // unsupported. This poll cycle is the review's only notification chance (the
    // rising edge is already consumed), so surface it in-app instead of dropping it.
    if (!res.shown) {
      this._logger.info(
        'OS toast gated (window focused+user present, or unsupported) → in-app fallback',
      )
      this._notifyInApp(fresh)
    }
  }

  private _openTarget(fresh: readonly SwarmReviewDto[]): void {
    // The click may come long after the notification fired (past the host's
    // list-cache TTL) — soft-refresh the mounted list so it never shows the
    // pre-notification snapshot.
    void requestSwarmReviewsRefresh(false)
    if (fresh.length === 1) {
      void this._commands.executeCommand(OpenSwarmReviewAction.ID, fresh[0]!.id)
    } else {
      void this._commands.executeCommand(OpenSwarmReviewsAction.ID)
    }
  }

  private _notifyInApp(fresh: readonly SwarmReviewDto[]): void {
    const first = fresh[0]!
    const desc = first.description.trim()
    const message =
      fresh.length > 1
        ? localize('swarm.notify.needsAction.many', '{0} new reviews need your action', {
            0: String(fresh.length),
          })
        : desc
          ? localize(
              'swarm.notify.needsAction.inAppOne',
              'New Swarm review #{0} needs your action: {1}',
              { 0: first.id, 1: desc },
            )
          : localize(
              'swarm.notify.needsAction.inAppOneNoDesc',
              'New Swarm review #{0} needs your action',
              { 0: first.id },
            )
    const label =
      fresh.length === 1
        ? localize('swarm.notify.needsAction.open', 'Open Review')
        : localize('swarm.notify.needsAction.openList', 'Open Swarm Reviews')
    // Sticky: a new review is easy to miss if the toast auto-dismisses after a few
    // seconds. Keep it up until the user acts on it — clicking the action opens the
    // review (and dismisses the toast), or the sticky × dismisses it explicitly.
    const handle = this._notification.notify({
      severity: Severity.Info,
      message,
      sticky: true,
      actions: [
        {
          label,
          run: () => {
            this._openTarget(fresh)
            this._notification.dismiss(handle.id)
          },
        },
      ],
    })
  }

  /** One-line body for a single new review: "#id · description", plus workspace. */
  private _reviewLine(review: SwarmReviewDto): string {
    const desc = review.description.trim()
    const head = desc
      ? localize('swarm.notify.needsAction.one', 'Review #{0}: {1}', { 0: review.id, 1: desc })
      : localize('swarm.notify.needsAction.oneNoDesc', 'Review #{0}', { 0: review.id })
    const workspaceName = this._workspace.current?.name
    return workspaceName && workspaceName.length > 0 ? `${head}\n${workspaceName}` : head
  }
}
