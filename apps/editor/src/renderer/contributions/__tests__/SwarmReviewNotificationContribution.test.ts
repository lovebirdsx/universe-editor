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
  const executeCommand = vi.fn(async (id: string, arg?: unknown): Promise<unknown> => {
    if (id === 'perforce.swarm.dashboard') return current
    if (id === 'perforce.swarm.getTransitions')
      return opts.transitions?.[String(arg)] ?? ([] as SwarmTransitionDto[])
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
      affectsConfiguration: (k) => k === 'perforce.swarm.backgroundPoll.enabled',
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
      affectsConfiguration: (k) => k === 'perforce.swarm.backgroundPoll.enabled',
    })
    await flush()

    // Stale badge cleared; further refreshes (timer / host tick) are inert.
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(0)
    t.executeCommand.mockClear()
    await t.refresh()
    expect(t.executeCommand).not.toHaveBeenCalled()
    t.dispose()
  })

  it('pushes the switch to the host poll driver when setBackgroundPoll is registered', async () => {
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
    expect(setBackgroundPoll).toHaveBeenCalledWith(true)
    instance.dispose()
    dashboardCmd.dispose()
    pushCmd.dispose()
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
