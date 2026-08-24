/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maps an ACP session to the provider entry its credentials are currently bound
 *  to, so session-cost estimation can resolve a bare model id against that
 *  provider's pricing source (and pick up the gateway rate table). The hot path
 *  (every usage chunk) reads a synchronous cache; resolution itself is async and
 *  runs on construction and whenever provider / rate / auth state changes.
 *
 *  Resolution per agent reads `agentSettings.<agent>.authentication` directly —
 *  a provider id, or `@subscription` (the official subscription login, which has
 *  no provider attribution and prices against the subscription quota instead).
 *  No base-URL reverse lookup: two providers sharing a base URL would be
 *  indistinguishable that way.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  InstantiationType,
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
import { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import {
  AGENT_SUBSCRIPTION_AUTH,
  ICodexConfigService,
} from '../../../../shared/ipc/codexConfigService.js'
import { IExchangeRateService } from '../../../../shared/ipc/services.js'
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
  /** Synchronous read of the cached context for an agent (undefined = unknown). */
  getProviderContext(agentId: string): SessionProviderContext | undefined
  /** Re-resolve every known agent's provider context in the background. */
  refresh(): Promise<void>
}

export const IAcpSessionProviderContext = createDecorator<IAcpSessionProviderContext>(
  'acpSessionProviderContext',
)

export class AcpSessionProviderContext extends Disposable implements IAcpSessionProviderContext {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _cache = new Map<string, SessionProviderContext | undefined>()
  private _refreshing: Promise<void> | undefined
  private readonly _onDidChangeContext = this._register(new Emitter<void>())
  readonly onDidChangeContext = this._onDidChangeContext.event

  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IAiRateMirror private readonly _rateMirror: IAiRateMirror,
    @IClaudeConfigService private readonly _claudeConfig: IClaudeConfigService,
    @ICodexConfigService private readonly _codexConfig: ICodexConfigService,
    @IExchangeRateService private readonly _exchangeRate: IExchangeRateService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'acpSessionProviderContext',
      name: 'ACP Provider Context',
    })
    // Provider changes and rate-mirror refreshes both feed the cached context.
    // Claude config has no change event (applying auth writes settings.json
    // silently), so claude re-resolves opportunistically on these events and via
    // the cold-cache trigger in getProviderContext.
    this._register(this._aiModel.onDidChangeModels(() => void this.refresh()))
    this._register(this._aiModel.onDidChangeRemote(() => void this.refresh()))
    this._register(this._codexConfig.onDidChangeAuth(() => void this.refresh()))
    void this.refresh()
  }

  getProviderContext(agentId: string): SessionProviderContext | undefined {
    if (!this._cache.has(agentId)) void this.refresh()
    return this._cache.get(agentId)
  }

  refresh(): Promise<void> {
    if (this._refreshing !== undefined) return this._refreshing
    const run = this._doRefresh().finally(() => {
      this._refreshing = undefined
    })
    this._refreshing = run
    return run
  }

  private async _doRefresh(): Promise<void> {
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
    const next = new Map<string, SessionProviderContext | undefined>()
    const cnyPerUsd = await this._resolveCnyPerUsd()
    for (const agentId of [CLAUDE_AGENT_ID, CODEX_AGENT_ID]) {
      next.set(agentId, await this._resolveAgent(agentId, providers, cnyPerUsd))
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
    providers: readonly AiResolvedProvider[],
    cnyPerUsd: number | undefined,
  ): Promise<SessionProviderContext | undefined> {
    const providerId =
      agentId === CLAUDE_AGENT_ID
        ? await this._resolveClaudeRef()
        : agentId === CODEX_AGENT_ID
          ? await this._resolveCodexRef()
          : undefined
    if (providerId === undefined) {
      this._logger.debug(`no gateway provider context for ${agentId}`)
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

  private async _resolveClaudeRef(): Promise<string | undefined> {
    const authentication = (await this._claudeConfig.readAgentSettings()).authentication
    if (authentication === undefined || authentication === AGENT_SUBSCRIPTION_AUTH) {
      return undefined
    }
    return authentication
  }

  private async _resolveCodexRef(): Promise<string | undefined> {
    const authentication = (await this._codexConfig.readAgentSettings()).authentication
    if (authentication === undefined || authentication === AGENT_SUBSCRIPTION_AUTH) {
      return undefined
    }
    return authentication
  }
}

registerSingleton(IAcpSessionProviderContext, AcpSessionProviderContext, InstantiationType.Delayed)
