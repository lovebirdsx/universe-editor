import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'

type TimelineVirtualizer = Pick<
  Virtualizer<HTMLDivElement, Element>,
  'scrollElement' | 'scrollOffset'
>

export function shouldAdjustTimelineScrollOnSizeChange(
  item: VirtualItem,
  _delta: number,
  instance: TimelineVirtualizer,
): boolean {
  const offset = instance.scrollOffset ?? instance.scrollElement?.scrollTop ?? 0
  return item.end <= offset
}
