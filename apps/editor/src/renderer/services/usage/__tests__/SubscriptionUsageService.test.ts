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
  LogLevel,
  NullLogger,
  observableValue,
  StorageScope,
  type ILogger,
  type ILoggerService,
  type IConfigurationChangeEvent,
  type IConfigurationService,
  type IStorageService,
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
  authority: string | undefined = undefined,
  awake: Awaited<ReturnType<IAcpSession['ensureAwake']>> = 'ready',
): IAcpSession & { ensureAwake: ReturnType<typeof vi.fn> } {
  return {
    id,
    agentId,
    authority,
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
  let configuration: FakeConfiguration
  let sessions: ReturnType<typeof observableValue<readonly IAcpSession[]>>
  /** Every session the service could possibly reach, plus a connect spy it must not use. */
  let sessionService: IAcpSessionService & { connect: ReturnType<typeof vi.fn> }

  function createService(): SubscriptionUsageService {
    return new SubscriptionUsageService(
      sessionService,
      configuration as unknown as IConfigurationService,
      storage,
      new StubLoggerService(),
    )
  }

  beforeEach(() => {
    storage = new FakeStorage()
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
    await service.refresh('claude-code', undefined, { force: true })

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
    await service.refresh('claude-code', undefined, { force: true })

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

    await service.refresh('claude-code', undefined, { force: true })
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
    await service.refresh('claude-code', undefined, { force: true })
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

  describe('waking a dormant agent', () => {
    // `requestExtMethod` answers `undefined` — rather than connecting — once the
    // idle reaper has stopped the agent child process, while the session stays in
    // the list. Without a wake on the explicit-refresh path the snapshot then
    // freezes until the editor restarts, which is exactly the bug this guards.

    it('wakes a dormant session on a forced refresh and reads the fresh snapshot', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(90))
      const session = fakeSession('codex', requestExtMethod)
      sessions.set([session], undefined)
      const service = createService()
      await service.refresh('codex')
      expect(service.snapshotFor('codex').get()?.windows[0]?.usedPercent).toBe(90)

      // The agent is stopped: the connection is gone, so the ext-method reports
      // "no connection" instead of throwing.
      requestExtMethod.mockResolvedValue(undefined)
      await service.refresh('codex', undefined, { force: true })
      session.ensureAwake.mockClear()
      // Waking re-establishes it; the quota has since reset upstream.
      requestExtMethod.mockResolvedValue(claudeUsage(1))
      await service.refresh('codex', undefined, { force: true })

      expect(session.ensureAwake).toHaveBeenCalled()
      expect(service.snapshotFor('codex').get()?.windows[0]?.usedPercent).toBe(1)
      service.dispose()
    })

    it('never wakes an agent for the background poll', async () => {
      // Rule 1 in this service's header: polling rides along on an existing
      // connection and must never resurrect a process just to read a status.
      const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(40))
      const session = fakeSession('codex', requestExtMethod)
      sessions.set([session], undefined)
      const service = createService()

      await service.refresh('codex')
      await service.refresh('codex')

      expect(session.ensureAwake).not.toHaveBeenCalled()
      service.dispose()
    })

    it.each(['closed', 'failed', 'connecting'] as const)(
      'keeps the cached snapshot when the wake answers "%s"',
      async (outcome) => {
        const requestExtMethod = vi.fn().mockResolvedValue(claudeUsage(50))
        sessions.set([fakeSession('codex', requestExtMethod)], undefined)
        const service = createService()
        await service.refresh('codex')
        const cached = service.snapshotFor('codex').get()

        sessions.set(
          [fakeSession('codex', requestExtMethod, 'codex', undefined, outcome)],
          undefined,
        )
        requestExtMethod.mockClear()
        await service.refresh('codex', undefined, { force: true })

        // A wake that did not land is "cannot read right now", not "this agent has
        // no subscription readout" — the snapshot stands and polling continues.
        expect(requestExtMethod).not.toHaveBeenCalled()
        expect(service.snapshotFor('codex').get()).toBe(cached)
        service.dispose()
      },
    )

    it('does not let an in-flight poll swallow a forced refresh', async () => {
      // Reusing the poll's round trip would drop the force flag, and with it the
      // wake the user's click asked for.
      const resolvers: Array<(value: unknown) => void> = []
      const requestExtMethod = vi.fn(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const session = fakeSession('codex', requestExtMethod as never)
      sessions.set([session], undefined)
      const service = createService()

      const poll = service.refresh('codex')
      const forced = service.refresh('codex', undefined, { force: true })
      // The forced fetch awaits its wake first, so let both settle before
      // resolving: the round trips are only issued once the wake lands.
      await Promise.resolve()
      await Promise.resolve()
      for (const resolve of resolvers) resolve(claudeUsage(5))
      await Promise.all([poll, forced])

      // Two distinct round trips, so the forced one was not the poll's echo —
      // had it been reused, the wake would never have happened.
      expect(requestExtMethod).toHaveBeenCalledTimes(2)
      expect(session.ensureAwake).toHaveBeenCalled()
      service.dispose()
    })
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

  it('persists and restores a snapshot with reset-credit expiry intact', async () => {
    const requestExtMethod = vi.fn().mockResolvedValue({
      vendor: 'codex',
      supported: true,
      rateLimits: { planType: 'plus', primary: { usedPercent: 33, windowDurationMins: 300 } },
      rateLimitsByLimitId: null,
      resetCredits: {
        availableCount: '2',
        credits: [{ status: 'available', expiresAt: 1_700_003_600 }],
      },
    })
    sessions.set([fakeSession('codex', requestExtMethod)], undefined)
    const first = createService()
    await first.refresh('codex')
    first.dispose()

    sessions.set([], undefined)
    const second = createService()
    await Promise.resolve()
    await Promise.resolve()
    expect(second.snapshotFor('codex').get()?.resetCredits).toEqual({
      availableCount: 2,
      earliestExpiresAt: 1_700_003_600_000,
    })
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

  describe('per-host partitioning', () => {
    // The plan belongs to the account logged in on the host the agent runs on. A
    // local claude.ai login and a remote one are two accounts, and one window can
    // hold a session against each.
    const REMOTE = 'ssh-remote+box'

    it('asks each host its own session and keeps the two snapshots apart', async () => {
      const local = vi.fn().mockResolvedValue(claudeUsage(11))
      const remote = vi.fn().mockResolvedValue(claudeUsage(77))
      sessions.set(
        [
          fakeSession('claude-code', local, 'local-session'),
          fakeSession('claude-code', remote, 'remote-session', REMOTE),
        ],
        undefined,
      )

      const service = createService()
      await service.refresh('claude-code')
      await service.refresh('claude-code', REMOTE)

      expect(local).toHaveBeenCalledWith(ACP_EXT_METHODS.subscriptionUsage)
      expect(remote).toHaveBeenCalledWith(ACP_EXT_METHODS.subscriptionUsage)
      expect(service.snapshotFor('claude-code').get()?.windows[0]?.usedPercent).toBe(11)
      expect(service.snapshotFor('claude-code', REMOTE).get()?.windows[0]?.usedPercent).toBe(77)
      service.dispose()
    })

    it('does not let one host’s "no subscription" verdict silence the other', async () => {
      const local = vi
        .fn()
        .mockResolvedValue({ vendor: 'claude', supported: true, rateLimitsAvailable: false })
      const remote = vi.fn().mockResolvedValue(claudeUsage(42))
      sessions.set(
        [
          fakeSession('claude-code', local, 'local-session'),
          fakeSession('claude-code', remote, 'remote-session', REMOTE),
        ],
        undefined,
      )

      const service = createService()
      await service.refresh('claude-code')
      await service.refresh('claude-code', REMOTE)
      // The constructor's own tick already asked both hosts; count only from here,
      // where the local verdict is on record and the remote one is not.
      local.mockClear()
      remote.mockClear()
      await service.refresh('claude-code')
      await service.refresh('claude-code', REMOTE)

      expect(local).not.toHaveBeenCalled()
      expect(remote).toHaveBeenCalledTimes(1)
      expect(service.snapshotFor('claude-code', REMOTE).get()?.windows[0]?.usedPercent).toBe(42)
      service.dispose()
    })

    it('redeems a reset credit on the host that owns the quota', async () => {
      const local = vi.fn().mockResolvedValue({ outcome: 'noCredit' })
      const remote = vi.fn().mockResolvedValue({ outcome: 'reset' })
      sessions.set(
        [
          fakeSession('codex', local, 'local-session'),
          fakeSession('codex', remote, 'remote-session', REMOTE),
        ],
        undefined,
      )

      const service = createService()
      expect(await service.consumeResetCredit('codex', REMOTE, 'key-1')).toBe('reset')
      expect(remote).toHaveBeenCalledWith(ACP_EXT_METHODS.consumeResetCredit, {
        idempotencyKey: 'key-1',
      })
      expect(local).not.toHaveBeenCalledWith(ACP_EXT_METHODS.consumeResetCredit, expect.anything())
      service.dispose()
    })

    it('restores a pre-partitioning cache entry into the local slot', async () => {
      // Older runs keyed the payload by bare agent id and could only ever have
      // read the local host.
      storage.buckets.get(StorageScope.GLOBAL)!.set(STORAGE_KEY, {
        'claude-code': { windows: [{ id: 'five_hour', usedPercent: 33 }], fetchedAt: 1 },
      })

      const service = createService()
      await Promise.resolve()
      await Promise.resolve()

      expect(service.snapshotFor('claude-code').get()?.windows[0]?.usedPercent).toBe(33)
      expect(service.snapshotFor('claude-code', REMOTE).get()).toBeUndefined()
      service.dispose()
    })
  })

  describe('consumeResetCredit', () => {
    it('forwards the caller-supplied idempotency key verbatim', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'reset' })
      sessions.set([fakeSession('codex', requestExtMethod)], undefined)
      const service = createService()

      const outcome = await service.consumeResetCredit('codex', undefined, 'key-1')

      expect(outcome).toBe('reset')
      expect(requestExtMethod).toHaveBeenCalledWith(ACP_EXT_METHODS.consumeResetCredit, {
        idempotencyKey: 'key-1',
      })
      service.dispose()
    })

    it('reports "unavailable" rather than connecting when no session is live', async () => {
      const service = createService()
      expect(await service.consumeResetCredit('codex', undefined, 'key-1')).toBe('unavailable')
      expect(sessionService.connect).not.toHaveBeenCalled()
      service.dispose()
    })

    it('maps a rejected round trip to "failed" — nothing is known to be consumed', async () => {
      const requestExtMethod = vi.fn().mockRejectedValue(new Error('boom'))
      sessions.set([fakeSession('codex', requestExtMethod)], undefined)
      const service = createService()
      expect(await service.consumeResetCredit('codex', undefined, 'key-1')).toBe('failed')
      service.dispose()
    })

    it('maps an unrecognized outcome to "failed"', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'whatever' })
      sessions.set([fakeSession('codex', requestExtMethod)], undefined)
      const service = createService()
      expect(await service.consumeResetCredit('codex', undefined, 'key-1')).toBe('failed')
      service.dispose()
    })

    it('wakes a dormant session before redeeming', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'reset' })
      const session = fakeSession('codex', requestExtMethod)
      sessions.set([session], undefined)
      const service = createService()

      expect(await service.consumeResetCredit('codex', undefined, 'key-1')).toBe('reset')
      // The wake has to precede the round trip: requestExtMethod never opens a
      // connection, so on a stopped agent it would just answer 'unavailable'.
      expect(session.ensureAwake).toHaveBeenCalledTimes(1)
      service.dispose()
    })

    it('reports "unavailable" without redeeming when the wake fails', async () => {
      const requestExtMethod = vi.fn().mockResolvedValue({ outcome: 'reset' })
      sessions.set(
        [fakeSession('codex', requestExtMethod, 'codex', undefined, 'failed')],
        undefined,
      )
      const service = createService()

      expect(await service.consumeResetCredit('codex', undefined, 'key-1')).toBe('unavailable')
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
