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
