/*---------------------------------------------------------------------------------------------
 *  Tests for the swarm "needs action" → trigger-scheduler bridge: no IPC without
 *  an enabled event trigger, full-list reporting, description truncation, the
 *  configured Swarm URL and report serialization.
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
    fingerprint: 'fp-swarm',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    activationConfirmed: true,
    sourceType: 'event',
    source: { type: 'event', event: 'swarm.reviewNeedsAction' },
    status: 'idle',
    enabled: true,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    elevatedMode: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

function makeReporter(
  swarmUrl: () => string | undefined = () => 'https://swarm.example.com',
  swarmApiVersion: () => string | undefined = () => 'v9',
) {
  const report = vi.fn(async (_reviews: readonly SwarmNeedsActionReview[]) => undefined)
  const logger = { debug: vi.fn(), warn: vi.fn() }
  const reporter = new SwarmTriggerReporter({ report, swarmUrl, swarmApiVersion, logger })
  return { reporter, report, logger }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('hasEnabledSwarmTrigger', () => {
  it('requires an enabled event trigger listening for swarm.reviewNeedsAction', () => {
    expect(hasEnabledSwarmTrigger([summary()])).toBe(true)
    expect(hasEnabledSwarmTrigger([summary({ enabled: false })])).toBe(false)
    expect(
      hasEnabledSwarmTrigger([
        summary({ source: { type: 'schedule', everyMin: 60, onMissed: 'skip' } }),
      ]),
    ).toBe(false)
    expect(
      hasEnabledSwarmTrigger([
        summary({ source: { type: 'event', event: 'other.event' as never } }),
      ]),
    ).toBe(false)
    expect(hasEnabledSwarmTrigger([summary({ source: { type: 'manual' } })])).toBe(false)
    expect(hasEnabledSwarmTrigger([])).toBe(false)
  })
})

describe('toSwarmNeedsActionReview', () => {
  it('truncates descriptions and omits an empty URL', () => {
    const long = 'x'.repeat(SWARM_NEEDS_ACTION_DESCRIPTION_MAX + 50)
    expect(
      toSwarmNeedsActionReview(review({ id: '1', description: long }), undefined, undefined),
    ).toEqual({
      reviewId: '1',
      author: 'alice',
      description: 'x'.repeat(SWARM_NEEDS_ACTION_DESCRIPTION_MAX),
      state: 'needsReview',
    })
  })

  it('carries the configured Swarm URL and API version so the agent calls the same server', () => {
    expect(
      toSwarmNeedsActionReview(review({ id: '1' }), 'https://swarm.example.com', 'v11'),
    ).toMatchObject({ swarmUrl: 'https://swarm.example.com', swarmApiVersion: 'v11' })
  })
})

describe('SwarmTriggerReporter', () => {
  it('sends nothing at all when no matching event trigger is enabled', async () => {
    const { reporter, report } = makeReporter()
    reporter.setTriggers([summary({ enabled: false })])
    await reporter.report([review({ id: '1' })])
    expect(report).not.toHaveBeenCalled()
  })

  it('reports the full list with the configured Swarm URL and API version', async () => {
    const { reporter, report } = makeReporter()
    reporter.setTriggers([summary()])
    await reporter.report([
      review({ id: '101', author: 'bob' }),
      review({ id: '102', updated: 12 }),
    ])
    expect(report).toHaveBeenCalledWith([
      {
        reviewId: '101',
        author: 'bob',
        description: 'desc',
        state: 'needsReview',
        swarmUrl: 'https://swarm.example.com',
        swarmApiVersion: 'v9',
      },
      {
        reviewId: '102',
        author: 'alice',
        description: 'desc',
        state: 'needsReview',
        swarmUrl: 'https://swarm.example.com',
        swarmApiVersion: 'v9',
      },
    ])
  })

  it('omits the URL and API version when they are not configured', async () => {
    const { reporter, report } = makeReporter(
      () => undefined,
      () => undefined,
    )
    reporter.setTriggers([summary()])
    await reporter.report([review({ id: '1' })])
    expect(report).toHaveBeenCalledWith([
      { reviewId: '1', author: 'alice', description: 'desc', state: 'needsReview' },
    ])
  })

  it('reports an empty list too (main owns the dedupe baseline)', async () => {
    const { reporter, report } = makeReporter()
    reporter.setTriggers([summary()])
    await reporter.report([])
    expect(report).toHaveBeenCalledWith([])
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
