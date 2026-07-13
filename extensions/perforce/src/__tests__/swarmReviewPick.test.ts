import { describe, it, expect } from 'vitest'
import { buildReviewPicks } from '../swarm/swarmReviewPick.js'
import type { SwarmReview } from '../swarm/swarmParser.js'

function review(over: Partial<SwarmReview> & Pick<SwarmReview, 'id' | 'state'>): SwarmReview {
  return {
    stateLabel: over.state,
    author: 'me',
    description: '',
    upVotes: 0,
    downVotes: 0,
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'none',
    updated: 0,
    ...over,
  }
}

describe('buildReviewPicks', () => {
  it('drops terminal reviews (approved / rejected / archived)', () => {
    const picks = buildReviewPicks([
      review({ id: '1', state: 'approved' }),
      review({ id: '2', state: 'rejected' }),
      review({ id: '3', state: 'archived' }),
      review({ id: '4', state: 'needsReview' }),
    ])
    expect(picks.map((p) => p.reviewId)).toEqual(['4'])
  })

  it('ranks needsRevision above needsReview', () => {
    const picks = buildReviewPicks([
      review({ id: 'a', state: 'needsReview', updated: 100 }),
      review({ id: 'b', state: 'needsRevision', updated: 50 }),
    ])
    expect(picks.map((p) => p.reviewId)).toEqual(['b', 'a'])
  })

  it('orders newest-updated first within the same rank', () => {
    const picks = buildReviewPicks([
      review({ id: 'old', state: 'needsReview', updated: 10 }),
      review({ id: 'new', state: 'needsReview', updated: 20 }),
    ])
    expect(picks.map((p) => p.reviewId)).toEqual(['new', 'old'])
  })

  it('formats label / description / detail', () => {
    const picks = buildReviewPicks([
      review({
        id: '77',
        state: 'needsRevision',
        stateLabel: 'Needs Revision',
        description: 'Fix the widget\nmore body',
        upVotes: 2,
        downVotes: 1,
        commentCount: 3,
      }),
    ])
    expect(picks[0]).toEqual({
      label: '#77 · Needs Revision',
      description: 'Fix the widget',
      detail: '↑2 ↓1 · 3 comments',
      reviewId: '77',
    })
  })

  it('returns an empty list when nothing is open', () => {
    expect(buildReviewPicks([review({ id: '1', state: 'approved' })])).toEqual([])
  })
})
