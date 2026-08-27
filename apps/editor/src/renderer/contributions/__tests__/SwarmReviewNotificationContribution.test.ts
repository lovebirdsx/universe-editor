/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for SwarmReviewNotificationContribution — verifies the desktop notification
 *  fires only for reviews newly entering the "final displayed" Needs My Action list
 *  (author / approvable / ignore filters applied), primes on the first poll, merges
 *  a burst into one notification, respects the enable flag, and jumps on click.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, StorageScope, type IStorageService } from '@universe-editor/platform'
import type {
  SwarmDashboardResult,
  SwarmReviewDto,
  SwarmTransitionDto,
} from '@universe-editor/extensions-common'

// Avoid pulling the editor/platform-heavy swarmActions graph; the contribution only
// needs the two command ids to route a notification click.
vi.mock('../../actions/swarmActions.js', () => ({
  OpenSwarmReviewAction: { ID: 'swarm.openReview' },
  OpenSwarmReviewsAction: { ID: 'swarm.openReviews' },
}))

function review(id: string, overrides: Partial<SwarmReviewDto> = {}): SwarmReviewDto {
  return {
    id,
    state: overrides.state ?? 'needsReview',
    stateLabel: overrides.stateLabel ?? 'Needs Review',
    author: overrides.author ?? 'alice',
    description: overrides.description ?? `review ${id}`,
    upVotes: overrides.upVotes ?? 0,
    downVotes: overrides.downVotes ?? 0,
    commentCount: overrides.commentCount ?? 0,
    openTaskCount: overrides.openTaskCount ?? 0,
    testStatus: overrides.testStatus ?? 'none',
    updated: overrides.updated ?? 0,
  }
}

function dashboard(
  needsAction: SwarmReviewDto[],
  authored: SwarmReviewDto[] = [],
): SwarmDashboardResult {
  return { needsAction, authored, participating: [] }
}

function fakeStorage(seed: Record<string, unknown> = {}): IStorageService {
  const data = new Map<string, unknown>(Object.entries(seed))
  return {
    _serviceBrand: undefined,
    async get<T>(key: string, _scope?: StorageScope): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value)
    },
    async remove(key: string): Promise<void> {
      data.delete(key)
    },
    onDidChangeWorkspaceScope: new Emitter<void>().event,
  }
}

/** Flush pending microtasks + the async command fakes. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Fake ILoggerService → a single vi.fn()-backed logger, returned for assertions. */
function fakeLoggerService() {
  const logger = {
    level: 0,
    onDidChangeLogLevel: new Emitter<never>().event,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
  return { service: { createLogger: vi.fn(() => logger) } as never, logger }
}

async function freshModules() {
  vi.resetModules()
  // After resetModules the contribution imports a FRESH platform instance whose
  // CommandsRegistry is not the one this file's top-level import sees. Re-import
  // platform from the same fresh module graph so command stubs land where the
  // contribution looks.
  const platform = await import('@universe-editor/platform')
  const contrib = await import('../SwarmReviewNotificationContribution.js')
  const ignore = await import('../../services/swarm/swarmIgnoreStore.js')
  const viewState = await import('../../services/swarm/swarmViewState.js')
  const tick = await import('../../services/swarm/swarmNotificationTick.js')
  return { contrib, ignore, viewState, tick, platform }
}

interface SetupOpts {
  enabled?: boolean
  /** `perforce.swarm.backgroundPoll.enabled` — the master poll switch. Defaults to
   *  true here so the pre-switch tests keep exercising the poll; the real default
   *  (unset key) is covered by dedicated tests below. */
  pollEnabled?: boolean
  clicked?: boolean
  /** Whether the OS toast was actually displayed (false = gated: window focused
   *  or notifications unsupported). Defaults to true. */
  shown?: boolean
  config?: Record<string, unknown>
  transitions?: Record<string, SwarmTransitionDto[]>
  ignoredIds?: string[]
  workspaceName?: string
  /** Reviews already actionable at construction time (seed the priming baseline). */
  initialNeedsAction?: SwarmReviewDto[]
}

async function setup(opts: SetupOpts = {}) {
  const { contrib, ignore, tick, viewState, platform } = await freshModules()

  // The contribution skips its poll when the dashboard command isn't registered
  // (non-Perforce workspace); stand in for the perforce extension's registration.
  const dashboardCommand = platform.CommandsRegistry.registerCommand(
    'perforce.swarm.dashboard',
    () => undefined,
  )

  const storage = fakeStorage(
    opts.ignoredIds?.length
      ? {
          'swarm.ignoredReviews': opts.ignoredIds,
          'swarm.ignoredReviewMeta': Object.fromEntries(
            opts.ignoredIds.map((id) => [id, review(id)]),
          ),
        }
      : {},
  )
  // Pre-hydrate the shared ignore singleton so the priming poll already sees it.
  await ignore.swarmIgnoreStore.attach(storage)

  let current: SwarmDashboardResult | undefined = dashboard(opts.initialNeedsAction ?? [])
  let transitionsById: Record<string, SwarmTransitionDto[]> = opts.transitions ?? {}
  const executeCommand = vi.fn(async (id: string, arg?: unknown): Promise<unknown> => {
    if (id === 'perforce.swarm.dashboard') return current
    if (id === 'perforce.swarm.getTransitions')
      return transitionsById[String(arg)] ?? ([] as SwarmTransitionDto[])
    return undefined
  })
  const notify = vi.fn(async (_opts: { title: string; body: string }) => ({
    shown: opts.shown ?? true,
    clicked: opts.clicked ?? false,
  }))
  const inAppNotify = vi.fn((_opts: unknown) => ({
    id: 'n1',
    progress: { report: () => {}, done: () => {} },
    updateMessage: () => {},
    updateSeverity: () => {},
    dispose: () => {},
  }))

  const dismiss = vi.fn((_id: string) => {})
  const commands = { executeCommand } as never
  const host = { notify } as never
  const notification = { notify: inAppNotify, dismiss } as never
  const configValues: Record<string, unknown> = {
    'perforce.swarm.notifications.enabled': opts.enabled ?? true,
    'perforce.swarm.backgroundPoll.enabled': opts.pollEnabled ?? true,
    ...opts.config,
  }
  const configChange = new Emitter<{ affectsConfiguration(key: string): boolean }>()
  const config = {
    get: (key: string) => configValues[key],
    onDidChangeConfiguration: configChange.event,
  } as never
  const workspace = {
    current: opts.workspaceName !== undefined ? { name: opts.workspaceName } : null,
  } as never

  const { service: loggerService, logger } = fakeLoggerService()
  const instance = new contrib.SwarmReviewNotificationContribution(
    commands,
    host,
    config,
    storage,
    workspace,
    notification,
    loggerService,
  )
  // Let the constructor's priming poll complete (baseline, no notification).
  await flush()

  return {
    instance,
    notify,
    inAppNotify,
    dismiss,
    executeCommand,
    tick,
    viewState,
    platform,
    configValues,
    configChange,
    logger,
    dispose: () => {
      instance.dispose()
      dashboardCommand.dispose()
    },
    setDashboard: (needsAction: SwarmReviewDto[], authored: SwarmReviewDto[] = []) => {
      current = dashboard(needsAction, authored)
    },
    setTransitionsResponse: (map: Record<string, SwarmTransitionDto[]>) => {
      transitionsById = map
    },
    refresh: () => instance.refresh(),
  }
}

describe('SwarmReviewNotificationContribution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips the poll silently when the dashboard command is not registered', async () => {
    const { contrib, platform } = await freshModules()
    expect(platform.CommandsRegistry.getCommand('perforce.swarm.dashboard')).toBeUndefined()
    const executeCommand = vi.fn(async (): Promise<unknown> => undefined)
    const instance = new contrib.SwarmReviewNotificationContribution(
      { executeCommand } as never,
      { notify: vi.fn() } as never,
      { get: () => true, onDidChangeConfiguration: new Emitter<void>().event } as never,
      fakeStorage(),
      { current: null } as never,
      { notify: vi.fn(), dismiss: vi.fn() } as never,
      fakeLoggerService().service,
    )
    await flush()
    await instance.refresh()
    expect(executeCommand).not.toHaveBeenCalled()
    instance.dispose()
  })

  it('does not poll at all while perforce.swarm.backgroundPoll.enabled is off (the default)', async () => {
    const t = await setup({ pollEnabled: false, initialNeedsAction: [review('1')] })
    // Neither the constructor's prime nor an explicit refresh touches the dashboard.
    await t.refresh()
    expect(t.executeCommand.mock.calls.some((c) => c[0] === 'perforce.swarm.dashboard')).toBe(false)
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(0)
    t.dispose()
  })

  it('starts polling when the background-poll switch is turned on mid-session', async () => {
    const t = await setup({ pollEnabled: false, initialNeedsAction: [review('1')] })
    expect(t.executeCommand.mock.calls.some((c) => c[0] === 'perforce.swarm.dashboard')).toBe(false)

    t.configValues['perforce.swarm.backgroundPoll.enabled'] = true
    t.configChange.fire({
      affectsConfiguration: (k) => k === 'perforce.swarm',
    })
    await flush()

    expect(t.executeCommand.mock.calls.some((c) => c[0] === 'perforce.swarm.dashboard')).toBe(true)
    // Priming baseline only — the seeded review must not notify.
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(1)
    t.dispose()
  })

  it('stops polling and clears the badge when the switch is turned off mid-session', async () => {
    const t = await setup({ initialNeedsAction: [review('1')] })
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(1)

    t.configValues['perforce.swarm.backgroundPoll.enabled'] = false
    t.configChange.fire({
      affectsConfiguration: (k) => k === 'perforce.swarm',
    })
    await flush()

    // Stale badge cleared; further refreshes (timer / host tick) are inert.
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(0)
    t.executeCommand.mockClear()
    await t.refresh()
    expect(t.executeCommand).not.toHaveBeenCalled()
    t.dispose()
  })

  it('pushes the polling snapshot to the host poll driver when setBackgroundPoll is registered', async () => {
    const { contrib, platform } = await freshModules()
    const setBackgroundPoll = vi.fn()
    const dashboardCmd = platform.CommandsRegistry.registerCommand(
      'perforce.swarm.dashboard',
      () => undefined,
    )
    const pushCmd = platform.CommandsRegistry.registerCommand(
      'perforce.swarm.setBackgroundPoll',
      setBackgroundPoll,
    )
    const executeCommand = vi.fn(async (id: string, ...args: unknown[]): Promise<unknown> => {
      if (id === 'perforce.swarm.setBackgroundPoll') return setBackgroundPoll(...args)
      return undefined
    })
    const instance = new contrib.SwarmReviewNotificationContribution(
      { executeCommand } as never,
      { notify: vi.fn() } as never,
      {
        get: (key: string) => (key === 'perforce.swarm.backgroundPoll.enabled' ? true : undefined),
        onDidChangeConfiguration: new Emitter<void>().event,
      } as never,
      fakeStorage(),
      { current: null } as never,
      { notify: vi.fn(), dismiss: vi.fn() } as never,
      fakeLoggerService().service,
    )
    await flush()
    // Full snapshot: the enabled switch, the RAW poll-interval seconds (ms
    // conversion + e2e env override stay host-side), and the configured verdict
    // (mirrors the host's readSwarmConfig defaults: enabled=true, url empty ⇒ unconfigured).
    expect(setBackgroundPoll).toHaveBeenCalledWith({
      enabled: true,
      pollIntervalSeconds: 0,
      configured: false,
    })
    instance.dispose()
    dashboardCmd.dispose()
    pushCmd.dispose()
  })

  it('reports configured: true when perforce.swarm.url is set', async () => {
    const t = await setup({ config: { 'perforce.swarm.url': 'https://swarm.example.com/' } })
    const pushCmd = t.platform.CommandsRegistry.registerCommand(
      'perforce.swarm.setBackgroundPoll',
      vi.fn(),
    )
    const pushCalls = () =>
      t.executeCommand.mock.calls.filter((c) => c[0] === 'perforce.swarm.setBackgroundPoll')

    t.configChange.fire({ affectsConfiguration: (k: string) => k === 'perforce.swarm' })
    await flush()

    expect(pushCalls().length).toBeGreaterThanOrEqual(1)
    expect(pushCalls().at(-1)![1]).toMatchObject({ configured: true })
    pushCmd.dispose()
    t.dispose()
  })

  // Repro for the host-activation race: the contribution is constructed before the
  // perforce extension host registers setBackgroundPoll. The push must retry with
  // a bounded backoff (previously it skipped silently and the host driver kept
  // stale enabled/interval/configured state until the next config change).
  describe('setBackgroundPoll push retry (host activation race)', () => {
    afterEach(() => vi.useRealTimers())

    function raceSetup() {
      const executeCommand = vi.fn(
        async (_id: string, ..._args: unknown[]): Promise<unknown> => undefined,
      )
      const pushCalls = () =>
        executeCommand.mock.calls.filter((c) => c[0] === 'perforce.swarm.setBackgroundPoll')
      const config = {
        get: (key: string) => (key === 'perforce.swarm.backgroundPoll.enabled' ? true : undefined),
        onDidChangeConfiguration: new Emitter<void>().event,
      } as never
      return { executeCommand, pushCalls, config }
    }

    it('retries until the command registers, then pushes exactly once', async () => {
      const { contrib, platform } = await freshModules()
      const dashboardCmd = platform.CommandsRegistry.registerCommand(
        'perforce.swarm.dashboard',
        () => undefined,
      )
      const { executeCommand, pushCalls, config } = raceSetup()
      vi.useFakeTimers()
      const instance = new contrib.SwarmReviewNotificationContribution(
        { executeCommand } as never,
        { notify: vi.fn() } as never,
        config,
        fakeStorage(),
        { current: null } as never,
        { notify: vi.fn(), dismiss: vi.fn() } as never,
        fakeLoggerService().service,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(pushCalls().length).toBe(0)

      // The host finishes activating — the pending retry picks the command up.
      const pushCmd = platform.CommandsRegistry.registerCommand(
        'perforce.swarm.setBackgroundPoll',
        vi.fn(),
      )
      await vi.advanceTimersByTimeAsync(250)
      expect(pushCalls().length).toBe(1)
      expect(pushCalls()[0]![1]).toEqual({
        enabled: true,
        pollIntervalSeconds: 0,
        configured: false,
      })

      // Delivered — no further retries.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pushCalls().length).toBe(1)
      instance.dispose()
      dashboardCmd.dispose()
      pushCmd.dispose()
    })

    it('cancels a pending retry on dispose', async () => {
      const { contrib, platform } = await freshModules()
      const dashboardCmd = platform.CommandsRegistry.registerCommand(
        'perforce.swarm.dashboard',
        () => undefined,
      )
      const { executeCommand, pushCalls, config } = raceSetup()
      vi.useFakeTimers()
      const instance = new contrib.SwarmReviewNotificationContribution(
        { executeCommand } as never,
        { notify: vi.fn() } as never,
        config,
        fakeStorage(),
        { current: null } as never,
        { notify: vi.fn(), dismiss: vi.fn() } as never,
        fakeLoggerService().service,
      )
      await vi.advanceTimersByTimeAsync(0)
      instance.dispose()

      platform.CommandsRegistry.registerCommand('perforce.swarm.setBackgroundPoll', vi.fn())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pushCalls().length).toBe(0)
      dashboardCmd.dispose()
    })

    // A cold extension host can take longer than the 5s the retry budget covers
    // (observed: 11s+). The first host-driven tick proves the host's command
    // surface is alive, so an exhausted push must be redone there — otherwise
    // the host driver keeps running on a stale enabled/interval snapshot until
    // the next configuration change.
    it('re-pushes on the first host tick after the retry budget was exhausted', async () => {
      const { contrib, platform, tick } = await freshModules()
      const dashboardCmd = platform.CommandsRegistry.registerCommand(
        'perforce.swarm.dashboard',
        () => undefined,
      )
      const { executeCommand, pushCalls, config } = raceSetup()
      vi.useFakeTimers()
      const instance = new contrib.SwarmReviewNotificationContribution(
        { executeCommand } as never,
        { notify: vi.fn() } as never,
        config,
        fakeStorage(),
        { current: null } as never,
        { notify: vi.fn(), dismiss: vi.fn() } as never,
        fakeLoggerService().service,
      )
      // Exhaust the 20 x 250ms retry budget with the command still unregistered.
      await vi.advanceTimersByTimeAsync(20 * 250 + 500)
      expect(pushCalls().length).toBe(0)

      // The host finishes activating LATE: the command registers and its poll
      // driver delivers the first tick — which must redo the abandoned push.
      const pushCmd = platform.CommandsRegistry.registerCommand(
        'perforce.swarm.setBackgroundPoll',
        vi.fn(),
      )
      await tick.driveSwarmNotificationTick()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushCalls().length).toBe(1)
      expect(pushCalls()[0]![1]).toMatchObject({ enabled: true, configured: false })
      instance.dispose()
      dashboardCmd.dispose()
      pushCmd.dispose()
    })
  })

  it('re-pushes the polling snapshot when any perforce.swarm configuration changes', async () => {
    const t = await setup()
    const pushCmd = t.platform.CommandsRegistry.registerCommand(
      'perforce.swarm.setBackgroundPoll',
      vi.fn(),
    )
    const pushCalls = () =>
      t.executeCommand.mock.calls.filter((c) => c[0] === 'perforce.swarm.setBackgroundPoll')

    t.configValues['perforce.swarm.pollInterval'] = 30
    t.configChange.fire({ affectsConfiguration: (k: string) => k === 'perforce.swarm' })
    await flush()

    expect(pushCalls().length).toBeGreaterThanOrEqual(1)
    expect(pushCalls().at(-1)![1]).toMatchObject({
      enabled: true,
      pollIntervalSeconds: 30,
      configured: false,
    })
    pushCmd.dispose()
    t.dispose()
  })

  // The visibilitychange catch-up: when the window returns to the foreground after
  // longer than one poll interval without a successful poll (background throttling
  // froze both drivers, or the host chain wedged), refresh immediately instead of
  // waiting out the next timer.
  describe('visibilitychange catch-up tick', () => {
    afterEach(() => vi.useRealTimers())

    it('refreshes on visible only when the last successful poll is over an interval old', async () => {
      const t = await setup({ config: { 'perforce.swarm.pollInterval': 10 } })
      const dashboardCalls = () =>
        t.executeCommand.mock.calls.filter((c) => c[0] === 'perforce.swarm.dashboard').length
      const baseline = dashboardCalls()
      expect(baseline).toBeGreaterThanOrEqual(1) // priming poll ran

      // A visible event with a fresh poll behind us is a no-op…
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
      expect(dashboardCalls()).toBe(baseline)

      // …but once the last success is older than the interval, foregrounding
      // drives an immediate catch-up refresh.
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(11_000)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(dashboardCalls()).toBe(baseline + 1)
      t.dispose()
    })
  })

  it('does not notify for reviews already present at launch (priming poll)', async () => {
    // Review '1' is actionable when the contribution is constructed, so the priming
    // poll records it as baseline. A later poll with the same list must stay silent.
    const t = await setup({ initialNeedsAction: [review('1')] })
    await t.refresh()
    expect(t.notify).not.toHaveBeenCalled()
    t.dispose()
  })

  it('notifies once when a new review enters the list', async () => {
    const t = await setup()
    t.setDashboard([review('1', { description: 'fix login' })])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: fix login' })
    t.dispose()
  })

  it('forces a cache-bypassing dashboard fetch on every poll', async () => {
    // The dashboard result is TTL-cached (60s) in the extension host. Since this
    // background poll is the only thing driving new-review detection, it must pass
    // `force: true` — a non-forced poll would keep hitting the stale cached list
    // and a review that appeared within the window would never notify (regression).
    const t = await setup()
    await t.refresh()
    for (const call of t.executeCommand.mock.calls) {
      if (call[0] === 'perforce.swarm.dashboard') {
        expect(call[1]).toMatchObject({ force: true })
      }
    }
    expect(t.executeCommand.mock.calls.some((c) => c[0] === 'perforce.swarm.dashboard')).toBe(true)
    t.dispose()
  })

  it('does not re-notify an already-notified review', async () => {
    const t = await setup()
    t.setDashboard([review('1')])
    await t.refresh()
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    t.dispose()
  })

  it('merges several new reviews into a single notification', async () => {
    const t = await setup()
    t.setDashboard([review('1'), review('2'), review('3')])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: '3 new reviews need your action' })
    t.dispose()
  })

  it('does not notify when perforce.swarm.notifications.enabled is false', async () => {
    const t = await setup({ enabled: false })
    t.setDashboard([review('1')])
    await t.refresh()
    expect(t.notify).not.toHaveBeenCalled()
    t.dispose()
  })

  // The poll has just force-fetched the dashboard when a rising edge fires, so a
  // mounted reviews view is pulled forward with a soft (non-force) refresh —
  // the user switching to the window (notification click or not) never sees the
  // pre-notification snapshot.
  describe('auto-refresh of the mounted reviews view', () => {
    const watchRefreshRequests = (
      viewState: Awaited<ReturnType<typeof freshModules>>['viewState'],
    ) => {
      const consumer = viewState.trackSwarmRefreshConsumer()
      const seen: boolean[] = []
      const sub = viewState.swarmReviewEvents.onDidRequestRefresh((e) => {
        seen.push(e.force)
        viewState.resolveSwarmReviewsRefresh()
      })
      return { seen, dispose: () => (sub.dispose(), consumer.dispose()) }
    }

    it('requests a soft refresh on the new-review rising edge', async () => {
      const t = await setup()
      const w = watchRefreshRequests(t.viewState)
      try {
        t.setDashboard([review('1')])
        await t.refresh()
        expect(w.seen).toEqual([false])
      } finally {
        w.dispose()
        t.dispose()
      }
    })

    it('does not request a refresh when no new review enters the list', async () => {
      const t = await setup({ initialNeedsAction: [review('1')] })
      const w = watchRefreshRequests(t.viewState)
      try {
        await t.refresh()
        await t.refresh()
        expect(w.seen).toEqual([])
      } finally {
        w.dispose()
        t.dispose()
      }
    })

    it('still refreshes the view when notifications are disabled', async () => {
      const t = await setup({ enabled: false })
      const w = watchRefreshRequests(t.viewState)
      try {
        t.setDashboard([review('1')])
        await t.refresh()
        expect(t.notify).not.toHaveBeenCalled()
        expect(w.seen).toEqual([false])
      } finally {
        w.dispose()
        t.dispose()
      }
    })

    it('requests a soft refresh again when the notification click opens the target', async () => {
      const t = await setup({ clicked: true })
      const w = watchRefreshRequests(t.viewState)
      try {
        t.setDashboard([review('42')])
        await t.refresh()
        await flush()
        expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReview', '42')
        // Rising edge + the click's open-target path each request one.
        expect(w.seen).toEqual([false, false])
      } finally {
        w.dispose()
        t.dispose()
      }
    })
  })

  // The rising-edge soft refresh fired by _notifyNew is a one-shot signal scoped
  // to this renderer process: it only reaches a view that is already mounted and
  // cannot cross into another window's renderer. The focus listener re-sends a
  // throttled soft refresh so switching back to the window always shows the
  // latest list.
  describe('window focus soft refresh', () => {
    afterEach(() => vi.useRealTimers())

    const watchRefreshRequests = (
      viewState: Awaited<ReturnType<typeof freshModules>>['viewState'],
    ) => {
      const consumer = viewState.trackSwarmRefreshConsumer()
      const seen: boolean[] = []
      const sub = viewState.swarmReviewEvents.onDidRequestRefresh((e) => {
        seen.push(e.force)
        viewState.resolveSwarmReviewsRefresh()
      })
      return { seen, dispose: () => (sub.dispose(), consumer.dispose()) }
    }

    it('requests a soft refresh when the window gains focus', async () => {
      const t = await setup()
      const w = watchRefreshRequests(t.viewState)
      try {
        window.dispatchEvent(new Event('focus'))
        expect(w.seen).toEqual([false])
      } finally {
        w.dispose()
        t.dispose()
      }
    })

    it('throttles focus refreshes to at most one per interval', async () => {
      const t = await setup()
      const w = watchRefreshRequests(t.viewState)
      vi.useFakeTimers()
      try {
        window.dispatchEvent(new Event('focus'))
        expect(w.seen).toEqual([false])

        // A burst of focus events inside the throttle window only refreshes once.
        window.dispatchEvent(new Event('focus'))
        window.dispatchEvent(new Event('focus'))
        expect(w.seen).toEqual([false])

        // Past the interval, another focus refreshes again.
        await vi.advanceTimersByTimeAsync(5_000)
        window.dispatchEvent(new Event('focus'))
        expect(w.seen).toEqual([false, false])
      } finally {
        vi.useRealTimers()
        w.dispose()
        t.dispose()
      }
    })

    it('is dropped without error when no view is mounted', async () => {
      const t = await setup()
      // No consumer registered: requestSwarmReviewsRefresh resolves immediately.
      expect(() => window.dispatchEvent(new Event('focus'))).not.toThrow()
      expect(t.logger.debug).toHaveBeenCalledWith(expect.stringContaining('window focused'))
      t.dispose()
    })

    it('stops listening after dispose', async () => {
      const t = await setup()
      const w = watchRefreshRequests(t.viewState)
      vi.useFakeTimers()
      try {
        window.dispatchEvent(new Event('focus'))
        expect(w.seen).toEqual([false])

        t.dispose()

        // Even past the throttle interval, a focus no longer refreshes.
        await vi.advanceTimersByTimeAsync(5_000)
        window.dispatchEvent(new Event('focus'))
        expect(w.seen).toEqual([false])
      } finally {
        vi.useRealTimers()
        w.dispose()
      }
    })
  })

  it('excludes ignored reviews from the notification', async () => {
    const t = await setup({ ignoredIds: ['2'] })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: review 1' })
    t.dispose()
  })

  it('excludes reviews authored by the current user from the notification', async () => {
    const t = await setup()
    const ownReview = review('1', { author: 'alice' })
    t.setDashboard([ownReview, review('2', { author: 'bob' })], [ownReview])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #2: review 2' })
    t.dispose()
  })

  it('publishes the sidebar-scope needs-action count (own reviews included) for the badge', async () => {
    // The badge mirrors the sidebar's "Needs My Action" group, which — unlike the
    // notification set — keeps open reviews authored by the current user.
    const t = await setup()
    const ownReview = review('1', { author: 'alice' })
    t.setDashboard([ownReview, review('2', { author: 'bob' })], [ownReview])
    await t.refresh()
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(2)
    t.dispose()
  })

  it('drops ignored reviews from the published badge count', async () => {
    const t = await setup({ ignoredIds: ['2'] })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(1)
    t.dispose()
  })

  it('applies the author filter (only configured authors notify)', async () => {
    const t = await setup({ config: { 'perforce.swarm.needsActionAuthors': ['bob'] } })
    t.setDashboard([review('1', { author: 'alice' }), review('2', { author: 'bob' })])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #2: review 2' })
    t.dispose()
  })

  it('applies the approvable-only filter using loaded transitions', async () => {
    const t = await setup({
      config: { 'perforce.swarm.needsActionApprovableOnly': true },
      transitions: {
        '1': [{ state: 'approved', label: 'Approve' }],
        '2': [{ state: 'needsRevision', label: 'Needs Revision' }],
      } as Record<string, SwarmTransitionDto[]>,
    })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: review 1' })
    t.dispose()
  })

  // Repro for the FIFTH "no background notification" incident: this Swarm
  // deployment's workflow withholds the `approved` transition from a fresh review
  // until its vote conditions are met, so the first transitions fetch reports
  // "cannot approve" and the approvable-only filter drops the review. The old
  // cache never re-fetched an existing entry, so the teammate vote that later
  // flipped the verdict server-side (bumping the review's `updated` stamp) went
  // unseen forever — zero background notifications until a manual sidebar
  // refresh happened to re-fetch verdicts.
  describe('approvable-only: transitions cache invalidation on `updated` (fifth incident)', () => {
    const notApprovable: SwarmTransitionDto[] = [
      { state: 'needsRevision', label: 'Needs Revision' },
    ]
    const approvable: SwarmTransitionDto[] = [{ state: 'approved', label: 'Approve' }]
    const transitionsCalls = (t: { executeCommand: ReturnType<typeof vi.fn> }) =>
      t.executeCommand.mock.calls.filter((c) => c[0] === 'perforce.swarm.getTransitions')

    it('re-fetches on a moved `updated` stamp and notifies when the verdict flips (regression)', async () => {
      const t = await setup({ config: { 'perforce.swarm.needsActionApprovableOnly': true } })
      t.setTransitionsResponse({ '1': notApprovable })
      t.setDashboard([review('1', { updated: 1000 })])
      await t.refresh()
      // Vote conditions unmet → correctly filtered out, silent.
      expect(t.notify).not.toHaveBeenCalled()

      // A teammate votes: the server flips the verdict AND bumps `updated`.
      t.setTransitionsResponse({ '1': approvable })
      t.setDashboard([review('1', { updated: 2000 })])
      await t.refresh()
      // The re-fetch must force through the host's TTL cache (or it would echo
      // the stale verdict back) and stay silent (poll-driven, no UI on failure).
      const refetch = transitionsCalls(t).at(-1)!
      expect(refetch[2]).toBe(true)
      expect(refetch[3]).toBe(true)
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: review 1' })
      t.dispose()
    })

    it('does not re-fetch while `updated` is unchanged, and never forces the first fetch', async () => {
      const t = await setup({ config: { 'perforce.swarm.needsActionApprovableOnly': true } })
      t.setTransitionsResponse({ '1': approvable })
      t.setDashboard([review('1', { updated: 1000 })])
      await t.refresh()
      const afterFirst = transitionsCalls(t).length
      expect(afterFirst).toBeGreaterThanOrEqual(1)
      // First fetch has no pinned verdict to flush — it may take the TTL value.
      expect(transitionsCalls(t)[0]![2]).toBe(false)
      await t.refresh()
      await t.refresh()
      // Steady state stays cheap: no extra transitions RPCs.
      expect(transitionsCalls(t).length).toBe(afterFirst)
      t.dispose()
    })

    it('a failed re-fetch keeps the entry stale and retries next tick until it succeeds', async () => {
      const t = await setup({ config: { 'perforce.swarm.needsActionApprovableOnly': true } })
      t.setTransitionsResponse({ '1': notApprovable })
      t.setDashboard([review('1', { updated: 1000 })])
      await t.refresh()
      expect(t.notify).not.toHaveBeenCalled()

      // The vote bumps `updated`, but the re-fetch fails (host restarting).
      const original = t.executeCommand.getMockImplementation()!
      t.executeCommand.mockImplementation(async (id: string, arg?: unknown): Promise<unknown> => {
        if (id === 'perforce.swarm.getTransitions') throw new Error('host gone')
        return original(id, arg)
      })
      t.setDashboard([review('1', { updated: 2000 })])
      await t.refresh()
      // The old (not-approvable) verdict is retained — still silent, no false positive.
      expect(t.notify).not.toHaveBeenCalled()

      // Host recovers. The seen-updated stamp was NOT advanced on failure, so the
      // entry is still stale: the next tick re-fetches and the flip notifies.
      t.executeCommand.mockImplementation(original)
      t.setTransitionsResponse({ '1': approvable })
      await t.refresh()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: review 1' })
      t.dispose()
    })
  })

  // The fifth incident hid behind a debug-only "N actionable" line: reviews
  // silently dropped by the approvable filter never appeared in any log. Any
  // change in the counts now logs the per-filter breakdown at info.
  it('raises `poll ok` to info with the filter breakdown when the counts change', async () => {
    const t = await setup({ config: { 'perforce.swarm.needsActionApprovableOnly': true } })
    t.setTransitionsResponse({ '1': [{ state: 'needsRevision', label: 'Needs Revision' }] })
    t.setDashboard([review('1', { updated: 1000 })])
    t.logger.info.mockClear()
    t.logger.debug.mockClear()
    await t.refresh()
    expect(t.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        '0 actionable (pool 1, dropped: 0 author-filtered, 1 not-approvable, 0 ignored, 0 authored)',
      ),
    )
    // Unchanged counts on the next tick stay at debug — steady state, zero info noise.
    t.logger.info.mockClear()
    await t.refresh()
    expect(t.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('poll ok'))
    expect(t.logger.debug).toHaveBeenCalledWith(expect.stringContaining('poll ok'))
    t.dispose()
  })

  it('on click of a single-review notification opens that review', async () => {
    const t = await setup({ clicked: true })
    t.setDashboard([review('42')])
    await t.refresh()
    await flush()
    expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReview', '42')
    t.dispose()
  })

  it('on click of a multi-review notification focuses the Swarm view', async () => {
    const t = await setup({ clicked: true })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    await flush()
    expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReviews')
    t.dispose()
  })

  it('appends the workspace folder name on a second body line', async () => {
    const t = await setup({ workspaceName: 'universe-editor' })
    t.setDashboard([review('1', { description: 'fix login' })])
    await t.refresh()
    expect(t.notify.mock.calls[0]![0]).toMatchObject({
      body: 'Review #1: fix login\nuniverse-editor',
    })
    t.dispose()
  })

  // Repro for "自动通知没生效": the OS toast is gated main-side while the window is
  // focused (hostMainService returns shown:false) — the exact state a user actively
  // working in the editor is always in. The contribution must fall back to an
  // in-app notification, otherwise the review's rising edge is consumed silently
  // and it never notifies again.
  describe('in-app fallback when the OS toast is suppressed (window focused)', () => {
    it('raises an in-app notification with an open action for a single review', async () => {
      const t = await setup({ shown: false })
      t.setDashboard([review('42', { description: 'fix login' })])
      await t.refresh()
      await flush()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.inAppNotify).toHaveBeenCalledTimes(1)
      const opts = t.inAppNotify.mock.calls[0]![0] as {
        message: string
        sticky?: boolean
        actions?: Array<{ label: string; run: () => void }>
      }
      expect(opts.message).toContain('#42')
      // Sticky so the review can't slip past unnoticed while auto-dismissing.
      expect(opts.sticky).toBe(true)
      expect(opts.actions?.length).toBe(1)
      opts.actions![0]!.run()
      expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReview', '42')
      // Clicking the action dismisses the sticky toast.
      expect(t.dismiss).toHaveBeenCalledWith('n1')
      t.dispose()
    })

    it('routes a multi-review fallback action to the Swarm Reviews view', async () => {
      const t = await setup({ shown: false })
      t.setDashboard([review('1'), review('2')])
      await t.refresh()
      await flush()
      expect(t.inAppNotify).toHaveBeenCalledTimes(1)
      const opts = t.inAppNotify.mock.calls[0]![0] as {
        actions?: Array<{ label: string; run: () => void }>
      }
      opts.actions![0]!.run()
      expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReviews')
      t.dispose()
    })

    it('does not raise the in-app fallback when the OS toast was shown', async () => {
      const t = await setup({ shown: true })
      t.setDashboard([review('1')])
      await t.refresh()
      await flush()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.inAppNotify).not.toHaveBeenCalled()
      t.dispose()
    })

    it('stays silent when notifications are disabled', async () => {
      const t = await setup({ shown: false, enabled: false })
      t.setDashboard([review('1')])
      await t.refresh()
      await flush()
      expect(t.notify).not.toHaveBeenCalled()
      expect(t.inAppNotify).not.toHaveBeenCalled()
      t.dispose()
    })
  })

  // Repro for "后台自动通知从未触发": the renderer's own setInterval is
  // background-throttled by Chromium while the window sits in the background, so the
  // real poll driver is the perforce extension host's timer, which pokes the
  // renderer via `_workbench.swarmPollTick`. That command routes to the live
  // contribution's refresh() through the module-level tick seam. Driving that seam
  // must detect a newly-actionable review exactly as a timer tick would.
  describe('host-driven poll tick (_workbench.swarmPollTick seam)', () => {
    it('detects and notifies for a new review when driven by the host tick', async () => {
      const t = await setup()
      t.setDashboard([review('7', { description: 'fix crash' })])
      await t.tick.driveSwarmNotificationTick()
      await flush()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #7: fix crash' })
      t.dispose()
    })

    it('is a no-op after the contribution is disposed (handler unregistered)', async () => {
      const t = await setup()
      t.dispose()
      t.setDashboard([review('9')])
      await t.tick.driveSwarmNotificationTick()
      await flush()
      expect(t.notify).not.toHaveBeenCalled()
    })

    // Gap detection: host ticks arriving more than 3 intervals apart mean the
    // chain stalled (host wedged / renderer throttled) — the log line carries
    // the stall duration, zero noise in the steady state.
    it('logs the stall duration when host ticks arrive more than 3 intervals apart', async () => {
      const t = await setup({ config: { 'perforce.swarm.pollInterval': 10 } })
      vi.useFakeTimers()
      try {
        await t.tick.driveSwarmNotificationTick()
        await vi.advanceTimersByTimeAsync(31_000) // > 3x the 10s interval
        await t.tick.driveSwarmNotificationTick()
        expect(t.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('tick gap 31s (host driver stalled or renderer was throttled)'),
        )
      } finally {
        t.dispose()
        vi.useRealTimers()
      }
    })
  })

  // Repro for "后台时新 review 零通知" (second half of the latch): when the dashboard
  // call rejects — e.g. an expired Swarm ticket making the extension host throw
  // Unauthorized — refresh() must still release its serialized `_running` latch in
  // `finally`. If it didn't, every subsequent host tick would be dropped at
  // `if (this._running) return` and no review would ever notify again.
  describe('rejected dashboard call releases the poll latch', () => {
    it('a rejected poll keeps the latch free so the next tick runs and notifies', async () => {
      const t = await setup()
      // Make the next dashboard call reject (simulates the 401 the extension host
      // propagates back over RPC), then restore a healthy dashboard.
      const original = t.executeCommand.getMockImplementation()!
      t.executeCommand.mockImplementation(async (id: string): Promise<unknown> => {
        if (id === 'perforce.swarm.dashboard') throw new Error('Swarm unauthorized (401)')
        return original(id)
      })
      await t.refresh()
      expect(t.notify).not.toHaveBeenCalled()
      // The failure must be VISIBLE in the log — a poll that swallows its error
      // silently is undiagnosable (the "zero notifications, no diagnostics" bug).
      expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('poll failed after'))

      // The latch must be free: a later tick reaches the dashboard again and the
      // newly-actionable review notifies — this is the regression assertion.
      t.executeCommand.mockImplementation(original)
      t.setDashboard([review('5', { description: 'recovered' })])
      await t.tick.driveSwarmNotificationTick()
      await flush()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #5: recovered' })
      t.dispose()
    })

    // Companion to the above: a rejected poll must NOT touch the primed baseline.
    // The old guard() swallowed the failure into an EMPTY dashboard fallback, which
    // `_notifyNew` then treated as "zero reviews" — wiping `_known`, so the next
    // healthy tick re-fired every already-known review as "new" (a phantom burst).
    it('a rejected poll preserves the notified baseline — no phantom burst on recovery', async () => {
      const t = await setup({ initialNeedsAction: [review('5')] })
      await flush()
      // Baseline is primed with #5 (prime never notifies).
      expect(t.notify).not.toHaveBeenCalled()

      // One failing tick (expired ticket / hung-gateway timeout on the host).
      const original = t.executeCommand.getMockImplementation()!
      t.executeCommand.mockImplementation(async (id: string): Promise<unknown> => {
        if (id === 'perforce.swarm.dashboard') throw new Error('timed out after 30000ms')
        return original(id)
      })
      await t.refresh()

      // Recovery with the SAME dashboard contents: nothing new → no notification.
      t.executeCommand.mockImplementation(original)
      await t.refresh()
      expect(t.notify).not.toHaveBeenCalled()
      t.dispose()
    })
  })

  // Repro for the 44-minute poll wedge: the host-side dashboard handler never
  // settled at all (its p4 credential probe hung before any HTTP happened — the
  // fetch timeout added earlier only covers the HTTP layer). A renderer-side
  // deadline must abort the wait as a failed tick, release the `_running` latch,
  // and let the next tick recover — no matter what hangs behind the RPC.
  describe('a dashboard RPC that never settles (poll latch deadline)', () => {
    afterEach(() => vi.useRealTimers())

    it('aborts the wedged poll at the deadline and the next tick notifies again', async () => {
      const t = await setup()
      const original = t.executeCommand.getMockImplementation()!
      // Dashboard RPC never settles (hung host handler); other commands behave.
      t.executeCommand.mockImplementation((id: string, arg?: unknown): Promise<unknown> => {
        if (id === 'perforce.swarm.dashboard') return new Promise(() => {})
        return original(id, arg)
      })

      // Fake timers only AFTER setup: flush() and the priming poll need real ones.
      vi.useFakeTimers()
      const wedged = t.refresh()
      // Past the dashboard deadline the poll must fail loudly and settle…
      await vi.advanceTimersByTimeAsync(121_000)
      await wedged
      expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dashboard RPC'))
      vi.useRealTimers()

      // …and the latch is free: with the host healthy again, the next tick
      // reaches the dashboard and the newly-actionable review notifies.
      t.executeCommand.mockImplementation(original)
      t.setDashboard([review('8', { description: 'after the wedge' })])
      await t.refresh()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #8: after the wedge' })
      t.dispose()
    })

    it('a hung per-review transitions RPC is skipped, not wedged', async () => {
      const t = await setup({
        config: { 'perforce.swarm.needsActionApprovableOnly': true },
        transitions: { '2': [{ state: 'approved', label: 'Approve' }] },
      })
      const original = t.executeCommand.getMockImplementation()!
      t.executeCommand.mockImplementation((id: string, arg?: unknown): Promise<unknown> => {
        if (id === 'perforce.swarm.getTransitions' && String(arg) === '1')
          return new Promise(() => {})
        return original(id, arg)
      })

      vi.useFakeTimers()
      t.setDashboard([review('1'), review('2')])
      const poll = t.refresh()
      await vi.advanceTimersByTimeAsync(61_000)
      await poll
      vi.useRealTimers()

      // The hung review's transitions resolve to none → optimistic keep, so #1
      // still notifies alongside #2 (whose transitions loaded fine).
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: '2 new reviews need your action' })
      t.dispose()
    })
  })
})
