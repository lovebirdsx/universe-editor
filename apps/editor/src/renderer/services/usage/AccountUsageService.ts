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
 *  The main-side remoteCoordinator already owns the TTL cache, so this service
 *  runs no polling loop — it refreshes on demand (cold cache, model/remote
 *  changes, the popover's force button).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  Disposable,
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
import { IAcpSessionProviderContext } from '../acp/session/acpSessionProviderContext.js'
import type { AccountUsageState } from './subscriptionUsage.js'

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
  private readonly _logger: ILogger

  constructor(
    @IAcpSessionProviderContext private readonly _providerContext: IAcpSessionProviderContext,
    @IAiModelService private readonly _aiModel: IAiModelService,
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
      // `force` bypasses main's TTL cache by re-fetching the source first.
      if (force) await this._aiModel.refreshRemote(ctx.providerId)
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
