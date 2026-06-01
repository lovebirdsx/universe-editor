/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AcpToolCall, TimelineItem } from '../../../services/acp/acpSession.js'
import {
  buildStickyKey,
  computeStickyStack,
  findByStickyKey,
  itemSlotKey,
  type CardRect,
} from '../stickyScroll.js'

function toolCall(id: string, over: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id,
    title: `tool ${id}`,
    kind: 'execute',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...over,
  }
}

function msgItem(id: string): TimelineItem {
  return {
    kind: 'message',
    id,
    message: { id, role: 'agent', text: '', blocks: [], streaming: false },
  }
}

function toolItem(id: string, over?: Partial<AcpToolCall>): TimelineItem {
  return { kind: 'toolCall', id, call: toolCall(id, over) }
}

function rect(
  key: string,
  depth: number,
  top: number,
  bottom: number,
  headerHeight = 24,
): CardRect {
  return { key, depth, top, bottom, headerHeight }
}

describe('itemSlotKey / buildStickyKey', () => {
  it('prefixes message and tool ids', () => {
    expect(itemSlotKey(msgItem('a'))).toBe('m:a')
    expect(itemSlotKey(toolItem('b'))).toBe('t:b')
  })

  it('joins a parent key with a child slot key', () => {
    const child = { kind: 'toolCall', id: 'c', call: toolCall('c') } as const
    expect(buildStickyKey('t:p', child)).toBe('t:p/t:c')
  })
})

describe('findByStickyKey', () => {
  const child = { kind: 'toolCall', id: 'c1', call: toolCall('c1') } as const
  const parent = toolItem('p1', { children: [child] })
  const timeline: TimelineItem[] = [msgItem('m1'), parent]

  it('finds a top-level item', () => {
    expect(findByStickyKey(timeline, 't:p1')).toBe(parent)
    expect(findByStickyKey(timeline, 'm:m1')).toBe(timeline[0])
  })

  it('drills into nested children via composite key', () => {
    expect(findByStickyKey(timeline, 't:p1/t:c1')).toBe(child)
  })

  it('returns undefined for a missing segment', () => {
    expect(findByStickyKey(timeline, 't:nope')).toBeUndefined()
    expect(findByStickyKey(timeline, 't:p1/t:nope')).toBeUndefined()
    expect(findByStickyKey(timeline, 'm:m1/t:c1')).toBeUndefined()
  })
})

describe('computeStickyStack', () => {
  it('returns empty when no card contains the top line', () => {
    const rects = [rect('t:a', 0, 0, 100)]
    expect(computeStickyStack(rects, 200, 600)).toEqual([])
  })

  it('pins a single tall card whose top scrolled past', () => {
    const rects = [rect('t:a', 0, 0, 500)]
    const stack = computeStickyStack(rects, 100, 600)
    expect(stack).toEqual([{ key: 't:a', depth: 0, headerHeight: 24, translateY: 0 }])
  })

  it('skips short cards that already fully show their header', () => {
    const rects = [rect('t:a', 0, 0, 20, 24)] // bottom-top < header
    expect(computeStickyStack(rects, 5, 600)).toEqual([])
  })

  it('stacks an ancestor and its nested child, shallow on top', () => {
    const rects = [rect('t:p', 0, 0, 800, 24), rect('t:p/t:c', 1, 200, 700, 20)]
    const stack = computeStickyStack(rects, 300, 600)
    expect(stack.map((e) => e.key)).toEqual(['t:p', 't:p/t:c'])
    expect(stack[0]).toMatchObject({ depth: 0, translateY: 0 })
    // child stacks below the parent header (accum = parent headerHeight)
    expect(stack[1]).toMatchObject({ depth: 1, translateY: 24 })
  })

  it('pushes the deepest header up as its card nears the bottom', () => {
    const rects = [rect('t:p', 0, 0, 800, 24), rect('t:p/t:c', 1, 200, 320, 20)]
    // scrollTop near child bottom: push = 310 + 24 + 20 - 320 = 34 >= 20 → child dropped
    expect(computeStickyStack(rects, 310, 600).map((e) => e.key)).toEqual(['t:p'])
    // a bit earlier: partial push, child still present but lifted
    const partial = computeStickyStack(rects, 290, 600)
    expect(partial.map((e) => e.key)).toEqual(['t:p', 't:p/t:c'])
    expect(partial[1]!.translateY).toBeLessThan(24)
  })

  it('honours maxDepth', () => {
    const rects = [
      rect('t:a', 0, 0, 900),
      rect('t:a/t:b', 1, 10, 880),
      rect('t:a/t:b/t:c', 2, 20, 860),
    ]
    expect(computeStickyStack(rects, 100, 2000, { maxDepth: 2 }).map((e) => e.key)).toEqual([
      't:a',
      't:a/t:b',
    ])
  })

  it('honours maxTotalHeight', () => {
    const rects = [rect('t:a', 0, 0, 900, 40), rect('t:a/t:b', 1, 10, 880, 40)]
    // maxTotalHeight 50 only fits the first 40px header (40+40 > 50)
    expect(computeStickyStack(rects, 100, 0, { maxTotalHeight: 50 }).map((e) => e.key)).toEqual([
      't:a',
    ])
  })
})
