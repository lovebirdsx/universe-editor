/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IAccountUsageService — per-provider-instance account usage. The number is
 *  authoritative upstream data (quota / balance / subscription), read through
 *  `IAiModelService.getAccountUsage(providerId)`; unlike the subscription
 *  snapshot it is never estimated locally, so a declared source that fails to
 *  answer is surfaced as "unavailable", never a made-up figure.
 *
 *  The instance an agent is bound to comes from `IAcpSessionProviderContext`,
 *  which resolves it **per host** — so every key here is (agent, authority), not
 *  just the agent. One window can hold a local subscription session and a remote
 *  gateway session of the same agent; collapsing them would report one host's
 *  quota against the other's sessions.
 *
 *  The main-side remoteCoordinator owns the TTL cache (5-minute usage TTL), so
 *  the periodic loop only re-reads the cache; it escalates to a forced gateway
 *  fetch — throttled per provider — when the cached number is missing or past
 *  its TTL. The loop pauses while the window is hidden.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  Disposable,
  IConfigurationService,
  ILoggerService,
  InstantiationType,
  observableValue,
  registerSingleton,
  type ILogger,
  type IObservable,
  type ISettableObservable,
  IAiModelService,
} from '@universe-editor/platform'
import type { AiAccountUsage } from '@universe-editor/platform'
import { USAGE_TTL_MS } from '../../../shared/ai/aiRemoteTtls.js'
import { IAcpSessionProviderContext } from '../acp/session/acpSessionProviderContext.js'
import type { AccountUsageState } from './subscriptionUsage.js'
import { PollingLoop } from './usagePolling.js'

export type { AccountUsageState } from './subscriptionUsage.js'

export interface IAccountUsageService {
  readonly _serviceBrand: undefined
  /**
   * Stable observable identity (same object across calls for one agent+host pair)
   * for React to subscribe to. `authority` is the host the agent runs on
   * (undefined = local).
   */
  stateFor(agentId: string, authority?: string): IObservable<AccountUsageState>
  /** Proactive refresh (force when the user opens the popover). Fails silently, never clears existing usage. */
  refresh(agentId: string, authority?: string, options?: { force?: boolean }): Promise<void>
}

export const IAccountUsageService = createDecorator<IAccountUsageService>('accountUsageService')

const REFRESH_INTERVAL_KEY = 'ai.accountUsage.refreshIntervalMs'
const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 15_000

/** Cache key. `\0` cannot occur in an agent id or an authority. */
function usageKey(agentId: string, authority: string | undefined): string {
  return `${agentId}\0${authority ?? ''}`
}

export class AccountUsageService extends Disposable implements IAccountUsageService {
  declare readonly _serviceBrand: undefined

  private readonly _states = new Map<string, ISettableObservable<AccountUsageState>>()
  /** Every key ever asked about, so `_refreshKnown` can recompute with its authority. */
  private readonly _known = new Map<string, { agentId: string; authority: string | undefined }>()
  private readonly _inflight = new Map<string, Promise<void>>()
  private readonly _inflightForce = new Set<string>()
  private readonly _warmed = new Set<string>()
  private readonly _lastProviderId = new Map<string, string>()
  /** providerId → last time this renderer asked main to refetch that gateway. */
  private readonly _lastForcedAt = new Map<string, number>()
  private readonly _polling: PollingLoop
  private readonly _logger: ILogger

  constructor(
    @IAcpSessionProviderContext private readonly _providerContext: IAcpSessionProviderContext,
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'accountUsage',
      name: 'Account Usage',
    })
    // One subscription: AcpSessionProviderContext already listens to the model /
    // remote / auth sources and fires only after re-resolving, so this covers all
    // of them without double-refreshing on the same aiModel event.
    this._register(this._providerContext.onDidChangeContext(() => void this._refreshKnown()))
    // Push path: a manual refresh elsewhere (the AI settings page) or a main-side
    // stale re-fetch lands here without waiting for the next tick.
    this._register(this._aiModel.onDidChangeRemote(() => void this._refreshKnown()))
    this._polling = this._register(
      new PollingLoop({
        interval: () => this._intervalMs(),
        onTick: () => this._tick(),
        logger: this._logger,
      }),
    )
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(REFRESH_INTERVAL_KEY)) this._polling.restart()
      }),
    )
    this._polling.restart()
  }

  stateFor(agentId: string, authority?: string): IObservable<AccountUsageState> {
    const key = usageKey(agentId, authority)
    const observable = this._observableFor(key, agentId, authority)
    // Cold cache: answer `{ hasSource: false }` synchronously, resolve in the
    // background (same cold-start trigger as getProviderContext). Trigger once
    // per key, never from inside _fetch (which would re-enter refresh).
    if (!this._warmed.has(key)) {
      this._warmed.add(key)
      void this.refresh(agentId, authority)
    }
    return observable
  }

  refresh(agentId: string, authority?: string, options?: { force?: boolean }): Promise<void> {
    const key = usageKey(agentId, authority)
    const force = options?.force === true
    const pending = this._inflight.get(key)
    if (pending !== undefined) {
      // A non-forced flight must not swallow a forced one: chain so the TTL-bypass
      // re-fetch actually runs once the current round trip settles.
      if (force && !this._inflightForce.has(key)) {
        return pending.then(() => this.refresh(agentId, authority, { force: true }))
      }
      return pending
    }
    const run = this._fetch(agentId, authority, force).finally(() => {
      this._inflight.delete(key)
      this._inflightForce.delete(key)
    })
    this._inflight.set(key, run)
    if (force) this._inflightForce.add(key)
    return run
  }

  private _observableFor(
    key: string,
    agentId: string,
    authority: string | undefined,
  ): ISettableObservable<AccountUsageState> {
    let observable = this._states.get(key)
    if (observable === undefined) {
      observable = observableValue<AccountUsageState>(`accountUsage:${key}`, {
        hasSource: false,
      })
      this._states.set(key, observable)
      this._known.set(key, { agentId, authority })
    }
    return observable
  }

  private _refreshKnown(): void {
    for (const { agentId, authority } of [...this._known.values()]) {
      void this.refresh(agentId, authority)
    }
  }

  private _intervalMs(): number {
    const value = this._configuration.get<number>(REFRESH_INTERVAL_KEY)
    return typeof value === 'number' && value >= MIN_INTERVAL_MS ? value : DEFAULT_INTERVAL_MS
  }

  /**
   * Re-read the cache for every known pair; escalate to a forced gateway fetch
   * only when the cached number is missing or past the usage TTL, throttled per
   * provider so a gateway that never answers is not hit every tick.
   */
  private _tick(): void {
    const now = Date.now()
    for (const { agentId, authority } of [...this._known.values()]) {
      const ctx = this._providerContext.getProviderContext(agentId, authority)
      if (ctx === undefined || ctx.usageSource === undefined) continue
      const usage = this._states.get(usageKey(agentId, authority))?.get()?.usage
      const stale = usage === undefined || now - usage.fetchedAt >= USAGE_TTL_MS
      if (stale && now - (this._lastForcedAt.get(ctx.providerId) ?? -Infinity) >= USAGE_TTL_MS) {
        this._lastForcedAt.set(ctx.providerId, now)
        void this.refresh(agentId, authority, { force: true })
      } else {
        void this.refresh(agentId, authority)
      }
    }
  }

  private async _fetch(
    agentId: string,
    authority: string | undefined,
    force: boolean,
  ): Promise<void> {
    const key = usageKey(agentId, authority)
    const where = authority ?? 'local'
    const ctx = this._providerContext.getProviderContext(agentId, authority)
    if (ctx === undefined || ctx.usageSource === undefined) {
      this._logger.debug(`account usage: no usage source for ${agentId}@${where}`)
      this._observableFor(key, agentId, authority).set({ hasSource: false }, undefined)
      return
    }
    const observable = this._observableFor(key, agentId, authority)
    const previous = observable.get().usage
    const previousProviderId = this._lastProviderId.get(key)
    let usage: AiAccountUsage | undefined
    try {
      // `force` bypasses main's TTL cache by re-fetching the source first. A
      // user-initiated force also refreshes the throttle clock, so the next tick
      // does not immediately force again.
      if (force) {
        this._lastForcedAt.set(ctx.providerId, Date.now())
        await this._aiModel.refreshRemote(ctx.providerId)
      }
      usage = await this._aiModel.getAccountUsage(ctx.providerId)
      this._logger.debug(
        `account usage for ${agentId}@${where} (${ctx.providerId}): ${usage === undefined ? 'unavailable' : usage.kind}`,
      )
    } catch (error) {
      this._logger.warn(`account usage fetch failed for ${agentId}@${where}: ${String(error)}`)
    }
    // The number is authoritative for the instance it was read from. Carry the
    // last figure forward only while the agent is still bound to that same
    // instance (transient failure); a re-binding whose source fails to answer
    // must surface as unavailable, never the previous instance's figure.
    if (usage !== undefined) {
      this._lastProviderId.set(key, ctx.providerId)
      observable.set({ hasSource: true, usage }, undefined)
    } else if (previous !== undefined && previousProviderId === ctx.providerId) {
      observable.set({ hasSource: true, usage: previous }, undefined)
    } else {
      observable.set({ hasSource: true }, undefined)
    }
  }
}

registerSingleton(IAccountUsageService, AccountUsageService, InstantiationType.Delayed)
