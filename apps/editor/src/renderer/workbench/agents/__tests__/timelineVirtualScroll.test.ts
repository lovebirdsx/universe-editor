import { describe, expect, it } from 'vitest'
import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'
import { shouldAdjustTimelineScrollOnSizeChange } from '../timelineVirtualScroll.js'

function item(start: number, size: number): VirtualItem {
  return {
    index: 0,
    start,
    size,
    end: start + size,
    key: 'row',
    lane: 0,
  }
}

function virtualizer(scrollOffset: number): Virtualizer<HTMLDivElement, Element> {
  return { scrollOffset, scrollElement: null } as unknown as Virtualizer<HTMLDivElement, Element>
}

describe('timeline virtual scroll size correction', () => {
  it('does not reverse an upward scroll when the measured row is partially visible', () => {
    const row = item(900, 200)
    const offset = 1_000

    // TanStack's default start-based rule returns true here and adds the full
    // measurement delta to scrollTop, pulling against the user's upward wheel.
    expect(row.start < offset).toBe(true)
    expect(shouldAdjustTimelineScrollOnSizeChange(row, 120, virtualizer(offset))).toBe(false)
  })

  it('keeps the visible anchor when a fully hidden row above it changes size', () => {
    expect(shouldAdjustTimelineScrollOnSizeChange(item(700, 200), 120, virtualizer(1_000))).toBe(
      true,
    )
  })

  it('does not adjust for a row below the viewport top', () => {
    expect(shouldAdjustTimelineScrollOnSizeChange(item(1_100, 200), -80, virtualizer(1_000))).toBe(
      false,
    )
  })

  it('uses the scroll element before the virtualizer has observed an offset', () => {
    const scrollElement = { scrollTop: 1_000 } as HTMLDivElement
    const instance = { scrollOffset: null, scrollElement } as Virtualizer<HTMLDivElement, Element>
    expect(shouldAdjustTimelineScrollOnSizeChange(item(700, 200), 50, instance)).toBe(true)
  })
})
