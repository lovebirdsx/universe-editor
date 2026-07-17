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

function dashboard(needsAction: SwarmReviewDto[]): SwarmDashboardResult {
  return { needsAction, authored: [], participating: [] }
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
  return { contrib, ignore, viewState }
}

interface SetupOpts {
  enabled?: boolean
  clicked?: boolean
  config?: Record<string, unknown>
  transitions?: Record<string, SwarmTransitionDto[]>
  ignoredIds?: string[]
  workspaceName?: string
  /** Reviews already actionable at construction time (seed the priming baseline). */
  initialNeedsAction?: SwarmReviewDto[]
}

async function setup(opts: SetupOpts = {}) {
  const { contrib, ignore } = await freshModules()

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
    shown: true,
    clicked: opts.clicked ?? false,
  }))

  const commands = { executeCommand } as never
  const host = { notify } as never
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
  )
  // Let the constructor's priming poll complete (baseline, no notification).
  await flush()

  return {
    instance,
    notify,
    executeCommand,
    setDashboard: (needsAction: SwarmReviewDto[]) => {
      current = dashboard(needsAction)
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
})
