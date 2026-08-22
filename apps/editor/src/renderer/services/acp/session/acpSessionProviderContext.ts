/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maps an ACP session to the provider *instance* its credentials are currently
 *  bound to, so session-cost estimation can complete the three-segment model id
 *  and pick up the gateway rate table. The hot path (every usage chunk) reads a
 *  synchronous cache; resolution itself is async and runs on construction and
 *  whenever provider / rate / auth state changes.
 *
 *  Resolution order per agent:
 *   1. The active gateway credential profile (claude via `isProfileActive`;
 *      codex via the main-side `matchActiveProfile`).
 *   2. Reverse-lookup: the base URL the CLI has on disk → the instance whose
 *      resolved base URL matches.
 *   3. Nothing → `undefined` (the cost falls back to the built-in catalog only).
 *--------------------------------------------------------------------------------------------*/

import {
  composeModelId,
  createDecorator,
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  InstantiationType,
  providerKey,
  registerSingleton,
  resolveModelBaseUrl,
  resolveProviderInstances,
  type AiCustomModelConfig,
  type AiModelPricing,
  type AiProviderInstance,
  type AiProviderType,
  type AiRateTable,
  type AiRemoteSourceSpec,
  type Event,
  IAiModelService,
  type ILogger,
} from '@universe-editor/platform'
import {
  resolveModelPricing,
  type ResolvedModelPricing,
} from '../../../../shared/ai/resolveModelPricing.js'
import { resolveProviderRef } from '../../../../shared/ai/providerDerivation.js'
import { isProfileActive } from '../../../workbench/agentSettings/claude/credentialMatch.js'
import { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'
import { IAiRateMirror } from '../../ai/aiRateMirror.js'

const CLAUDE_AGENT_ID = 'claude-code'
const CODEX_AGENT_ID = 'codex'
const CLAUDE_BASE_URL_KEY = 'ANTHROPIC_BASE_URL'
const CODEX_GATEWAY_PROVIDER_ID = 'codex-gateway'

/** Provider context a cost estimate uses to resolve a bare model id to a rate. */
export interface SessionProviderContext {
  /** Stable provider-instance key (`type/name`), for account-usage lookups. */
  readonly key: string
  readonly type: string
  readonly name: string
  readonly typePricing?: AiModelPricing
  readonly declaredModels?: readonly AiCustomModelConfig[]
  readonly gatewayRates?: AiRateTable
  readonly usageSource?: AiRemoteSourceSpec
}

/**
 * Resolve a bare model name through the pricing chain with (or without) a
 * provider context. Without a context the model id stays bare and only the
 * built-in catalog is consulted. Pure — unit-tested in isolation.
 */
export function priceSessionModel(
  bareModel: string,
  ctx: SessionProviderContext | undefined,
): ResolvedModelPricing {
  if (ctx === undefined) return resolveModelPricing({ modelId: bareModel })
  const declared = ctx.declaredModels?.find((m) => m.id === bareModel)
  return resolveModelPricing({
    modelId: composeModelId(ctx.type, ctx.name, bareModel),
    ...(declared !== undefined ? { model: declared } : {}),
    ...(ctx.gatewayRates !== undefined ? { gatewayRates: ctx.gatewayRates } : {}),
    ...(ctx.typePricing !== undefined ? { typePricing: ctx.typePricing } : {}),
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
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'acpSessionProviderContext',
      name: 'ACP Provider Context',
    })
    // Provider instance/type changes and rate-mirror refreshes both feed the
    // cached context. Claude config has no change event (applying a profile
    // writes settings.json silently), so claude re-resolves opportunistically
    // on these events and via the cold-cache trigger in getProviderContext.
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
    let providers: readonly AiProviderInstance[]
    let types: Readonly<Record<string, AiProviderType>>
    try {
      ;[providers, types] = await Promise.all([
        this._aiModel.getProviders(),
        this._aiModel.getProviderTypes(),
      ])
    } catch (err) {
      this._logger.warn(`provider context refresh failed: ${(err as Error).message}`)
      return
    }
    const next = new Map<string, SessionProviderContext | undefined>()
    for (const agentId of [CLAUDE_AGENT_ID, CODEX_AGENT_ID]) {
      next.set(agentId, await this._resolveAgent(agentId, providers, types))
    }
    this._cache.clear()
    for (const [key, value] of next) this._cache.set(key, value)
    // Fire only after the cache is written: subscribers re-read synchronously.
    this._onDidChangeContext.fire()
  }

  private async _resolveAgent(
    agentId: string,
    providers: readonly AiProviderInstance[],
    types: Readonly<Record<string, AiProviderType>>,
  ): Promise<SessionProviderContext | undefined> {
    const ref =
      agentId === CLAUDE_AGENT_ID
        ? await this._resolveClaudeRef(providers, types)
        : agentId === CODEX_AGENT_ID
          ? await this._resolveCodexRef(providers, types)
          : undefined
    if (ref === undefined) {
      this._logger.debug(`no gateway provider context for ${agentId}`)
      return undefined
    }
    const resolved = resolveProviderRef(ref, providers, types)
    if (resolved === undefined) return undefined
    const flat = resolveProviderInstances([resolved.instance], types)[0]
    const key = providerKey(resolved.instance)
    const gatewayRates = this._rateMirror.getRatesSync(key)
    return {
      key,
      type: resolved.instance.type,
      name: resolved.instance.name,
      ...(flat?.typePricing !== undefined ? { typePricing: flat.typePricing } : {}),
      ...(flat?.declaredModels !== undefined ? { declaredModels: flat.declaredModels } : {}),
      ...(flat?.usageSource !== undefined ? { usageSource: flat.usageSource } : {}),
      ...(gatewayRates !== undefined ? { gatewayRates } : {}),
    }
  }

  private async _resolveClaudeRef(
    providers: readonly AiProviderInstance[],
    types: Readonly<Record<string, AiProviderType>>,
  ): Promise<string | undefined> {
    const [profiles, settings] = await Promise.all([
      this._claudeConfig.readProfiles(),
      this._claudeConfig.read(),
    ])
    const env = settings.env ?? {}
    for (const profile of profiles) {
      if (profile.kind !== 'gateway') continue
      if (isProfileActive(profile, env, settings.model, providers, types)) {
        return profile.providerRef
      }
    }
    const baseUrl = env[CLAUDE_BASE_URL_KEY]
    if (baseUrl !== undefined && baseUrl !== '') {
      return findProviderRefByBaseUrl(baseUrl, providers, types)
    }
    return undefined
  }

  private async _resolveCodexRef(
    providers: readonly AiProviderInstance[],
    types: Readonly<Record<string, AiProviderType>>,
  ): Promise<string | undefined> {
    const [profiles, activeId] = await Promise.all([
      this._codexConfig.readProfiles(),
      this._codexConfig.matchActiveProfile(),
    ])
    if (activeId !== undefined) {
      const profile = profiles.find((p) => p.id === activeId)
      if (
        profile !== undefined &&
        profile.kind === 'gateway' &&
        profile.providerRef !== undefined
      ) {
        return profile.providerRef
      }
    }
    const settings = await this._codexConfig.read()
    const allProviders = settings['model_providers']
    const gateway =
      allProviders && typeof allProviders === 'object'
        ? (allProviders as Record<string, unknown>)[CODEX_GATEWAY_PROVIDER_ID]
        : undefined
    const baseUrl =
      gateway && typeof gateway === 'object'
        ? (gateway as Record<string, unknown>)['base_url']
        : undefined
    if (typeof baseUrl === 'string' && baseUrl !== '') {
      return findProviderRefByBaseUrl(baseUrl, providers, types)
    }
    return undefined
  }
}

function findProviderRefByBaseUrl(
  baseUrl: string,
  providers: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
): string | undefined {
  const needle = baseUrl.trim().replace(/\/+$/, '')
  for (const instance of providers) {
    const type = types[instance.type]
    if (type === undefined) continue
    const resolved = resolveModelBaseUrl(undefined, instance.baseUrl, type.defaultBaseUrl)
    if (resolved !== undefined && resolved.trim().replace(/\/+$/, '') === needle) {
      return providerKey(instance)
    }
  }
  return undefined
}

registerSingleton(IAcpSessionProviderContext, AcpSessionProviderContext, InstantiationType.Delayed)
