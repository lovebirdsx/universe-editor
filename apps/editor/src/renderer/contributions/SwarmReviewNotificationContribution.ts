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
  Disposable,
  ICommandService,
  IConfigurationService,
  IHostService,
  INotificationService,
  IStorageService,
  IWorkbenchContribution,
  IWorkspaceService,
  Severity,
  localize,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmReviewDto,
  type SwarmTransitionDto,
} from '@universe-editor/extensions-common'
import { swarmIgnoreStore, splitIgnored } from '../services/swarm/swarmIgnoreStore.js'
import { swarmReviewsViewState } from '../services/swarm/swarmViewState.js'
import { filterNeedsAction, readSwarmFilterConfig } from '../services/swarm/swarmReviewFilter.js'
import { swarmNotificationE2E } from '../services/swarm/swarmNotificationE2E.js'
import { setSwarmNotificationTickHandler } from '../services/swarm/swarmNotificationTick.js'
import { OpenSwarmReviewAction, OpenSwarmReviewsAction } from '../actions/swarmActions.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

const POLL_INTERVAL_MS = 60_000

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

  constructor(
    @ICommandService private readonly _commands: ICommandService,
    @IHostService private readonly _host: IHostService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IStorageService storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @INotificationService private readonly _notification: INotificationService,
  ) {
    super()
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
    setSwarmNotificationTickHandler(() => this.refresh())

    this._timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS)
    this._register({ dispose: () => this._stop() })
    // E2E: let a spec drive one poll synchronously (the 60s timer is far too slow
    // for a test, and the window is focused so the OS toast is gated away anyway).
    if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) {
      swarmNotificationE2E.driveRefresh = () => this.refresh()
    }
    // Prime + start immediately so a review that appeared before launch doesn't
    // notify on first paint, but a genuinely new one during this session does.
    void this.refresh()
  }

  private _stop(): void {
    setSwarmNotificationTickHandler(undefined)
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
    }
  }

  private _enabled(): boolean {
    return this._config.get<boolean>('perforce.swarm.notifications.enabled') ?? true
  }

  /** Re-poll the dashboard and notify on newly-actionable reviews. Public so a test
   *  can drive it deterministically. Serialized: overlapping timer ticks are dropped. */
  async refresh(): Promise<void> {
    if (this._running) return
    this._running = true
    try {
      // `force: true` bypasses the dashboard's 60s TTL cache: this poll is the
      // only thing driving new-review detection, so a stale cached list would
      // never surface a review that appeared within the window and we'd never
      // notify. (Mirrors the old status-bar poll, which also forced.)
      const dashboard = await this._commands.executeCommand<SwarmDashboardResult>(
        SwarmCommands.dashboard,
        { force: true },
      )
      // `undefined` = the perforce extension host hasn't registered the command yet
      // (activation race). Skip this tick without disturbing the primed baseline.
      if (dashboard === undefined) return
      const actionable = await this._computeActionable(dashboard)
      if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) {
        swarmNotificationE2E.lastActionable = actionable.map((r) => r.id)
      }
      this._notifyNew(actionable)
    } catch {
      // Swarm unconfigured / offline — stay quiet, retry next tick.
    } finally {
      this._running = false
    }
  }

  /** Reproduce the sidebar's "Needs My Action" list, sans the keyword box: exclude
   *  reviews authored by the current user, apply author / approvable-only filters,
   *  then drop the client-side ignored set. */
  private async _computeActionable(dashboard: SwarmDashboardResult): Promise<SwarmReviewDto[]> {
    const authoredIds = new Set(dashboard.authored.map((review) => review.id))
    const needsAction = dashboard.needsAction.filter((review) => !authoredIds.has(review.id))
    const config = readSwarmFilterConfig(this._config)
    const transitions = config.needsActionApprovableOnly
      ? await this._loadTransitions(needsAction)
      : {}
    const filtered = filterNeedsAction(needsAction, config, transitions)
    const ignoredIds = new Set(swarmIgnoreStore.list())
    return splitIgnored(filtered, ignoredIds).active
  }

  /** Fetch (and cache) transitions for the candidate reviews so approvable-only is
   *  decided accurately, not optimistically. Reuses the view-state cache the sidebar
   *  shares, so an open view doesn't re-fetch what we just loaded. */
  private async _loadTransitions(
    reviews: readonly SwarmReviewDto[],
  ): Promise<Record<string, SwarmTransitionDto[]>> {
    const cache = swarmReviewsViewState.transitions
    await Promise.all(
      reviews.map(async (review) => {
        if (cache[review.id]) return
        const result =
          (await this._commands
            .executeCommand<SwarmTransitionDto[]>(SwarmCommands.getTransitions, review.id)
            .catch(() => undefined)) ?? []
        cache[review.id] = result
      }),
    )
    swarmReviewsViewState.transitions = cache
    return cache
  }

  private _notifyNew(reviews: readonly SwarmReviewDto[]): void {
    const ids = reviews.map((r) => r.id)
    const current = new Set(ids)
    if (!this._primed) {
      this._known = current
      this._primed = true
      return
    }
    const fresh = reviews.filter((r) => !this._known.has(r.id))
    this._known = current
    if (fresh.length === 0) return
    if (!this._enabled()) return
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
    const res = await this._host.notify({ title, body })
    if (res.clicked) {
      this._openTarget(fresh)
      return
    }
    // Gated main-side (window focused) or OS notifications unsupported. This poll
    // cycle is the review's only notification chance (the rising edge is already
    // consumed), so surface it in-app instead of dropping it.
    if (!res.shown) this._notifyInApp(fresh)
  }

  private _openTarget(fresh: readonly SwarmReviewDto[]): void {
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
