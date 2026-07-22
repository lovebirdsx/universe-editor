/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for SwarmReviewNotificationContribution — verifies the desktop notification
 *  fires only for reviews newly entering the "final displayed" Needs My Action list
 *  (author / approvable / ignore filters applied), primes on the first poll, merges
 *  a burst into one notification, respects the enable flag, and jumps on click.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
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

async function freshModules() {
  vi.resetModules()
  const contrib = await import('../SwarmReviewNotificationContribution.js')
  const ignore = await import('../../services/swarm/swarmIgnoreStore.js')
  const viewState = await import('../../services/swarm/swarmViewState.js')
  const tick = await import('../../services/swarm/swarmNotificationTick.js')
  return { contrib, ignore, viewState, tick }
}

interface SetupOpts {
  enabled?: boolean
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
  const { contrib, ignore, tick, viewState } = await freshModules()

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
    ...opts.config,
  }
  const config = { get: (key: string) => configValues[key] } as never
  const workspace = {
    current: opts.workspaceName !== undefined ? { name: opts.workspaceName } : null,
  } as never

  const instance = new contrib.SwarmReviewNotificationContribution(
    commands,
    host,
    config,
    storage,
    workspace,
    notification,
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
    setDashboard: (needsAction: SwarmReviewDto[], authored: SwarmReviewDto[] = []) => {
      current = dashboard(needsAction, authored)
    },
    refresh: () => instance.refresh(),
  }
}

describe('SwarmReviewNotificationContribution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not notify for reviews already present at launch (priming poll)', async () => {
    // Review '1' is actionable when the contribution is constructed, so the priming
    // poll records it as baseline. A later poll with the same list must stay silent.
    const t = await setup({ initialNeedsAction: [review('1')] })
    await t.refresh()
    expect(t.notify).not.toHaveBeenCalled()
    t.instance.dispose()
  })

  it('notifies once when a new review enters the list', async () => {
    const t = await setup()
    t.setDashboard([review('1', { description: 'fix login' })])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: fix login' })
    t.instance.dispose()
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
    t.instance.dispose()
  })

  it('does not re-notify an already-notified review', async () => {
    const t = await setup()
    t.setDashboard([review('1')])
    await t.refresh()
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    t.instance.dispose()
  })

  it('merges several new reviews into a single notification', async () => {
    const t = await setup()
    t.setDashboard([review('1'), review('2'), review('3')])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: '3 new reviews need your action' })
    t.instance.dispose()
  })

  it('does not notify when perforce.swarm.notifications.enabled is false', async () => {
    const t = await setup({ enabled: false })
    t.setDashboard([review('1')])
    await t.refresh()
    expect(t.notify).not.toHaveBeenCalled()
    t.instance.dispose()
  })

  it('excludes ignored reviews from the notification', async () => {
    const t = await setup({ ignoredIds: ['2'] })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #1: review 1' })
    t.instance.dispose()
  })

  it('excludes reviews authored by the current user from the notification', async () => {
    const t = await setup()
    const ownReview = review('1', { author: 'alice' })
    t.setDashboard([ownReview, review('2', { author: 'bob' })], [ownReview])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #2: review 2' })
    t.instance.dispose()
  })

  it('publishes the sidebar-scope needs-action count (own reviews included) for the badge', async () => {
    // The badge mirrors the sidebar's "Needs My Action" group, which — unlike the
    // notification set — keeps open reviews authored by the current user.
    const t = await setup()
    const ownReview = review('1', { author: 'alice' })
    t.setDashboard([ownReview, review('2', { author: 'bob' })], [ownReview])
    await t.refresh()
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(2)
    t.instance.dispose()
  })

  it('drops ignored reviews from the published badge count', async () => {
    const t = await setup({ ignoredIds: ['2'] })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    expect(t.viewState.swarmNeedsActionCount.observable.get()).toBe(1)
    t.instance.dispose()
  })

  it('applies the author filter (only configured authors notify)', async () => {
    const t = await setup({ config: { 'perforce.swarm.needsActionAuthors': ['bob'] } })
    t.setDashboard([review('1', { author: 'alice' }), review('2', { author: 'bob' })])
    await t.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'Review #2: review 2' })
    t.instance.dispose()
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
    t.instance.dispose()
  })

  it('on click of a single-review notification opens that review', async () => {
    const t = await setup({ clicked: true })
    t.setDashboard([review('42')])
    await t.refresh()
    await flush()
    expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReview', '42')
    t.instance.dispose()
  })

  it('on click of a multi-review notification focuses the Swarm view', async () => {
    const t = await setup({ clicked: true })
    t.setDashboard([review('1'), review('2')])
    await t.refresh()
    await flush()
    expect(t.executeCommand).toHaveBeenCalledWith('swarm.openReviews')
    t.instance.dispose()
  })

  it('appends the workspace folder name on a second body line', async () => {
    const t = await setup({ workspaceName: 'universe-editor' })
    t.setDashboard([review('1', { description: 'fix login' })])
    await t.refresh()
    expect(t.notify.mock.calls[0]![0]).toMatchObject({
      body: 'Review #1: fix login\nuniverse-editor',
    })
    t.instance.dispose()
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
      t.instance.dispose()
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
      t.instance.dispose()
    })

    it('does not raise the in-app fallback when the OS toast was shown', async () => {
      const t = await setup({ shown: true })
      t.setDashboard([review('1')])
      await t.refresh()
      await flush()
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.inAppNotify).not.toHaveBeenCalled()
      t.instance.dispose()
    })

    it('stays silent when notifications are disabled', async () => {
      const t = await setup({ shown: false, enabled: false })
      t.setDashboard([review('1')])
      await t.refresh()
      await flush()
      expect(t.notify).not.toHaveBeenCalled()
      expect(t.inAppNotify).not.toHaveBeenCalled()
      t.instance.dispose()
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
      t.instance.dispose()
    })

    it('is a no-op after the contribution is disposed (handler unregistered)', async () => {
      const t = await setup()
      t.instance.dispose()
      t.setDashboard([review('9')])
      await t.tick.driveSwarmNotificationTick()
      await flush()
      expect(t.notify).not.toHaveBeenCalled()
    })
  })
})
