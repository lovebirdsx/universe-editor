/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
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
 *      stuck at `hasSource: false` (misattributing a claude-code session to the
 *      legacy gateway ¥ figure, or hiding codex entirely).
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  LogLevel,
  NullLogger,
  type AiAccountUsage,
  type AiProviderInstance,
  type AiProviderType,
  type Event,
  type IAiModelService,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { AccountUsageService } from '../AccountUsageService.js'
import {
  AcpSessionProviderContext,
  type IAcpSessionProviderContext,
  type SessionProviderContext,
} from '../../acp/session/acpSessionProviderContext.js'
import type { IAiRateMirror } from '../../ai/aiRateMirror.js'
import type { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import type { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'

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

  function ctx(partial?: Partial<SessionProviderContext>): SessionProviderContext {
    return {
      key: 'anthropic/gw',
      type: 'anthropic',
      name: 'gw',
      usageSource: { id: 'http-json' },
      ...partial,
    }
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
    expect(getAccountUsage).toHaveBeenCalledWith('anthropic/gw')
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
    providerContext.getProviderContext.mockReturnValue({
      key: 'anthropic/gw',
      type: 'anthropic',
      name: 'gw',
    })
    const service = createService()
    await service.refresh('codex')
    expect(service.stateFor('codex').get()).toEqual({ hasSource: false })
    expect(getAccountUsage).not.toHaveBeenCalled()
    service.dispose()
  })

  it('lands the authoritative number when the source answers', async () => {
    const service = createService()
    await service.refresh('codex')
    expect(getAccountUsage).toHaveBeenCalledWith('anthropic/gw')
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

  it('drops the previous instance number when the binding switches and the new source fails', async () => {
    const service = createService()
    // Warm the observable once so stateFor never re-enters refresh mid-test.
    const observable = service.stateFor('codex')
    await service.refresh('codex')

    // Bind to instance A and land its authoritative number.
    providerContext.getProviderContext.mockReturnValue(ctx({ key: 'anthropic/A', name: 'A' }))
    getAccountUsage.mockResolvedValueOnce(usage())
    await service.refresh('codex')
    expect(observable.get().usage).toEqual(usage())

    // Re-bind to instance B; B's source answers undefined (unavailable).
    providerContext.getProviderContext.mockReturnValue(ctx({ key: 'anthropic/B', name: 'B' }))
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
    expect(refreshRemote).toHaveBeenCalledWith('anthropic/gw')
    expect(getAccountUsage).toHaveBeenCalledWith('anthropic/gw')
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
    expect(refreshRemote).toHaveBeenCalledWith('anthropic/gw')
    expect(getAccountUsage).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('refreshes known agents when onDidChangeContext fires', async () => {
    const service = createService()
    await service.refresh('codex')
    getAccountUsage.mockClear()

    contextChanged.fire()

    expect(getAccountUsage).toHaveBeenCalledWith('anthropic/gw')
    service.dispose()
  })
})

describe('AccountUsageService — cold-start race', () => {
  it('recovers from hasSource:false once the provider context resolves', async () => {
    let resolveProviders: ((value: readonly AiProviderInstance[]) => void) | undefined
    let resolveTypes: ((value: Readonly<Record<string, AiProviderType>>) => void) | undefined

    const aiModel = {
      onDidChangeModels: new Emitter<void>().event,
      onDidChangeRemote: new Emitter<void>().event,
      getProviders: vi.fn(
        () =>
          new Promise<readonly AiProviderInstance[]>((resolve) => {
            resolveProviders = resolve
          }),
      ),
      getProviderTypes: vi.fn(
        () =>
          new Promise<Readonly<Record<string, AiProviderType>>>((resolve) => {
            resolveTypes = resolve
          }),
      ),
      getAccountUsage: vi.fn().mockResolvedValue(usage()),
      refreshRemote: vi.fn().mockResolvedValue(undefined),
    } as unknown as IAiModelService

    const rateMirror = {
      _serviceBrand: undefined,
      getRateTablesSync: () => [],
      getRatesSync: () => undefined,
    } as unknown as IAiRateMirror

    const claudeConfig = {
      readProfiles: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({}),
    } as unknown as IClaudeConfigService

    const codexConfig = {
      onDidChangeAuth: new Emitter<void>().event,
      readProfiles: vi
        .fn()
        .mockResolvedValue([
          { id: 'p1', label: 'gw', kind: 'gateway', providerRef: 'anthropic/gw' },
        ]),
      matchActiveProfile: vi.fn().mockResolvedValue('p1'),
      read: vi.fn().mockResolvedValue({}),
    } as unknown as ICodexConfigService

    const providerContext = new AcpSessionProviderContext(
      aiModel,
      rateMirror,
      claudeConfig,
      codexConfig,
      new StubLoggerService(),
    )
    const service = new AccountUsageService(providerContext, aiModel, new StubLoggerService())

    // Cold cache: the synchronous answer is hasSource:false while the provider
    // context is still awaiting getProviders / getProviderTypes.
    const state = service.stateFor('codex')
    expect(state.get()).toEqual({ hasSource: false })

    // Let the provider resolution complete — codex now resolves to an instance
    // with a usageSource.
    resolveProviders?.([{ name: 'gw', type: 'anthropic' }])
    resolveTypes?.({
      anthropic: { protocol: 'anthropic-messages', usageSource: { id: 'http-json' } },
    })
    await providerContext.refresh()

    // onDidChangeContext re-drove the account read, landing the authoritative number.
    await vi.waitFor(() => expect(state.get()).toEqual({ hasSource: true, usage: usage() }))

    service.dispose()
    providerContext.dispose()
  })
})
