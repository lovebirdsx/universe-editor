/*---------------------------------------------------------------------------------------------
 *  Pins the `#` chat-context picks: which candidates show, in what order, and
 *  the agent-facing text each one injects. That text must match the renderer's
 *  own entries (services/acp/chatContextFormat.ts, pinned by its own test) —
 *  the two sides cannot import each other.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { SwarmReview } from '../swarm/swarmParser.js'
import {
  buildChangelistChatPicks,
  buildSwarmChatPicks,
  changelistChatText,
  mergeSwarmPicks,
  swarmReviewChatText,
  swarmReviewUrl,
} from '../chatContext.js'

function review(over: Partial<SwarmReview> & Pick<SwarmReview, 'id'>): SwarmReview {
  return {
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'testuser',
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

describe('changelistChatText', () => {
  it('carries the id and the description first line', () => {
    expect(changelistChatText('1234', 'fix the parser\n\nlong body')).toBe(
      'Perforce changelist 1234: fix the parser',
    )
  })

  it('drops to the bare id when the description is empty', () => {
    expect(changelistChatText('1234', '  \n')).toBe('Perforce changelist 1234')
  })
})

describe('swarmReviewChatText', () => {
  it('carries id, description, state and review url', () => {
    expect(
      swarmReviewChatText({
        id: '1001',
        description: 'fix the parser',
        stateLabel: 'Needs Review',
        url: 'https://swarm.example.com/reviews/1001',
      }),
    ).toBe(
      'Swarm review 1001 "fix the parser": Needs Review — https://swarm.example.com/reviews/1001',
    )
  })

  it('omits the description and the url when they are absent', () => {
    expect(
      swarmReviewChatText({ id: '1001', description: '', stateLabel: 'Approved', url: undefined }),
    ).toBe('Swarm review 1001: Approved')
  })
})

describe('swarmReviewUrl', () => {
  it('joins the configured base url with the review id', () => {
    expect(swarmReviewUrl('https://swarm.example.com/', '1001')).toBe(
      'https://swarm.example.com/reviews/1001',
    )
  })

  it('returns undefined for an unconfigured base url', () => {
    expect(swarmReviewUrl('   ', '1001')).toBeUndefined()
  })
})

describe('buildChangelistChatPicks', () => {
  it('lists pending first, then the submitted ones', () => {
    const picks = buildChangelistChatPicks(
      [{ id: '1234', description: 'wip' }],
      [
        { id: '1200', message: 'fix the parser' },
        { id: '1199', message: '' },
      ],
    )
    expect(picks.map((p) => p.label)).toEqual([
      '#1234 · Pending',
      '#1200 · Submitted',
      '#1199 · Submitted',
    ])
    expect(picks.map((p) => p.item.text)).toEqual([
      'Perforce changelist 1234: wip',
      'Perforce changelist 1200: fix the parser',
      'Perforce changelist 1199',
    ])
  })

  it('never lists the same changelist twice', () => {
    const picks = buildChangelistChatPicks(
      [{ id: '1234', description: 'wip' }],
      [{ id: '1234', message: 'wip' }],
    )
    expect(picks).toHaveLength(1)
  })

  it('names the pill after the changelist, not the row', () => {
    const picks = buildChangelistChatPicks([{ id: '1234', description: 'wip' }], [])
    expect(picks[0]?.item.label).toBe('Perforce changelist 1234')
  })
})

describe('buildSwarmChatPicks', () => {
  it('builds one row per review, url included in the injected text', () => {
    const picks = buildSwarmChatPicks(
      [
        review({ id: '1001', description: 'fix the parser', stateLabel: 'Needs Review' }),
        review({ id: '1002', state: 'approved', stateLabel: 'Approved', description: '' }),
      ],
      'https://swarm.example.com',
    )
    expect(picks.map((p) => p.label)).toEqual(['#1001 · Needs Review', '#1002 · Approved'])
    expect(picks.map((p) => p.description)).toEqual(['fix the parser', ''])
    expect(picks[0]?.item).toEqual({
      label: 'Swarm review 1001',
      text: 'Swarm review 1001 "fix the parser": Needs Review — https://swarm.example.com/reviews/1001',
    })
    expect(picks[1]?.item.text).toBe(
      'Swarm review 1002: Approved — https://swarm.example.com/reviews/1002',
    )
  })
})

describe('mergeSwarmPicks', () => {
  it('puts needs-my-action first and keeps each group in its own order', () => {
    const merged = mergeSwarmPicks(
      [review({ id: '1001' }), review({ id: '1002' })],
      [review({ id: '2001' }), review({ id: '2002' })],
    )
    expect(merged.map((r) => r.id)).toEqual(['1001', '1002', '2001', '2002'])
  })

  it('drops the duplicate when a review I authored also needs my action', () => {
    const merged = mergeSwarmPicks(
      [review({ id: '1001', stateLabel: 'Needs Review' })],
      [review({ id: '1001', stateLabel: 'Needs Review' }), review({ id: '1002' })],
    )
    expect(merged.map((r) => r.id)).toEqual(['1001', '1002'])
  })

  it('is a pass-through when one side is empty', () => {
    expect(mergeSwarmPicks([], [review({ id: '1' })]).map((r) => r.id)).toEqual(['1'])
    expect(mergeSwarmPicks([review({ id: '1' })], []).map((r) => r.id)).toEqual(['1'])
  })
})

describe('buildChangelistChatPicks cap', () => {
  const pendingOf = (n: number): { id: string; description: string }[] =>
    Array.from({ length: n }, (_, i) => ({ id: String(9000 + i), description: `p${i}` }))
  const submittedOf = (n: number): { id: string; message: string }[] =>
    Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), message: `s${i}` }))

  it('caps the combined list at 100 rows', () => {
    const picks = buildChangelistChatPicks(pendingOf(10), submittedOf(150))
    expect(picks).toHaveLength(100)
    expect(picks[0]?.label).toBe('#9000 · Pending')
    // 10 pending + the first 90 submitted rows make the cut.
    expect(picks.at(-1)?.label).toBe('#1089 · Submitted')
  })

  it('keeps every pending row when the two lists together overflow', () => {
    const picks = buildChangelistChatPicks(pendingOf(30), submittedOf(120))
    expect(picks.slice(0, 30).every((p) => p.label.endsWith('· Pending'))).toBe(true)
    expect(picks).toHaveLength(100)
  })

  it('leaves a short list untouched', () => {
    expect(buildChangelistChatPicks(pendingOf(2), submittedOf(3))).toHaveLength(5)
  })
})
