/*---------------------------------------------------------------------------------------------
 *  Tests for the swarm "needs action" → trigger-scheduler bridge: no IPC without
 *  an enabled swarm-review trigger, full-list reporting, description truncation,
 *  version lookup caching / retry and report serialization.
 *--------------------------------------------------------------------------------------------*/

import type { SwarmReviewDto } from '@universe-editor/extensions-common'
import { describe, expect, it, vi } from 'vitest'
import type { SwarmNeedsActionReview } from '../../../../shared/ipc/triggerService.js'
import type { TriggerSummary } from '../../../../shared/triggers/types.js'
import {
  SWARM_NEEDS_ACTION_DESCRIPTION_MAX,
  SwarmTriggerReporter,
  hasEnabledSwarmTrigger,
  toSwarmNeedsActionReview,
  type SwarmReviewVersionLookup,
} from '../swarmTriggerReporter.js'

function review(overrides: Partial<SwarmReviewDto> & Pick<SwarmReviewDto, 'id'>): SwarmReviewDto {
  return {
    id: overrides.id,
    state: overrides.state ?? 'needsReview',
    stateLabel: overrides.stateLabel ?? 'Needs Review',
    author: overrides.author ?? 'alice',
    description: overrides.description ?? 'desc',
    upVotes: overrides.upVotes ?? 0,
    downVotes: overrides.downVotes ?? 0,
    commentCount: overrides.commentCount ?? 0,
    openTaskCount: overrides.openTaskCount ?? 0,
    testStatus: overrides.testStatus ?? 'none',
    updated: overrides.updated ?? 0,
  }
}

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  const id = overrides.id ?? 'swarm-triage'
  return {
    key: `X:/workspace\u0000${id}`,
    id,
    name: 'Swarm 分诊',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    activationConfirmed: true,
    sourceType: 'swarm-review',
    status: 'idle',
    enabled: true,
    paused: false,
    elevatedMode: false,
    elevatedModeConfirmed: false,
    approveAction: false,
    approveConfirmed: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

function makeReporter(
  lookup: (reviewId: string) => Promise<SwarmReviewVersionLookup | undefined> = async () => ({
    version: 7,
  }),
) {
  const report = vi.fn(async (_reviews: readonly SwarmNeedsActionReview[]) => undefined)
  const getReviewVersion = vi.fn((reviewId: string) => lookup(reviewId))
  const logger = { debug: vi.fn(), warn: vi.fn() }
  const reporter = new SwarmTriggerReporter({ report, getReviewVersion, logger })
  return { reporter, report, getReviewVersion, logger }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('hasEnabledSwarmTrigger', () => {
  it('requires both the enabled flag and the swarm-review source', () => {
    expect(hasEnabledSwarmTrigger([summary()])).toBe(true)
    expect(hasEnabledSwarmTrigger([summary({ enabled: false })])).toBe(false)
    expect(hasEnabledSwarmTrigger([summary({ sourceType: 'schedule' })])).toBe(false)
    expect(hasEnabledSwarmTrigger([])).toBe(false)
  })
})

describe('toSwarmNeedsActionReview', () => {
  it('truncates descriptions and omits an unknown version', () => {
    const long = 'x'.repeat(SWARM_NEEDS_ACTION_DESCRIPTION_MAX + 50)
    expect(
      toSwarmNeedsActionReview(review({ id: '1', description: long, updated: 7 }), undefined),
    ).toEqual({
      reviewId: '1',
      author: 'alice',
      description: 'x'.repeat(SWARM_NEEDS_ACTION_DESCRIPTION_MAX),
      state: 'needsReview',
      updated: 7,
    })
  })

  it('carries the version when one was found', () => {
    expect(toSwarmNeedsActionReview(review({ id: '1' }), 3)).toMatchObject({ version: 3 })
  })

  // A re-shelve of an unapproved review keeps the version, so approve needs the
  // updated stamp to tell that the author pushed new changes.
  it('carries the review updated stamp so approve can detect a silent re-shelve', () => {
    expect(toSwarmNeedsActionReview(review({ id: '1', updated: 42 }), 3)).toMatchObject({
      version: 3,
      updated: 42,
    })
  })
})

describe('SwarmTriggerReporter', () => {
  it('sends nothing at all when no swarm-review trigger is enabled', async () => {
    const { reporter, report, getReviewVersion } = makeReporter()
    reporter.setTriggers([summary({ enabled: false })])
    await reporter.report([review({ id: '1' })])
    expect(report).not.toHaveBeenCalled()
    expect(getReviewVersion).not.toHaveBeenCalled()
  })

  it('reports the full list with each review version and updated stamp', async () => {
    const { reporter, report } = makeReporter(async (id) => ({ version: Number(id) }))
    reporter.setTriggers([summary()])
    await reporter.report([
      review({ id: '101', author: 'bob', updated: 11 }),
      review({ id: '102', updated: 12 }),
    ])
    expect(report).toHaveBeenCalledWith([
      {
        reviewId: '101',
        author: 'bob',
        description: 'desc',
        state: 'needsReview',
        updated: 11,
        version: 101,
      },
      {
        reviewId: '102',
        author: 'alice',
        description: 'desc',
        state: 'needsReview',
        updated: 12,
        version: 102,
      },
    ])
  })

  it('reports an empty list too (main owns the dedupe baseline)', async () => {
    const { reporter, report } = makeReporter()
    reporter.setTriggers([summary()])
    await reporter.report([])
    expect(report).toHaveBeenCalledWith([])
  })

  it('reuses a version until the review updated stamp moves', async () => {
    const { reporter, getReviewVersion } = makeReporter(async () => ({ version: 4 }))
    reporter.setTriggers([summary()])
    await reporter.report([review({ id: '1', updated: 10 })])
    await reporter.report([review({ id: '1', updated: 10 })])
    expect(getReviewVersion).toHaveBeenCalledTimes(1)
    await reporter.report([review({ id: '1', updated: 11 })])
    expect(getReviewVersion).toHaveBeenCalledTimes(2)
  })

  it('retries a failed version lookup on the next report', async () => {
    let fail = true
    const { reporter, getReviewVersion } = makeReporter(async () =>
      fail ? undefined : { version: 5 },
    )
    reporter.setTriggers([summary()])
    await reporter.report([review({ id: '1' })])
    fail = false
    await reporter.report([review({ id: '1' })])
    expect(getReviewVersion).toHaveBeenCalledTimes(2)
  })

  it('drops cached versions for reviews that left the list', async () => {
    const { reporter, getReviewVersion } = makeReporter(async () => ({ version: 1 }))
    reporter.setTriggers([summary()])
    await reporter.report([review({ id: '1' })])
    await reporter.report([])
    await reporter.report([review({ id: '1' })])
    expect(getReviewVersion).toHaveBeenCalledTimes(2)
  })

  it('serializes overlapping reports', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { reporter, report } = makeReporter()
    report.mockImplementationOnce(async () => {
      await gate
    })
    reporter.setTriggers([summary()])
    const first = reporter.report([review({ id: '1' })])
    const second = reporter.report([review({ id: '2' })])
    await flush()
    expect(report).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('swallows reporting errors after logging them', async () => {
    const { reporter, report, logger } = makeReporter()
    report.mockRejectedValueOnce(new Error('ipc broke'))
    reporter.setTriggers([summary()])
    await reporter.report([review({ id: '1' })])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ipc broke'))
  })
})
