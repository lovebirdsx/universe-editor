/*---------------------------------------------------------------------------------------------
 *  Pins the agent-facing text the "Send to Agent Chat" entries inject. The
 *  perforce extension builds the same two strings for its `#` providers
 *  (extensions/perforce/src/chatContext.ts, pinned by its own test) — an
 *  extension cannot import renderer code, so a change here must be mirrored
 *  there.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { formatChangelistText, formatSwarmReviewText } from '../chatContextFormat.js'

describe('formatChangelistText', () => {
  it('uses the description first line', () => {
    expect(formatChangelistText('1234', 'fix the parser\n\nlong body')).toBe(
      'Perforce changelist 1234: fix the parser',
    )
  })

  it('drops to the bare id when there is no description', () => {
    expect(formatChangelistText('1234', '   \n\n')).toBe('Perforce changelist 1234')
  })
})

describe('formatSwarmReviewText', () => {
  it('carries the id, description, state and review url', () => {
    expect(
      formatSwarmReviewText({
        id: '1001',
        description: 'fix the parser',
        stateLabel: 'Needs Review',
        url: 'https://swarm.example.com/reviews/1001',
      }),
    ).toBe(
      'Swarm review 1001 "fix the parser": Needs Review — https://swarm.example.com/reviews/1001',
    )
  })

  it('omits the description when Swarm has none', () => {
    expect(
      formatSwarmReviewText({
        id: '1001',
        description: ' ',
        stateLabel: 'Approved',
        url: undefined,
      }),
    ).toBe('Swarm review 1001: Approved')
  })
})
