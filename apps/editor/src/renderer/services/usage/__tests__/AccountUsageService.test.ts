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
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  LogLevel,
  NullLogger,
  type AiAccountUsage,
  type Event,
  type IAiModelService,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { AccountUsageService } from '../AccountUsageService.js'
import type { IAcpSessionProviderContext } from '../../acp/session/acpSessionProviderContext.js'

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

describe('AccountUsageService', () => {
  let contextChanged: Emitter<void>
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
      new StubLoggerService(),
    )
  }

  function ctx(partial?: Record<string, unknown>): { providerId: string; usageSource?: unknown } {
    return { providerId: 'anthropic-gw', usageSource: { id: 'http-json' }, ...partial }
  }

  beforeEach(() => {
    contextChanged = new Emitter<void>()
    getAccountUsage = vi.fn().mockResolvedValue(usage())
    refreshRemote = vi.fn().mockResolvedValue(undefined)
    aiModel = { getAccountUsage, refreshRemote } as unknown as IAiModelService
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
    await service.refresh('codex', { force: true })
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
    const forced = service.refresh('codex', { force: true })
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
    } as unknown as IAiModelService
    const service = new AccountUsageService(providerContext, aiModel, new StubLoggerService())

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
