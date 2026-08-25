/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for services/usage/SubscriptionUsageService.ts.
 *
 *  The load-bearing rule this file guards: the service only ever rides along on a
 *  session's EXISTING agent connection. It must never establish one — waking an
 *  agent child process to read a status would defeat the connection pool's idle
 *  reclamation.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  NullLogger,
  observableValue,
  StorageScope,
  URI,
  type ILogger,
  type ILoggerService,
  type IConfigurationChangeEvent,
  type IConfigurationService,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { SubscriptionUsageService } from '../SubscriptionUsageService.js'
import { ACP_EXT_METHODS } from '../../acp/session/acpExtMethods.js'
import type { IAcpSession, IAcpSessionService } from '../../acp/session/acpSessionService.js'

const STORAGE_KEY = 'acp.subscriptionUsage'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  async get<T = unknown>(key: string, scope = StorageScope.GLOBAL): Promise<T | undefined> {
    return this.buckets.get(scope)?.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.set(key, value)
  }
  async remove(key: string, scope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.delete(key)
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly whenReady: Promise<void> = Promise.resolve()
  current: IWorkspace | null = { folder: URI.file('/work'), name: 'work' }
  async openFolder(): Promise<void> {}
  async closeFolder(): Promise<void> {}
  async clearRecent(): Promise<void> {}
  async removeRecent(): Promise<void> {}
  fireChange(): void {
    this._onDidChangeWorkspace.fire(this.current)
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

/** Only the members the service touches; everything else stays unreachable. */
function fakeSession(
  agentId: string,
  requestExtMethod: IAcpSession['requestExtMethod'],
  id: string = agentId,
  awake: Awaited<ReturnType<IAcpSession['ensureAwake']>> = 'ready',
): IAcpSession & { ensureAwake: ReturnType<typeof vi.fn> } {
  return {
    id,
    agentId,
    requestExtMethod,
    ensureAwake: vi.fn().mockResolvedValue(awake),
  } as unknown as IAcpSession & { ensureAwake: ReturnType<typeof vi.fn> }
}

function claudeUsage(utilization: number): Record<string, unknown> {
  return {
    vendor: 'claude',
    supported: true,
    subscriptionType: 'max',
    rateLimitsAvailable: true,
    rateLimits: { five_hour: { utilization } },
  }
}

describe('SubscriptionUsageService', () => {
  let storage: FakeStorage
  let workspace: FakeWorkspaceService
  let configuration: FakeConfiguration
  let sessions: ReturnType<typeof observableValue<readonly IAcpSession[]>>
  /** Every session the service could possibly reach, plus a connect spy it must not use. */
  let sessionService: IAcpSessionService & { connect: ReturnType<typeof vi.fn> }

  function createService(): SubscriptionUsageService {
    return new SubscriptionUsageService(
      sessionService,
      configuration as unknown as IConfigurationService,
      storage,
      workspace,
      new StubLoggerService(),
    )
  }

  beforeEach(() => {
    storage = new FakeStorage()
    workspace = new FakeWorkspaceService()
    configuration = new FakeConfiguration()
    sessions = observableValue<readonly IAcpSession[]>('sessions', [])
    sessionService = { sessions, connect: vi.fn() } as unknown as IAcpSessionService & {
      connect: ReturnType<typeof vi.fn>
    }
  })

  it('reads a snapshot over an existing session and never opens a connection', async () => {
    const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(40))
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)

    const service = createService()
    await service.refresh('claude-code')

    expect(requestExtMethod).toHaveBeenCalledWith(ACP_EXT_METHODS.subscriptionUsage)
    expect(sessionService.connect).not.toHaveBeenCalled()
    expect(service.snapshotFor('claude-code').get()?.windows[0]?.usedPercent).toBe(40)
    service.dispose()
  })

  it('shares one round trip between concurrent refreshes of the same agent', async () => {
    let resolveCall: ((value: unknown) => void) | undefined
    const requestExtMethod = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve
        }),
    )
    sessions.set([fakeSession('claude-code', requestExtMethod as never)], undefined)

    const service = createService()
    const first = service.refresh('claude-code')
    const second = service.refresh('claude-code')
    resolveCall?.(claudeUsage(10))
    await Promise.all([first, second])

    expect(requestExtMethod).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('keeps the cached snapshot when there is no live session to ask', async () => {
    const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(55))
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)

    const service = createService()
    await service.refresh('claude-code')
    const cached = service.snapshotFor('claude-code').get()

    sessions.set([], undefined)
    await service.refresh('claude-code', { force: true })

    expect(service.snapshotFor('claude-code').get()).toBe(cached)
    expect(requestExtMethod).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('answers "undefined" (no connection) without clobbering the cache', async () => {
    const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(55))
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)
    const service = createService()
    await service.refresh('claude-code')

    requestExtMethod.mockResolvedValue(undefined)
    await service.refresh('claude-code', { force: true })

    expect(service.snapshotFor('claude-code').get()?.windows[0]?.usedPercent).toBe(55)
    service.dispose()
  })

  it('stops polling an agent that reports no subscription, until forced', async () => {
    const requestExtMethod = vi
      .fn()
      .mockResolvedValue({ vendor: 'claude', supported: true, rateLimitsAvailable: false })
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)

    const service = createService()
    await service.refresh('claude-code')
    await service.refresh('claude-code')
    expect(requestExtMethod).toHaveBeenCalledTimes(1)

    await service.refresh('claude-code', { force: true })
    expect(requestExtMethod).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('re-asks an agent that reported no subscription once a new session appears', async () => {
    // Otherwise signing in to claude.ai / ChatGPT mid-session leaves the
    // indicator hidden for the rest of the window's life: the only forced
    // re-probe lives in a popover that no longer renders.
    const requestExtMethod = vi
      .fn()
      .mockResolvedValue({ vendor: 'claude', supported: true, rateLimitsAvailable: false })
    sessions.set([fakeSession('claude-code', requestExtMethod, 'session-1')], undefined)

    const service = createService()
    await service.refresh('claude-code')
    await service.refresh('claude-code')
    expect(requestExtMethod).toHaveBeenCalledTimes(1)

    requestExtMethod.mockResolvedValue(claudeUsage(12))
    sessions.set([fakeSession('claude-code', requestExtMethod, 'session-2')], undefined)
    await service.refresh('claude-code')

    expect(service.snapshotFor('claude-code').get()?.windows[0]?.usedPercent).toBe(12)
    service.dispose()
  })

  it('drops a cached snapshot once the account stops reporting a subscription', async () => {
    const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(20))
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)
    const service = createService()
    await service.refresh('claude-code')
    expect(service.snapshotFor('claude-code').get()).toBeDefined()

    requestExtMethod.mockResolvedValue({ vendor: 'claude', supported: false })
    await service.refresh('claude-code', { force: true })
    expect(service.snapshotFor('claude-code').get()).toBeUndefined()
    service.dispose()
  })

  it('stops polling an agent whose ext-method rejects (methodNotFound)', async () => {
    const requestExtMethod = vi.fn().mockRejectedValue(new Error('method not found'))
    sessions.set([fakeSession('codex', requestExtMethod)], undefined)

    const service = createService()
    await service.refresh('codex')
    await service.refresh('codex')

    expect(requestExtMethod).toHaveBeenCalledTimes(1)
    expect(service.snapshotFor('codex').get()).toBeUndefined()
    service.dispose()
  })

  it('persists per remote authority and restores on a cold start', async () => {
    const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(66))
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)
    const first = createService()
    await first.refresh('claude-code')
    first.dispose()

    expect(storage.buckets.get(StorageScope.GLOBAL)?.has(STORAGE_KEY)).toBe(true)

    sessions.set([], undefined)
    const second = createService()
    // The restore is async; give the constructor's promise chain a turn.
    await Promise.resolve()
    await Promise.resolve()
    expect(second.snapshotFor('claude-code').get()?.windows[0]?.usedPercent).toBe(66)
    second.dispose()
  })

  it('marks a snapshot stale past the configured window', async () => {
    configuration.values.set('acp.subscriptionUsage.staleAfterMs', 60_000)
    const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(1))
    sessions.set([fakeSession('claude-code', requestExtMethod)], undefined)
    const service = createService()
    await service.refresh('claude-code')

    const snapshot = service.snapshotFor('claude-code').get()
    expect(service.isStale(snapshot, snapshot!.fetchedAt + 30_000)).toBe(false)
    expect(service.isStale(snapshot, snapshot!.fetchedAt + 60_001)).toBe(true)
    service.dispose()
  })

  describe('consumeResetCredit', () => {
    it('forwards the caller-supplied idempotency key verbatim', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'reset' })
      sessions.set([fakeSession('codex', requestExtMethod)], undefined)
      const service = createService()

      const outcome = await service.consumeResetCredit('codex', 'key-1')

      expect(outcome).toBe('reset')
      expect(requestExtMethod).toHaveBeenCalledWith(ACP_EXT_METHODS.consumeResetCredit, {
        idempotencyKey: 'key-1',
      })
      service.dispose()
    })

    it('reports "unavailable" rather than connecting when no session is live', async () => {
      const service = createService()
      expect(await service.consumeResetCredit('codex', 'key-1')).toBe('unavailable')
      expect(sessionService.connect).not.toHaveBeenCalled()
      service.dispose()
    })

    it('maps a rejected round trip to "failed" — nothing is known to be consumed', async () => {
      const requestExtMethod = vi.fn().mockRejectedValue(new Error('boom'))
      sessions.set([fakeSession('codex', requestExtMethod)], undefined)
      const service = createService()
      expect(await service.consumeResetCredit('codex', 'key-1')).toBe('failed')
      service.dispose()
    })

    it('maps an unrecognized outcome to "failed"', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'whatever' })
      sessions.set([fakeSession('codex', requestExtMethod)], undefined)
      const service = createService()
      expect(await service.consumeResetCredit('codex', 'key-1')).toBe('failed')
      service.dispose()
    })

    it('wakes a dormant session before redeeming', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'reset' })
      const session = fakeSession('codex', requestExtMethod)
      sessions.set([session], undefined)
      const service = createService()

      expect(await service.consumeResetCredit('codex', 'key-1')).toBe('reset')
      // The wake has to precede the round trip: requestExtMethod never opens a
      // connection, so on a stopped agent it would just answer 'unavailable'.
      expect(session.ensureAwake).toHaveBeenCalledTimes(1)
      service.dispose()
    })

    it('reports "unavailable" without redeeming when the wake fails', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'reset' })
      sessions.set([fakeSession('codex', requestExtMethod, 'codex', 'failed')], undefined)
      const service = createService()

      expect(await service.consumeResetCredit('codex', 'key-1')).toBe('unavailable')
      // 'failed' would claim the credit was burned; the round trip never left.
      // (The same session also serves the usage poll, so assert on the method
      // rather than on the spy having no calls at all.)
      expect(requestExtMethod).not.toHaveBeenCalledWith(
        ACP_EXT_METHODS.consumeResetCredit,
        expect.anything(),
      )
      service.dispose()
    })
  })
})
