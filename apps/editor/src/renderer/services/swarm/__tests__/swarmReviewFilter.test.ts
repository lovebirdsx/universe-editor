/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import type { SwarmReviewDto, SwarmTransitionDto } from '@universe-editor/extensions-common'
import {
  canApproveReview,
  filterAuthored,
  filterNeedsAction,
  type SwarmReviewFilterConfig,
} from '../swarmReviewFilter.js'

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

const approve: SwarmTransitionDto[] = [{ state: 'approved', label: 'Approve' }]
const rejectOnly: SwarmTransitionDto[] = [{ state: 'rejected', label: 'Reject' }]

const baseConfig: SwarmReviewFilterConfig = {
  needsActionAuthors: [],
  needsActionApprovableOnly: false,
  authoredHideApproved: false,
}

describe('canApproveReview', () => {
  it('is true when an approved transition is offered', () => {
    expect(canApproveReview(approve)).toBe(true)
    expect(canApproveReview([{ state: 'approved:commit', label: 'Approve and Commit' }])).toBe(true)
  })
  it('is false without one, or when transitions are unknown', () => {
    expect(canApproveReview(rejectOnly)).toBe(false)
    expect(canApproveReview(undefined)).toBe(false)
  })
})

describe('filterNeedsAction', () => {
  const reviews = [
    review({ id: '1', author: 'alice' }),
    review({ id: '2', author: 'bob' }),
    review({ id: '3', author: 'carol' }),
  ]

  it('returns all when no filters set', () => {
    expect(filterNeedsAction(reviews, baseConfig, {}).map((r) => r.id)).toEqual(['1', '2', '3'])
  })

  it('keeps only reviews whose author is in the configured set', () => {
    const config = { ...baseConfig, needsActionAuthors: ['alice', 'carol'] }
    expect(filterNeedsAction(reviews, config, {}).map((r) => r.id)).toEqual(['1', '3'])
  })

  it('empty author set means no author filtering', () => {
    expect(filterNeedsAction(reviews, baseConfig, {}).length).toBe(3)
  })

  it('drops non-approvable reviews when approvable-only is on and transitions loaded', () => {
    const config = { ...baseConfig, needsActionApprovableOnly: true }
    const transitions = { '1': approve, '2': rejectOnly, '3': approve }
    expect(filterNeedsAction(reviews, config, transitions).map((r) => r.id)).toEqual(['1', '3'])
  })

  it('keeps reviews with unknown transitions optimistically under approvable-only', () => {
    const config = { ...baseConfig, needsActionApprovableOnly: true }
    const transitions = { '1': rejectOnly }
    // #2 / #3 have no loaded transitions yet → kept until they resolve.
    expect(filterNeedsAction(reviews, config, transitions).map((r) => r.id)).toEqual(['2', '3'])
  })

  it('combines author and approvable-only filters', () => {
    const config = {
      ...baseConfig,
      needsActionAuthors: ['alice', 'bob'],
      needsActionApprovableOnly: true,
    }
    const transitions = { '1': approve, '2': rejectOnly, '3': approve }
    expect(filterNeedsAction(reviews, config, transitions).map((r) => r.id)).toEqual(['1'])
  })
})

describe('filterAuthored', () => {
  const reviews = [
    review({ id: '1', state: 'needsReview' }),
    review({ id: '2', state: 'approved' }),
    review({ id: '3', state: 'needsRevision' }),
  ]

  it('returns all when hide-approved is off', () => {
    expect(filterAuthored(reviews, baseConfig).map((r) => r.id)).toEqual(['1', '2', '3'])
  })

  it('hides approved reviews when the toggle is on', () => {
    const config = { ...baseConfig, authoredHideApproved: true }
    expect(filterAuthored(reviews, config).map((r) => r.id)).toEqual(['1', '3'])
  })
})
