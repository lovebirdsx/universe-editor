/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maps an ACP session to the provider entry its credentials are currently bound
 *  to, so session-cost estimation can resolve a bare model id against that
 *  provider's pricing source (and pick up the gateway rate table). The hot path
 *  (every usage chunk) reads a synchronous cache; resolution itself is async and
 *  runs lazily per key, re-running whenever provider / rate / agent-config state
 *  changes.
 *
 *  Resolution asks the agent's own config files, per host, via
 *  `resolveActiveAuth(authority)` — a reverse lookup of the live credential
 *  against the configured provider entries (`shared/ai/agentActiveAuth.ts`). Only
 *  an attributed provider yields a context: the official subscription has no
 *  provider to bill against, and an external credential the editor did not write
 *  is deliberately left unattributed rather than guessed at.
 *
 *  The cache is keyed by agent **and authority**, because the same agent runs
 *  against different credentials on different hosts — a local subscription and a
 *  remote gateway are two separate bindings, and collapsing them would bill one
 *  host's sessions at the other's rates.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  InstantiationType,
  IWorkspaceService,
  registerSingleton,
  resolveProviderEntries,
  type AiRateTable,
  type AiRemoteSourceSpec,
  type AiResolvedProvider,
  type AiWireProtocol,
  type Event,
  type ILogger,
  IAiModelService,
} from '@universe-editor/platform'
import { resolveModelPricing } from '../../../../shared/ai/resolveProviderPricing.js'
import { findProviderById } from '../../../../shared/ai/providerDerivation.js'
import type { AgentActiveAuth } from '../../../../shared/ai/agentActiveAuth.js'
import { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'
import { IExchangeRateService } from '../../../../shared/ipc/services.js'
import { currentRemoteAuthority } from '../../remote/windowRemoteAuthority.js'
import { usdToCnyRate } from '../../usage/usdToCnyRate.js'
import { IAiRateMirror } from '../../ai/aiRateMirror.js'

const CLAUDE_AGENT_ID = 'claude-code'
const CODEX_AGENT_ID = 'codex'

const CLAUDE_PROTOCOL: AiWireProtocol = 'anthropic-messages'
const CODEX_PROTOCOL: AiWireProtocol = 'openai-responses'

/** Provider context a cost estimate uses to resolve a bare model id to a rate. */
export interface SessionProviderContext {
  /** Stable provider id (first segment of every model id it serves). */
  readonly providerId: string
  /** The agent's wire protocol — the protocolMap bucket its models come from. */
  readonly protocol: AiWireProtocol
  /** The provider's declared pricing source (no source → rate unknown, never guessed). */
  readonly pricingSource?: AiRemoteSourceSpec
  readonly gatewayRates?: AiRateTable
  readonly usageSource?: AiRemoteSourceSpec
  /**
   * Live USD→CNY rate used to normalize CNY-priced gateway rates. Absent → the
   * `CNY_PER_USD` constant. The UI converts the resulting USD back to CNY with
   * the same live rate, so both directions have to agree or the figure skews.
   */
  readonly cnyPerUsd?: number
}

type ResolvedModelPricing = ReturnType<typeof resolveModelPricing>

/**
 * Resolve a bare model name against a provider context. Without a context there
 * is no pricing source, so the rate is unknown — never a cross-vendor fallback.
 * Pure — unit-tested in isolation.
 */
export function priceSessionModel(
  bareModel: string,
  ctx: SessionProviderContext | undefined,
): ResolvedModelPricing {
  if (ctx === undefined) return resolveModelPricing({ bareModel })
  return resolveModelPricing({
    bareModel,
    ...(ctx.pricingSource !== undefined ? { pricingSource: ctx.pricingSource } : {}),
    ...(ctx.gatewayRates !== undefined ? { gatewayRates: ctx.gatewayRates } : {}),
  })
}

export interface IAcpSessionProviderContext {
  readonly _serviceBrand: undefined
  /** Fired after every successful re-resolution, once the cache is updated. */
  readonly onDidChangeContext: Event<void>
  /**
   * Synchronous read of the cached context for an agent on one host (undefined =
   * unknown, or a binding with no provider to attribute). A cold key resolves in
   * the background and reports via {@link onDidChangeContext}.
   */
  getProviderContext(agentId: string, authority?: string): SessionProviderContext | undefined
  /** Re-resolve every key seen so far, in the background. */
  refresh(): Promise<void>
}

export const IAcpSessionProviderContext = createDecorator<IAcpSessionProviderContext>(
  'acpSessionProviderContext',
)

/** Cache key. `\0` cannot occur in an agent id or an authority. */
function contextKey(agentId: string, authority: string | undefined): string {
  return `${agentId}\0${authority ?? ''}`
}

export class AcpSessionProviderContext extends Disposable implements IAcpSessionProviderContext {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _cache = new Map<string, SessionProviderContext | undefined>()
  /** Every (agent, authority) pair asked about so far — what `refresh()` recomputes. */
  private readonly _known = new Map<string, { agentId: string; authority: string | undefined }>()
  private _refreshing: Promise<void> | undefined
  /**
   * A key registered while a refresh was already in flight. That refresh snapshots
   * `_known` after its first await, so the new key would miss the pass — and
   * `getProviderContext` never asks again once the key is known, leaving it
   * unresolved until some unrelated event happens to trigger a refresh.
   */
  private _knownGrewDuringRefresh = false
  private readonly _onDidChangeContext = this._register(new Emitter<void>())
  readonly onDidChangeContext = this._onDidChangeContext.event

  // Two overloads so tests can construct without a workspace (the warm-up then
  // seeds the local host only), while registerSingleton still sees a fully-typed
  // constructor — an implementation signature with a trailing `?` widens the
  // parameter to BrandedService and fails the registry's check.
  constructor(
    aiModel: IAiModelService,
    rateMirror: IAiRateMirror,
    claudeConfig: IClaudeConfigService,
    codexConfig: ICodexConfigService,
    exchangeRate: IExchangeRateService,
    loggerService: ILoggerService,
  )
  constructor(
    aiModel: IAiModelService,
    rateMirror: IAiRateMirror,
    claudeConfig: IClaudeConfigService,
    codexConfig: ICodexConfigService,
    exchangeRate: IExchangeRateService,
    loggerService: ILoggerService,
    workspace: IWorkspaceService,
  )
  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IAiRateMirror private readonly _rateMirror: IAiRateMirror,
    @IClaudeConfigService private readonly _claudeConfig: IClaudeConfigService,
    @ICodexConfigService private readonly _codexConfig: ICodexConfigService,
    @IExchangeRateService private readonly _exchangeRate: IExchangeRateService,
    @ILoggerService loggerService: ILoggerService,
    @IWorkspaceService private readonly _workspace?: IWorkspaceService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'acpSessionProviderContext',
      name: 'ACP Provider Context',
    })
    // Provider changes, rate-mirror refreshes and either agent's on-disk config
    // all feed the cached context. The config events cover a CLI login or a hand
    // edit, on the local host or any connected remote.
    this._register(this._aiModel.onDidChangeModels(() => void this.refresh()))
    this._register(this._aiModel.onDidChangeRemote(() => void this.refresh()))
    this._register(this._codexConfig.onDidChangeAuth(() => void this.refresh()))
    this._register(this._claudeConfig.onDidChangeConfig(() => void this.refresh()))
    this._warmCurrentWindow()
  }

  getProviderContext(agentId: string, authority?: string): SessionProviderContext | undefined {
    const key = contextKey(agentId, authority)
    if (!this._known.has(key)) {
      this._known.set(key, { agentId, authority })
      if (this._refreshing !== undefined) this._knownGrewDuringRefresh = true
      void this.refresh()
    }
    return this._cache.get(key)
  }

  refresh(): Promise<void> {
    if (this._refreshing !== undefined) return this._refreshing
    const run = this._refreshLoop().finally(() => {
      this._refreshing = undefined
    })
    this._refreshing = run
    return run
  }

  /**
   * Seed the current window's own host so the first cost chunk of a freshly
   * opened session reads a warm cache instead of an empty one. Workspace
   * hydration is async, so this also re-seeds when the workspace settles.
   */
  private _warmCurrentWindow(): void {
    const seed = (): void => {
      const authority = currentRemoteAuthority(this._workspace?.current)
      for (const agentId of [CLAUDE_AGENT_ID, CODEX_AGENT_ID]) {
        const key = contextKey(agentId, authority)
        if (!this._known.has(key)) this._known.set(key, { agentId, authority })
      }
      void this.refresh()
    }
    if (this._workspace !== undefined) {
      this._register(this._workspace.onDidChangeWorkspace(() => seed()))
    }
    seed()
  }

  /**
   * Keep passing until no key arrived mid-pass. `_doRefresh` snapshots `_known`
   * after its first await, so a key registered during that window is missed —
   * and `getProviderContext` will not ask again, having already filed it.
   */
  private async _refreshLoop(): Promise<void> {
    do {
      this._knownGrewDuringRefresh = false
      await this._doRefresh()
    } while (this._knownGrewDuringRefresh)
  }

  private async _doRefresh(): Promise<void> {
    if (this._known.size === 0) return
    let providers: readonly AiResolvedProvider[]
    try {
      const [entries, knowledge] = await Promise.all([
        this._aiModel.getProviders(),
        this._aiModel.getModelKnowledge(),
      ])
      providers = resolveProviderEntries(entries, knowledge).providers
    } catch (err) {
      this._logger.warn(`provider context refresh failed: ${(err as Error).message}`)
      return
    }
    const cnyPerUsd = await this._resolveCnyPerUsd()
    const next = new Map<string, SessionProviderContext | undefined>()
    for (const [key, { agentId, authority }] of this._known) {
      next.set(key, await this._resolveAgent(agentId, authority, providers, cnyPerUsd))
    }
    this._cache.clear()
    for (const [key, value] of next) this._cache.set(key, value)
    // Fire only after the cache is written: subscribers re-read synchronously.
    this._onDidChangeContext.fire()
  }

  /**
   * Live USD→CNY rate, or undefined to let the pricing default apply. Shares the
   * memoized promise with the cost indicators (`usage/usdToCnyRate.ts`) so the
   * normalize-into-USD and display-back-to-CNY directions cannot drift apart.
   */
  private async _resolveCnyPerUsd(): Promise<number | undefined> {
    try {
      const { rate } = await usdToCnyRate(this._exchangeRate)
      return Number.isFinite(rate) && rate > 0 ? rate : undefined
    } catch (err) {
      this._logger.warn(`exchange rate unavailable, pricing falls back: ${(err as Error).message}`)
      return undefined
    }
  }

  private async _resolveAgent(
    agentId: string,
    authority: string | undefined,
    providers: readonly AiResolvedProvider[],
    cnyPerUsd: number | undefined,
  ): Promise<SessionProviderContext | undefined> {
    const where = authority ?? 'local'
    const activeAuth = await this._resolveActiveAuth(agentId, authority)
    if (activeAuth === undefined) return undefined
    if (activeAuth.kind !== 'provider') {
      this._logger.debug(`${agentId}@${where} runs on ${activeAuth.kind}; no provider attribution`)
      return undefined
    }
    const providerId = activeAuth.providerId
    if (providerId === undefined) {
      // An external credential: live, but not one the editor wrote, so there is
      // no entry whose rates could price it.
      this._logger.debug(`${agentId}@${where} runs on an external credential; cost unattributed`)
      return undefined
    }
    const provider = findProviderById(providers, providerId)
    if (provider === undefined) return undefined
    const gatewayRates = this._rateMirror.getRatesSync(providerId)
    return {
      providerId,
      protocol: agentId === CLAUDE_AGENT_ID ? CLAUDE_PROTOCOL : CODEX_PROTOCOL,
      ...(provider.pricingSource !== undefined ? { pricingSource: provider.pricingSource } : {}),
      ...(provider.usageSource !== undefined ? { usageSource: provider.usageSource } : {}),
      ...(gatewayRates !== undefined ? { gatewayRates } : {}),
      ...(cnyPerUsd !== undefined ? { cnyPerUsd } : {}),
    }
  }

  private async _resolveActiveAuth(
    agentId: string,
    authority: string | undefined,
  ): Promise<AgentActiveAuth | undefined> {
    const service =
      agentId === CLAUDE_AGENT_ID
        ? this._claudeConfig
        : agentId === CODEX_AGENT_ID
          ? this._codexConfig
          : undefined
    if (service === undefined) return undefined
    try {
      return await service.resolveActiveAuth(authority)
    } catch (err) {
      this._logger.warn(`resolveActiveAuth(${agentId}) failed: ${(err as Error).message}`)
      return undefined
    }
  }
}

registerSingleton(IAcpSessionProviderContext, AcpSessionProviderContext, InstantiationType.Delayed)
