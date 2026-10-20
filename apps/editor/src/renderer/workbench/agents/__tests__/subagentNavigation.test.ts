/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for subagentNavigation — the pure card sequence behind Alt+Shift+J/K and
 *  the floating sub-agent pill.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  AcpChildItem,
  AcpMessage,
  AcpToolCall,
  TimelineItem,
} from '../../../services/acp/session/acpSession.js'
import {
  adjacentSubagent,
  adjacentSubagentFromCardIndex,
  currentSubagentIndex,
  subagentIndexAtOrBefore,
  subagentIndexOfKey,
  topLevelKeyOf,
  topLevelSubagentCards,
} from '../subagentNavigation.js'

function message(id: string): TimelineItem {
  const value: AcpMessage = {
    id,
    role: 'agent',
    text: id,
    blocks: [],
    streaming: false,
  }
  return { kind: 'message', id, message: value }
}

function call(id: string, overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id,
    title: id,
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

function tool(id: string, overrides: Partial<AcpToolCall> = {}): TimelineItem {
  return { kind: 'toolCall', id, call: call(id, overrides) }
}

function subagent(id: string, children: readonly AcpChildItem[] = []): TimelineItem {
  return tool(id, { subagent: true, children })
}

// m0 | task-a | m1 | task-b | m2, plus one plain tool call in between.
const timeline: readonly TimelineItem[] = [
  message('m0'),
  subagent('task-a'),
  message('m1'),
  tool('plain'),
  subagent('task-b'),
  message('m2'),
]

describe('topLevelSubagentCards', () => {
  it('keeps only sub-agent cards, in timeline order, with live indexes', () => {
    expect(topLevelSubagentCards(timeline)).toEqual([
      { key: 't:task-a', timelineIndex: 1 },
      { key: 't:task-b', timelineIndex: 4 },
    ])
  })

  it('counts a markerless card with children as a sub-agent', () => {
    const markerless = tool('task-c', {
      children: [
        {
          kind: 'message',
          id: 'c1',
          message: { id: 'c1', role: 'agent', text: 'c', blocks: [], streaming: false },
        },
      ],
    })
    expect(topLevelSubagentCards([markerless])).toEqual([{ key: 't:task-c', timelineIndex: 0 }])
  })

  it('returns nothing when the timeline has no sub-agent card', () => {
    expect(topLevelSubagentCards([message('m0'), tool('plain')])).toEqual([])
  })
})

describe('topLevelKeyOf', () => {
  it('keeps a plain key and strips a composite key', () => {
    expect(topLevelKeyOf('t:task-a')).toBe('t:task-a')
    expect(topLevelKeyOf('t:task-a/t:sub/m:child')).toBe('t:task-a')
  })
})

describe('subagentIndexOfKey', () => {
  const cards = topLevelSubagentCards(timeline)

  it('resolves a card key and a child key to the same card', () => {
    expect(subagentIndexOfKey(cards, 't:task-b')).toBe(1)
    expect(subagentIndexOfKey(cards, 't:task-b/m:child')).toBe(1)
  })

  it('returns -1 for a non-card key', () => {
    expect(subagentIndexOfKey(cards, 'm1')).toBe(-1)
    expect(subagentIndexOfKey(cards, 't:plain')).toBe(-1)
  })
})

describe('subagentIndexAtOrBefore', () => {
  const cards = topLevelSubagentCards(timeline)

  it('returns -1 above the first card', () => {
    expect(subagentIndexAtOrBefore(cards, 0)).toBe(-1)
    expect(subagentIndexAtOrBefore(cards, -1)).toBe(-1)
  })

  it('returns the exact card when the row is a card', () => {
    expect(subagentIndexAtOrBefore(cards, 1)).toBe(0)
    expect(subagentIndexAtOrBefore(cards, 4)).toBe(1)
  })

  it('returns the last card above a row between cards', () => {
    expect(subagentIndexAtOrBefore(cards, 2)).toBe(0)
    expect(subagentIndexAtOrBefore(cards, 3)).toBe(0)
    expect(subagentIndexAtOrBefore(cards, 5)).toBe(1)
  })

  it('handles an empty sequence', () => {
    expect(subagentIndexAtOrBefore([], 3)).toBe(-1)
  })
})

describe('adjacentSubagent', () => {
  const cards = topLevelSubagentCards(timeline)

  it('moves strictly forward and backward', () => {
    expect(adjacentSubagent(cards, 0, 'next')?.key).toBe('t:task-a')
    expect(adjacentSubagent(cards, 1, 'next')?.key).toBe('t:task-b')
    expect(adjacentSubagent(cards, 3, 'next')?.key).toBe('t:task-b')
    expect(adjacentSubagent(cards, 5, 'next')?.key).toBe('t:task-a')

    expect(adjacentSubagent(cards, 2, 'prev')?.key).toBe('t:task-a')
    expect(adjacentSubagent(cards, 5, 'prev')?.key).toBe('t:task-b')
    expect(adjacentSubagent(cards, 1, 'prev')?.key).toBe('t:task-b')
  })

  it('wraps at both ends', () => {
    expect(adjacentSubagent(cards, 4, 'next')?.key).toBe('t:task-a')
    expect(adjacentSubagent(cards, 5, 'next')?.key).toBe('t:task-a')
    expect(adjacentSubagent(cards, 1, 'prev')?.key).toBe('t:task-b')
    expect(adjacentSubagent(cards, 0, 'prev')?.key).toBe('t:task-b')
  })

  it('starts at the first / last card when there is no current position', () => {
    expect(adjacentSubagent(cards, -1, 'next')?.key).toBe('t:task-a')
    expect(adjacentSubagent(cards, -1, 'prev')?.key).toBe('t:task-b')
  })

  it('returns the only card from either direction', () => {
    const only = topLevelSubagentCards([subagent('task-a')])
    for (const index of [-1, only[0]!.timelineIndex]) {
      expect(adjacentSubagent(only, index, 'next')?.key).toBe('t:task-a')
      expect(adjacentSubagent(only, index, 'prev')?.key).toBe('t:task-a')
    }
  })

  it('returns undefined for an empty sequence', () => {
    expect(adjacentSubagent([], 3, 'next')).toBeUndefined()
    expect(adjacentSubagent([], 3, 'prev')).toBeUndefined()
  })
})

describe('adjacentSubagentFromCardIndex', () => {
  const cards = topLevelSubagentCards(timeline)

  it('walks from the card ordinal reported by currentSubagentIndex', () => {
    expect(adjacentSubagentFromCardIndex(cards, 0, 'next')?.key).toBe('t:task-b')
    expect(adjacentSubagentFromCardIndex(cards, 1, 'prev')?.key).toBe('t:task-a')
  })

  it('starts at the edges when there is no position', () => {
    expect(adjacentSubagentFromCardIndex(cards, -1, 'next')?.key).toBe('t:task-a')
    expect(adjacentSubagentFromCardIndex(cards, -1, 'prev')?.key).toBe('t:task-b')
  })

  it('wraps from the last / first card', () => {
    expect(adjacentSubagentFromCardIndex(cards, 1, 'next')?.key).toBe('t:task-a')
    expect(adjacentSubagentFromCardIndex(cards, 0, 'prev')?.key).toBe('t:task-b')
  })

  it('keeps the only card from either direction', () => {
    const only = topLevelSubagentCards([subagent('task-a')])
    for (const index of [-1, 0]) {
      expect(adjacentSubagentFromCardIndex(only, index, 'next')?.key).toBe('t:task-a')
      expect(adjacentSubagentFromCardIndex(only, index, 'prev')?.key).toBe('t:task-a')
    }
  })
})

interface SlotBox {
  readonly key: string
  readonly top: number
  readonly bottom: number
}

/** Minimal scroll-container stand-in: the helpers only need rects + data keys. */
function fakeContainer(
  slots: readonly SlotBox[],
  viewportTop = 0,
  viewportBottom = 100,
): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top: viewportTop, bottom: viewportBottom }),
    querySelectorAll: () =>
      slots.map((slot) => ({
        dataset: { timelineKey: slot.key },
        getBoundingClientRect: () => ({ top: slot.top, bottom: slot.bottom }),
      })),
  } as unknown as HTMLElement
}

describe('currentSubagentIndex', () => {
  const cards = topLevelSubagentCards(timeline)
  const allVisible: readonly SlotBox[] = [
    { key: 'm:m0', top: 0, bottom: 10 },
    { key: 't:task-a', top: 10, bottom: 20 },
    { key: 'm:m1', top: 20, bottom: 30 },
    { key: 't:plain', top: 30, bottom: 40 },
    { key: 't:task-b', top: 40, bottom: 50 },
    { key: 'm:m2', top: 50, bottom: 60 },
  ]

  it('prefers a focused card while it is on screen', () => {
    const container = fakeContainer(allVisible)
    expect(currentSubagentIndex(cards, timeline, 't:task-b', container)).toBe(1)
    expect(currentSubagentIndex(cards, timeline, 't:task-b/t:sub', container)).toBe(1)
  })

  it('falls back to the viewport when the focused card scrolled out of view', () => {
    const container = fakeContainer([
      { key: 't:task-a', top: -30, bottom: -20 },
      { key: 'm:m1', top: -20, bottom: -10 },
      { key: 't:plain', top: -10, bottom: 0 },
      { key: 't:task-b', top: 40, bottom: 50 },
      { key: 'm:m2', top: 50, bottom: 60 },
    ])
    // Focus still names task-a, but the reader is looking at task-b.
    expect(currentSubagentIndex(cards, timeline, 't:task-a', container)).toBe(1)
  })

  it('reports no position above the first card', () => {
    const container = fakeContainer(allVisible, 1000, 1100)
    expect(currentSubagentIndex(cards, timeline, null, container)).toBe(-1)
  })

  it('uses the focused card when there is no container yet', () => {
    expect(currentSubagentIndex(cards, timeline, 't:task-b', null)).toBe(1)
    expect(currentSubagentIndex(cards, timeline, null, null)).toBe(-1)
  })
})
