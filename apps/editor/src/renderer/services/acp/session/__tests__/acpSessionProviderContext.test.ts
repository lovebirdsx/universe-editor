/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  LogLevel,
  NullLogger,
  type AiModelPricing,
  type AiProviderEntry,
  type AiRemoteSourceSpec,
  type IAiModelService,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import {
  AcpSessionProviderContext,
  priceSessionModel,
  type SessionProviderContext,
} from '../acpSessionProviderContext.js'
import type { IAiRateMirror } from '../../../ai/aiRateMirror.js'
import type { IClaudeConfigService } from '../../../../../shared/ipc/claudeConfigService.js'
import type { ICodexConfigService } from '../../../../../shared/ipc/codexConfigService.js'
import type { IExchangeRateService } from '../../../../../shared/ipc/services.js'

const GATEWAY_PRICING: AiModelPricing = { input: 3, output: 4 }

const CATALOG_ANTHROPIC: AiRemoteSourceSpec = { id: 'catalog', options: { vendor: 'anthropic' } }
const CATALOG_UNKNOWN_VENDOR: AiRemoteSourceSpec = { id: 'catalog', options: { vendor: 'acme' } }
const GATEWAY_SOURCE: AiRemoteSourceSpec = { id: 'https://rates.example.com/pricing.json' }

function ctx(partial?: Partial<SessionProviderContext>): SessionProviderContext {
  return { providerId: 'gw', protocol: 'anthropic-messages', ...partial }
}

describe('priceSessionModel', () => {
  it('is unknown when there is no provider context — never a cross-vendor fallback', () => {
    expect(priceSessionModel('claude-sonnet-5', undefined)).toEqual({})
    expect(priceSessionModel('made-up-model', undefined)).toEqual({})
  })

  it('resolves through the declared catalog source against its vendor', () => {
    const result = priceSessionModel('claude-sonnet-5', ctx({ pricingSource: CATALOG_ANTHROPIC }))
    expect(result.origin).toBe('catalog')
    expect(result.pricing?.input).toBe(3)
    expect(result.pricing?.output).toBe(15)
  })

  it('returns {} for a catalog source with an unknown vendor', () => {
    expect(
      priceSessionModel('claude-sonnet-5', ctx({ pricingSource: CATALOG_UNKNOWN_VENDOR })),
    ).toEqual({})
  })

  it('returns {} for a catalog source whose vendor lacks the model', () => {
    expect(priceSessionModel('made-up-model', ctx({ pricingSource: CATALOG_ANTHROPIC }))).toEqual(
      {},
    )
  })

  it('resolves a gateway source through the gateway rate table', () => {
    const result = priceSessionModel(
      'kimi-k3',
      ctx({ pricingSource: GATEWAY_SOURCE, gatewayRates: { 'kimi-k3': GATEWAY_PRICING } }),
    )
    expect(result).toEqual({ pricing: GATEWAY_PRICING, origin: 'gateway' })
  })

  it('returns {} when the gateway table lacks the model', () => {
    expect(
      priceSessionModel('made-up-model', ctx({ pricingSource: GATEWAY_SOURCE, gatewayRates: {} })),
    ).toEqual({})
  })

  it('returns {} when a gateway source has no mirrored rate table', () => {
    expect(priceSessionModel('kimi-k3', ctx({ pricingSource: GATEWAY_SOURCE }))).toEqual({})
  })

  it('ignores a gateway rate table when no pricing source is declared', () => {
    expect(
      priceSessionModel('kimi-k3', ctx({ gatewayRates: { 'kimi-k3': GATEWAY_PRICING } })),
    ).toEqual({})
  })

  it('passes a lane-suffixed wire name through to the bare gateway entry', () => {
    const result = priceSessionModel(
      'kimi-k3[1m]',
      ctx({ pricingSource: GATEWAY_SOURCE, gatewayRates: { 'kimi-k3': GATEWAY_PRICING } }),
    )
    expect(result).toEqual({ pricing: GATEWAY_PRICING, origin: 'gateway' })
  })
})

/*---------------------------------------------------------------------------------------------
 *  Resolution: the on-disk agent config is the only source of truth, per authority.
 *-------------------------------------------------------------------------------------------*/

const CLAUDE = 'claude-code'
const CODEX = 'codex'

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

const PROVIDER_ENTRIES: readonly AiProviderEntry[] = [
  {
    id: 'p1',
    baseUrl: 'https://gw1.example.com',
    apiKey: 'sk-one',
    defaultProtocol: 'anthropic-messages',
    protocolMap: { 'anthropic-messages': ['claude-sonnet-5'] },
    pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
  },
  {
    id: 'p2',
    baseUrl: 'https://gw2.example.com',
    apiKey: 'sk-two',
    defaultProtocol: 'openai-responses',
    protocolMap: { 'openai-responses': ['gpt-6'] },
  },
]

interface Harness {
  readonly service: AcpSessionProviderContext
  readonly claudeActiveAuth: ReturnType<typeof vi.fn>
  readonly codexActiveAuth: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const aiModel = {
    onDidChangeModels: Event.None,
    onDidChangeRemote: Event.None,
    getProviders: vi.fn().mockResolvedValue(PROVIDER_ENTRIES),
    getModelKnowledge: vi.fn().mockResolvedValue({}),
  } as unknown as IAiModelService
  const rateMirror = {
    getRatesSync: vi.fn().mockReturnValue(undefined),
  } as unknown as IAiRateMirror
  // The on-disk agent config is the only source of truth; each host answers for
  // itself.
  const claudeActiveAuth = vi.fn().mockResolvedValue({ kind: 'subscription' })
  const codexActiveAuth = vi.fn().mockResolvedValue({ kind: 'subscription' })
  const claudeConfig = {
    onDidChangeConfig: Event.None,
    resolveActiveAuth: claudeActiveAuth,
  } as unknown as IClaudeConfigService
  const codexConfig = {
    onDidChangeAuth: Event.None,
    resolveActiveAuth: codexActiveAuth,
  } as unknown as ICodexConfigService
  const exchangeRate = {
    getUsdToCnyRate: vi.fn().mockResolvedValue({ rate: 7, source: 'live', fetchedAt: 0 }),
  } as unknown as IExchangeRateService
  const service = new AcpSessionProviderContext(
    aiModel,
    rateMirror,
    claudeConfig,
    codexConfig,
    exchangeRate,
    new StubLoggerService(),
  )
  return { service, claudeActiveAuth, codexActiveAuth }
}

describe('AcpSessionProviderContext resolution', () => {
  it('binds to the provider the on-disk claude config actually uses, not the declared value', async () => {
    const { service, claudeActiveAuth } = harness()
    claudeActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'p1' })

    await service.refresh()

    expect(service.getProviderContext(CLAUDE)?.providerId).toBe('p1')
    service.dispose()
  })

  it('keeps local and remote bindings of the same agent apart', async () => {
    const { service, claudeActiveAuth } = harness()
    claudeActiveAuth.mockImplementation((authority?: string) =>
      Promise.resolve(
        authority === undefined ? { kind: 'subscription' } : { kind: 'provider', providerId: 'p1' },
      ),
    )

    // Warm both keys, then re-resolve so each holds its own answer.
    service.getProviderContext(CLAUDE)
    service.getProviderContext(CLAUDE, 'box')
    await service.refresh()

    expect(service.getProviderContext(CLAUDE)).toBeUndefined()
    expect(service.getProviderContext(CLAUDE, 'box')?.providerId).toBe('p1')
    service.dispose()
  })

  it('carries each host its own pricing source', async () => {
    const { service, claudeActiveAuth } = harness()
    claudeActiveAuth.mockImplementation((authority?: string) =>
      Promise.resolve({ kind: 'provider', providerId: authority === undefined ? 'p1' : 'p2' }),
    )

    service.getProviderContext(CLAUDE)
    service.getProviderContext(CLAUDE, 'box')
    await service.refresh()

    // p1 declares a catalog pricing source; p2 declares none ("rate unknown").
    expect(service.getProviderContext(CLAUDE)?.pricingSource).toEqual({
      id: 'catalog',
      options: { vendor: 'anthropic' },
    })
    expect(service.getProviderContext(CLAUDE, 'box')?.pricingSource).toBeUndefined()
    service.dispose()
  })

  it('has no provider attribution for an external credential the registry does not know', async () => {
    const { service, codexActiveAuth } = harness()
    codexActiveAuth.mockResolvedValue({ kind: 'provider' })

    await service.refresh()

    expect(service.getProviderContext(CODEX)).toBeUndefined()
    service.dispose()
  })

  it('has no provider attribution for a subscription login', async () => {
    const { service, claudeActiveAuth } = harness()
    claudeActiveAuth.mockResolvedValue({ kind: 'subscription' })

    await service.refresh()

    expect(service.getProviderContext(CLAUDE)).toBeUndefined()
    service.dispose()
  })

  it('resolves a cold key in the background and reports via onDidChangeContext', async () => {
    const { service, claudeActiveAuth } = harness()
    claudeActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'p1' })
    let fired = 0
    service.onDidChangeContext(() => {
      fired++
    })

    // Cold read answers undefined synchronously while resolution runs.
    expect(service.getProviderContext(CLAUDE, 'box')).toBeUndefined()
    await vi.waitFor(() => expect(fired).toBeGreaterThan(0))

    expect(service.getProviderContext(CLAUDE, 'box')?.providerId).toBe('p1')
    service.dispose()
  })

  it('only asks about keys it has been asked for', async () => {
    const { service, claudeActiveAuth, codexActiveAuth } = harness()
    await service.refresh()
    claudeActiveAuth.mockClear()
    codexActiveAuth.mockClear()

    service.getProviderContext(CLAUDE, 'box')
    await service.refresh()

    expect(claudeActiveAuth.mock.calls).toEqual(expect.arrayContaining([[undefined], ['box']]))
    // Nothing ever asked about codex@box.
    expect(codexActiveAuth.mock.calls).toEqual([[undefined]])
    service.dispose()
  })

  it('resolves a key first asked for from inside an onDidChangeContext handler', async () => {
    // The event fires while the refresh is still in flight, so a subscriber that
    // reacts by reading a new key would have it filed as "known" and never
    // resolved — `getProviderContext` only kicks a refresh for a cold key.
    const { service, claudeActiveAuth } = harness()
    claudeActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'p1' })
    let asked = false
    service.onDidChangeContext(() => {
      if (asked) return
      asked = true
      expect(service.getProviderContext(CLAUDE, 'box')).toBeUndefined()
    })

    await service.refresh()

    expect(service.getProviderContext(CLAUDE, 'box')?.providerId).toBe('p1')
    service.dispose()
  })

  it('survives a resolveActiveAuth failure without poisoning other keys', async () => {
    const { service, claudeActiveAuth, codexActiveAuth } = harness()
    claudeActiveAuth.mockRejectedValue(new Error('ipc down'))
    codexActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'p2' })

    await service.refresh()

    expect(service.getProviderContext(CLAUDE)).toBeUndefined()
    expect(service.getProviderContext(CODEX)?.providerId).toBe('p2')
    service.dispose()
  })
})
