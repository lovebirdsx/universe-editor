/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for services/usage/AccountUsageService.ts.
 *
 *  The load-bearing rules this file guards:
 *   1. The account number is authoritative upstream data. A declared source that
 *      fails to answer must surface `hasSource: true` with no `usage`
 *      ("unavailable") — never a local estimate — and a transient failure must
 *      never blank a previously-good number.
 *   2. The cold-start race: `getProviderContext` answers `undefined` while the
 *      provider context is still resolving, and only `onDidChangeContext` tells
 *      this service to re-read. Without that re-read the indicator would stay
 *      stuck at `hasSource: false`.
 *   3. The periodic loop only escalates to a forced gateway fetch when the
 *      cached number is missing or past the usage TTL, throttled per provider.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  LogLevel,
  NullLogger,
  type AiAccountUsage,
  type Event,
  type IAiModelService,
  type IConfigurationChangeEvent,
  type IConfigurationService,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { USAGE_TTL_MS } from '../../../../shared/ai/aiRemoteTtls.js'
import { AccountUsageService } from '../AccountUsageService.js'
import type { IAcpSessionProviderContext } from '../../acp/session/acpSessionProviderContext.js'

const REFRESH_INTERVAL_KEY = 'ai.accountUsage.refreshIntervalMs'
const FETCHED_AT = 1_700_000_000_000

function usage(kind: AiAccountUsage['kind'] = 'balance'): AiAccountUsage {
  return { kind, remainingUSD: 12.5, fetchedAt: FETCHED_AT }
}

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

class FakeConfiguration implements Partial<IConfigurationService> {
  declare readonly _serviceBrand: undefined
  readonly values = new Map<string, unknown>()
  private readonly _onDidChange = new Emitter<IConfigurationChangeEvent>()
  readonly onDidChangeConfiguration = this._onDidChange.event
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }
  fire(keys: string[]): void {
    this._onDidChange.fire({ keys, affectsConfiguration: (key: string) => keys.includes(key) })
  }
}

describe('AccountUsageService', () => {
  let contextChanged: Emitter<void>
  let remoteChanged: Emitter<void>
  let configuration: FakeConfiguration
  let getAccountUsage: ReturnType<typeof vi.fn>
  let refreshRemote: ReturnType<typeof vi.fn>
  let aiModel: IAiModelService
  let providerContext: {
    onDidChangeContext: Event<void>
    getProviderContext: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
  }

  function createService(): AccountUsageService {
    return new AccountUsageService(
      providerContext as unknown as IAcpSessionProviderContext,
      aiModel,
      configuration as unknown as IConfigurationService,
      new StubLoggerService(),
    )
  }

  function ctx(partial?: Record<string, unknown>): { providerId: string; usageSource?: unknown } {
    return { providerId: 'anthropic-gw', usageSource: { id: 'http-json' }, ...partial }
  }

  beforeEach(() => {
    contextChanged = new Emitter<void>()
    remoteChanged = new Emitter<void>()
    configuration = new FakeConfiguration()
    getAccountUsage = vi.fn().mockResolvedValue(usage())
    refreshRemote = vi.fn().mockResolvedValue(undefined)
    aiModel = {
      getAccountUsage,
      refreshRemote,
      onDidChangeRemote: remoteChanged.event,
    } as unknown as IAiModelService
    providerContext = {
      onDidChangeContext: contextChanged.event,
      getProviderContext: vi.fn().mockReturnValue(ctx()),
      refresh: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('serves { hasSource: false } synchronously on a cold cache and refreshes in the background', () => {
    const service = createService()
    expect(service.stateFor('codex').get()).toEqual({ hasSource: false })
    expect(getAccountUsage).toHaveBeenCalledWith('anthropic-gw')
    service.dispose()
  })

  it('reports hasSource false when there is no provider context', async () => {
    providerContext.getProviderContext.mockReturnValue(undefined)
    const service = createService()
    await service.refresh('codex')
    expect(service.stateFor('codex').get()).toEqual({ hasSource: false })
    expect(getAccountUsage).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reports hasSource false when the context declares no usage source', async () => {
    providerContext.getProviderContext.mockReturnValue({ providerId: 'anthropic-gw' })
    const service = createService()
    await service.refresh('codex')
    expect(service.stateFor('codex').get()).toEqual({ hasSource: false })
    expect(getAccountUsage).not.toHaveBeenCalled()
    service.dispose()
  })

  it('lands the authoritative number when the source answers', async () => {
    const service = createService()
    await service.refresh('codex')
    expect(getAccountUsage).toHaveBeenCalledWith('anthropic-gw')
    expect(service.stateFor('codex').get()).toEqual({ hasSource: true, usage: usage() })
    service.dispose()
  })

  it('keeps the previous usage when a fetch throws', async () => {
    const service = createService()
    await service.refresh('codex')
    const first = service.stateFor('codex').get().usage

    getAccountUsage.mockRejectedValueOnce(new Error('boom'))
    await service.refresh('codex')

    const state = service.stateFor('codex').get()
    expect(state.hasSource).toBe(true)
    expect(state.usage).toBe(first)
    service.dispose()
  })

  it('drops the previous provider number when the binding switches and the new source fails', async () => {
    const service = createService()
    // Warm the observable once so stateFor never re-enters refresh mid-test.
    const observable = service.stateFor('codex')
    await service.refresh('codex')

    // Bind to provider A and land its authoritative number.
    providerContext.getProviderContext.mockReturnValue(ctx({ providerId: 'anthropic-A' }))
    getAccountUsage.mockResolvedValueOnce(usage())
    await service.refresh('codex')
    expect(observable.get().usage).toEqual(usage())

    // Re-bind to provider B; B's source answers undefined (unavailable).
    providerContext.getProviderContext.mockReturnValue(ctx({ providerId: 'anthropic-B' }))
    getAccountUsage.mockResolvedValueOnce(undefined)
    await service.refresh('codex')

    const state = observable.get()
    expect(state).toEqual({ hasSource: true })
    expect(state.usage).toBeUndefined()
    service.dispose()
  })

  it('sets hasSource true without usage when the source answers undefined', async () => {
    getAccountUsage.mockResolvedValueOnce(undefined)
    const service = createService()
    await service.refresh('codex')
    expect(service.stateFor('codex').get()).toEqual({ hasSource: true })
    service.dispose()
  })

  it('shares one round trip between concurrent refreshes of the same agent', async () => {
    let resolveCall: ((value: AiAccountUsage) => void) | undefined
    getAccountUsage.mockImplementation(
      () =>
        new Promise<AiAccountUsage>((resolve) => {
          resolveCall = resolve
        }),
    )
    const service = createService()
    const first = service.refresh('codex')
    const second = service.refresh('codex')
    resolveCall?.(usage())
    await Promise.all([first, second])
    expect(getAccountUsage).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('forces an upstream re-fetch before reading when force is set', async () => {
    const service = createService()
    await service.refresh('codex', undefined, { force: true })
    expect(refreshRemote).toHaveBeenCalledWith('anthropic-gw')
    expect(getAccountUsage).toHaveBeenCalledWith('anthropic-gw')
    service.dispose()
  })

  it('chains a forced refresh past an in-flight non-forced one', async () => {
    let resolveFirst: ((value: AiAccountUsage) => void) | undefined
    getAccountUsage
      .mockImplementationOnce(
        () =>
          new Promise<AiAccountUsage>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(usage())
    const service = createService()

    const first = service.refresh('codex')
    const forced = service.refresh('codex', undefined, { force: true })
    resolveFirst?.(usage())
    await Promise.all([first, forced])

    expect(refreshRemote).toHaveBeenCalledTimes(1)
    expect(refreshRemote).toHaveBeenCalledWith('anthropic-gw')
    expect(getAccountUsage).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('refreshes known agents when onDidChangeContext fires', async () => {
    const service = createService()
    await service.refresh('codex')
    getAccountUsage.mockClear()

    contextChanged.fire()

    expect(getAccountUsage).toHaveBeenCalledWith('anthropic-gw')
    service.dispose()
  })

  describe('per-host partitioning', () => {
    // The same agent authenticates from whatever config files live on the host it
    // runs on. A local subscription and a remote gateway are two bindings, and one
    // window can hold a session of each.
    it('keeps the local and remote states of one agent apart', async () => {
      providerContext.getProviderContext.mockImplementation(
        (_agentId: string, authority?: string) =>
          authority === 'ssh-remote+box'
            ? ctx({ providerId: 'remote-gw' })
            : ctx({ providerId: 'local-gw' }),
      )
      getAccountUsage.mockImplementation(async (providerId: string) =>
        providerId === 'remote-gw' ? usage('quota') : usage('balance'),
      )
      const service = createService()

      await service.refresh('codex')
      await service.refresh('codex', 'ssh-remote+box')

      expect(service.stateFor('codex').get().usage?.kind).toBe('balance')
      expect(service.stateFor('codex', 'ssh-remote+box').get().usage?.kind).toBe('quota')
      service.dispose()
    })

    it('does not share one in-flight round trip across hosts', async () => {
      const service = createService()
      await Promise.all([service.refresh('codex'), service.refresh('codex', 'ssh-remote+box')])
      expect(getAccountUsage).toHaveBeenCalledTimes(2)
      service.dispose()
    })

    it('re-resolves every known host on onDidChangeContext, with its own authority', async () => {
      const service = createService()
      await service.refresh('codex')
      await service.refresh('codex', 'ssh-remote+box')
      providerContext.getProviderContext.mockClear()

      contextChanged.fire()

      expect(providerContext.getProviderContext.mock.calls).toEqual(
        expect.arrayContaining([
          ['codex', undefined],
          ['codex', 'ssh-remote+box'],
        ]),
      )
      service.dispose()
    })
  })

  describe('periodic refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      // The minimum legal interval; smaller values fall back to the 60s default.
      configuration.values.set(REFRESH_INTERVAL_KEY, 15_000)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    function freshUsage(): AiAccountUsage {
      return { kind: 'balance', remainingUSD: 12.5, fetchedAt: Date.now() - 1_000 }
    }

    it('re-reads the cache for every known agent each interval', async () => {
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      getAccountUsage.mockClear()

      await vi.advanceTimersByTimeAsync(30_000)

      expect(getAccountUsage).toHaveBeenCalledTimes(2)
      expect(getAccountUsage).toHaveBeenCalledWith('anthropic-gw')
      service.dispose()
    })

    it('never forces an upstream fetch while the cached number is fresh', async () => {
      getAccountUsage.mockResolvedValue(freshUsage())
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      getAccountUsage.mockClear()
      refreshRemote.mockClear()

      await vi.advanceTimersByTimeAsync(45_000)

      expect(getAccountUsage).toHaveBeenCalledTimes(3)
      expect(refreshRemote).not.toHaveBeenCalled()
      service.dispose()
    })

    it('escalates to one forced fetch when stale, then throttles', async () => {
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      refreshRemote.mockClear()

      await vi.advanceTimersByTimeAsync(45_000)

      expect(refreshRemote).toHaveBeenCalledTimes(1)
      expect(refreshRemote).toHaveBeenCalledWith('anthropic-gw')
      service.dispose()
    })

    it('re-forces once the usage TTL elapses', async () => {
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      refreshRemote.mockClear()

      await vi.advanceTimersByTimeAsync(USAGE_TTL_MS + 30_000)

      expect(refreshRemote).toHaveBeenCalledTimes(2)
      service.dispose()
    })

    it('a user-initiated force also refreshes the throttle clock', async () => {
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)

      await service.refresh('codex', undefined, { force: true })
      refreshRemote.mockClear()

      await vi.advanceTimersByTimeAsync(45_000)

      expect(refreshRemote).not.toHaveBeenCalled()
      service.dispose()
    })

    it('skips pairs whose context declares no usage source', async () => {
      providerContext.getProviderContext.mockReturnValue({ providerId: 'anthropic-gw' })
      const service = createService()
      service.stateFor('codex')

      await vi.advanceTimersByTimeAsync(45_000)

      expect(getAccountUsage).not.toHaveBeenCalled()
      expect(refreshRemote).not.toHaveBeenCalled()
      service.dispose()
    })

    it('restarts with the new interval when the configuration changes', async () => {
      configuration.values.delete(REFRESH_INTERVAL_KEY)
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      getAccountUsage.mockClear()

      await vi.advanceTimersByTimeAsync(50_000)
      expect(getAccountUsage).not.toHaveBeenCalled()

      configuration.values.set(REFRESH_INTERVAL_KEY, 15_000)
      configuration.fire([REFRESH_INTERVAL_KEY])

      await vi.advanceTimersByTimeAsync(15_000)
      expect(getAccountUsage).toHaveBeenCalledTimes(1)
      service.dispose()
    })

    it('stops ticking after dispose', async () => {
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      getAccountUsage.mockClear()

      service.dispose()
      await vi.advanceTimersByTimeAsync(50_000)

      expect(getAccountUsage).not.toHaveBeenCalled()
    })

    it('re-reads the cache without forcing when onDidChangeRemote fires', async () => {
      const service = createService()
      service.stateFor('codex')
      await vi.advanceTimersByTimeAsync(0)
      getAccountUsage.mockClear()
      refreshRemote.mockClear()

      remoteChanged.fire()

      expect(getAccountUsage).toHaveBeenCalledWith('anthropic-gw')
      expect(refreshRemote).not.toHaveBeenCalled()
      service.dispose()
    })
  })
})

describe('AccountUsageService — cold-start race', () => {
  it('recovers from hasSource:false once the provider context resolves', async () => {
    const contextChanged = new Emitter<void>()
    let resolved = false
    const providerContext = {
      onDidChangeContext: contextChanged.event,
      getProviderContext: vi.fn(() =>
        resolved ? { providerId: 'anthropic-gw', usageSource: { id: 'http-json' } } : undefined,
      ),
      refresh: vi.fn().mockResolvedValue(undefined),
    } as unknown as IAcpSessionProviderContext
    const aiModel = {
      getAccountUsage: vi.fn().mockResolvedValue(usage()),
      refreshRemote: vi.fn().mockResolvedValue(undefined),
      onDidChangeRemote: new Emitter<void>().event,
    } as unknown as IAiModelService
    const service = new AccountUsageService(
      providerContext,
      aiModel,
      new FakeConfiguration() as unknown as IConfigurationService,
      new StubLoggerService(),
    )

    // Cold cache: the synchronous answer is hasSource:false while the provider
    // context is still resolving.
    const state = service.stateFor('codex')
    expect(state.get()).toEqual({ hasSource: false })

    // Let the cold background refresh (which answered hasSource:false) fully
    // settle first — in production onDidChangeContext fires from an async
    // resolution, never in the same turn as the cold read.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The provider context resolves and fires onDidChangeContext, re-driving the
    // account read to land the authoritative number.
    resolved = true
    contextChanged.fire()

    await vi.waitFor(() => expect(state.get()).toEqual({ hasSource: true, usage: usage() }))
    service.dispose()
  })
})
