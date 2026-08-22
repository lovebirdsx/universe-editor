/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IAccountUsageService — per-provider-instance account usage. The number is
 *  authoritative upstream data (quota / balance / subscription), read through
 *  `IAiModelService.getAccountUsage(providerKey)`; unlike the subscription
 *  snapshot it is never estimated locally, so a declared source that fails to
 *  answer is surfaced as "unavailable", never a made-up figure.
 *
 *  The instance an agent is bound to comes from `IAcpSessionProviderContext`;
 *  the main-side remoteCoordinator already owns the TTL cache, so this service
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
  /** Stable observable identity (same object across calls for one agentId) for React to subscribe to. */
  stateFor(agentId: string): IObservable<AccountUsageState>
  /** Proactive refresh (force when the user opens the popover). Fails silently, never clears existing usage. */
  refresh(agentId: string, options?: { force?: boolean }): Promise<void>
}

export const IAccountUsageService = createDecorator<IAccountUsageService>('accountUsageService')

export class AccountUsageService extends Disposable implements IAccountUsageService {
  declare readonly _serviceBrand: undefined

  private readonly _states = new Map<string, ISettableObservable<AccountUsageState>>()
  private readonly _inflight = new Map<string, Promise<void>>()
  private readonly _inflightForce = new Set<string>()
  private readonly _warmed = new Set<string>()
  private readonly _lastKey = new Map<string, string>()
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

  stateFor(agentId: string): IObservable<AccountUsageState> {
    const observable = this._observableFor(agentId)
    // Cold cache: answer `{ hasSource: false }` synchronously, resolve in the
    // background (same cold-start trigger as getProviderContext). Trigger once
    // per agentId, never from inside _fetch (which would re-enter refresh).
    if (!this._warmed.has(agentId)) {
      this._warmed.add(agentId)
      void this.refresh(agentId)
    }
    return observable
  }

  refresh(agentId: string, options?: { force?: boolean }): Promise<void> {
    const force = options?.force === true
    const pending = this._inflight.get(agentId)
    if (pending !== undefined) {
      // A non-forced flight must not swallow a forced one: chain so the TTL-bypass
      // re-fetch actually runs once the current round trip settles.
      if (force && !this._inflightForce.has(agentId)) {
        return pending.then(() => this.refresh(agentId, { force: true }))
      }
      return pending
    }
    const run = this._fetch(agentId, force).finally(() => {
      this._inflight.delete(agentId)
      this._inflightForce.delete(agentId)
    })
    this._inflight.set(agentId, run)
    if (force) this._inflightForce.add(agentId)
    return run
  }

  private _observableFor(agentId: string): ISettableObservable<AccountUsageState> {
    let observable = this._states.get(agentId)
    if (observable === undefined) {
      observable = observableValue<AccountUsageState>(`accountUsage:${agentId}`, {
        hasSource: false,
      })
      this._states.set(agentId, observable)
    }
    return observable
  }

  private _refreshKnown(): void {
    for (const agentId of this._states.keys()) void this.refresh(agentId)
  }

  private async _fetch(agentId: string, force: boolean): Promise<void> {
    const ctx = this._providerContext.getProviderContext(agentId)
    if (ctx === undefined || ctx.usageSource === undefined) {
      this._logger.debug(`account usage: no usage source for ${agentId}`)
      this._observableFor(agentId).set({ hasSource: false }, undefined)
      return
    }
    const observable = this._observableFor(agentId)
    const previous = observable.get().usage
    const previousKey = this._lastKey.get(agentId)
    let usage: AiAccountUsage | undefined
    try {
      // `force` bypasses main's TTL cache by re-fetching the source first.
      if (force) await this._aiModel.refreshRemote(ctx.key)
      usage = await this._aiModel.getAccountUsage(ctx.key)
      this._logger.debug(
        `account usage for ${agentId} (${ctx.key}): ${usage === undefined ? 'unavailable' : usage.kind}`,
      )
    } catch (error) {
      this._logger.warn(`account usage fetch failed for ${agentId}: ${String(error)}`)
    }
    // The number is authoritative for the instance it was read from. Carry the
    // last figure forward only while the agent is still bound to that same
    // instance (transient failure); a re-binding whose source fails to answer
    // must surface as unavailable, never the previous instance's figure.
    if (usage !== undefined) {
      this._lastKey.set(agentId, ctx.key)
      observable.set({ hasSource: true, usage }, undefined)
    } else if (previous !== undefined && previousKey === ctx.key) {
      observable.set({ hasSource: true, usage: previous }, undefined)
    } else {
      observable.set({ hasSource: true }, undefined)
    }
  }
}

registerSingleton(IAccountUsageService, AccountUsageService, InstantiationType.Delayed)
