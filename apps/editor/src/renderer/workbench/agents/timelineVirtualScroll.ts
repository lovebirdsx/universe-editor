import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'

type TimelineVirtualizer = Pick<
  Virtualizer<HTMLDivElement, Element>,
  'scrollElement' | 'scrollOffset'
>

// E2E-only diagnostic: each time the size-change correction actually fires we
// push its {delta, offset}. The scroll-jitter regression spec
// (smoke.agentsScrollJitter) reads this to prove no self-sustaining correction
// loop survives while the view is at rest. The array only exists when a spec
// installs it; in normal runs the global is undefined and this is a no-op.
declare global {
  interface Window {
    __TIMELINE_SIZE_CORRECTIONS_TOTAL__?: Array<{ delta: number; offset: number }>
  }
}

function recordCorrection(delta: number, offset: number): void {
  const buf = (globalThis as typeof globalThis & Window).__TIMELINE_SIZE_CORRECTIONS_TOTAL__
  if (!buf) return
  buf.push({ delta, offset })
  if (buf.length > 5000) buf.shift()
}

// TanStack Virtual's size-change scroll compensation policy. When a measured row
// changes height, the virtualizer optionally shifts scrollTop by the delta so the
// content the user is looking at stays put. The default rule (`item.start <
// scrollOffset`) also compensates for a row only PARTIALLY above the viewport top,
// which fights an in-progress upward scroll. We restrict it to rows ENTIRELY above
// the viewport (`item.end <= scrollOffset`): those are off-screen, so pushing the
// content down to keep the visible anchor put is correct and invisible.
//
// Note this predicate is necessary but not sufficient to avoid the scroll-jitter
// limit cycle: if a row above the viewport keeps re-measuring a DIFFERENT height on
// every (re)mount (e.g. a card that renders tall then async-clamps short), each
// correction remounts it, it flashes tall again, and scrollTop oscillates forever.
// The real fix for that lives at the height source (stable first-paint height); see
// TerminalOutput in ToolCallOutput.tsx.
export function shouldAdjustTimelineScrollOnSizeChange(
  item: VirtualItem,
  _delta: number,
  instance: TimelineVirtualizer,
): boolean {
  const offset = instance.scrollOffset ?? instance.scrollElement?.scrollTop ?? 0
  const adjust = item.end <= offset
  if (adjust) recordCorrection(_delta, offset)
  return adjust
}
