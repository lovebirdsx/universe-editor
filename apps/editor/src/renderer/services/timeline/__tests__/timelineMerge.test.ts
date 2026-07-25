import { describe, expect, it } from 'vitest'
import type { ITimelineItemDto } from '@universe-editor/extensions-common'
import { mergeTimelineItems } from '../timelineMerge.js'

function item(handle: string, timestamp: number): ITimelineItemDto {
  return { handle, source: handle.split('|')[0] ?? '', label: handle, timestamp }
}

describe('mergeTimelineItems', () => {
  it('interleaves sources newest-first', () => {
    const a = [item('a|1', 300), item('a|2', 100)]
    const b = [item('b|1', 400), item('b|2', 200)]
    expect(mergeTimelineItems([a, b]).map((i) => i.handle)).toEqual(['b|1', 'a|1', 'b|2', 'a|2'])
  })

  it('keeps source order on equal timestamps', () => {
    const a = [item('a|1', 100)]
    const b = [item('b|1', 100)]
    expect(mergeTimelineItems([a, b]).map((i) => i.handle)).toEqual(['a|1', 'b|1'])
  })

  it('dedupes by handle (overlapping pages)', () => {
    const page1 = [item('g|1', 300), item('g|2', 200)]
    const page2 = [item('g|2', 200), item('g|3', 100)]
    expect(mergeTimelineItems([page1, page2]).map((i) => i.handle)).toEqual(['g|1', 'g|2', 'g|3'])
  })

  it('handles empty and missing sources', () => {
    expect(mergeTimelineItems([])).toEqual([])
    expect(mergeTimelineItems([[], [item('a|1', 1)]]).map((i) => i.handle)).toEqual(['a|1'])
  })
})
