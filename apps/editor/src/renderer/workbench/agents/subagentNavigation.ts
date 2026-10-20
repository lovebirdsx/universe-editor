/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sub-agent card navigation — pure helpers behind Alt+Shift+J/K and the floating
 *  `‹ 2/5 ›` pill. Cards are identified by their stable top-level slot key and
 *  their live timeline index; indexes are never persisted because streaming
 *  appends new cards.
 *--------------------------------------------------------------------------------------------*/

import type { TimelineItem } from '../../services/acp/session/acpSession.js'
import { itemSlotKey } from './stickyScroll.js'
import { isSubagentCard } from './timelineCollapse.js'

export interface SubagentCardRef {
  readonly key: string
  readonly timelineIndex: number
}

/** Top-level sub-agent cards in timeline order. Nested cards stay reachable
 *  through the ordinary row navigation once their parent is expanded. */
export function topLevelSubagentCards(timeline: readonly TimelineItem[]): SubagentCardRef[] {
  const cards: SubagentCardRef[] = []
  for (let timelineIndex = 0; timelineIndex < timeline.length; timelineIndex++) {
    const item = timeline[timelineIndex]!
    if (!isSubagentCard(item)) continue
    cards.push({ key: itemSlotKey(item), timelineIndex })
  }
  return cards
}

/** The top-level slot segment of a (possibly composite) sticky key. */
export function topLevelKeyOf(key: string): string {
  return key.split('/')[0] ?? key
}

/** Index of the card a (possibly nested) key belongs to, or -1. */
export function subagentIndexOfKey(cards: readonly SubagentCardRef[], key: string): number {
  const top = topLevelKeyOf(key)
  return cards.findIndex((card) => card.key === top)
}

/** Index of the last card at or above `timelineIndex` — what the pill shows for
 *  a viewport whose top row is not itself a card. -1 when the viewport is above
 *  every card. */
export function subagentIndexAtOrBefore(
  cards: readonly SubagentCardRef[],
  timelineIndex: number,
): number {
  let low = 0
  let high = cards.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    const card = cards[middle]!
    if (card.timelineIndex <= timelineIndex) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * The card after / before `timelineIndex`, wrapping at both ends (next after
 * the last returns the first; prev before the first returns the last). A
 * negative index means "no current position": next starts at the first card
 * and prev at the last. Only an empty sequence returns undefined.
 */
export function adjacentSubagent(
  cards: readonly SubagentCardRef[],
  timelineIndex: number,
  direction: 'next' | 'prev',
): SubagentCardRef | undefined {
  if (cards.length === 0) return undefined
  if (timelineIndex < 0) {
    return direction === 'next' ? cards[0] : cards[cards.length - 1]
  }
  if (direction === 'next') {
    return cards.find((card) => card.timelineIndex > timelineIndex) ?? cards[0]
  }
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i]!
    if (card.timelineIndex < timelineIndex) return card
  }
  return cards[cards.length - 1]
}

/**
 * Next/previous card from a card index — the counterpart of
 * {@link currentSubagentIndex}, which returns an index into `cards` rather than
 * a timeline index. Keeping the translation here stops callers from feeding a
 * card index into {@link adjacentSubagent}'s timeline-index parameter. Wrapping
 * (including a single-card sequence) is inherited from that function.
 */
export function adjacentSubagentFromCardIndex(
  cards: readonly SubagentCardRef[],
  cardIndex: number,
  direction: 'next' | 'prev',
): SubagentCardRef | undefined {
  const current = cardIndex >= 0 ? cards[cardIndex] : undefined
  return adjacentSubagent(cards, current?.timelineIndex ?? -1, direction)
}

// DOM helpers below are used by the floating pill and keyboard navigation. They
// rely on `data-timeline-key`, which only top-level slots carry (nested cards use
// composite `data-sticky-key`s), so they work in both the virtualized window and
// the fully rendered plain list.

/** First top-level slot still intersecting the scroll viewport. */
export function firstVisibleTimelineKey(container: HTMLElement): string | undefined {
  const containerTop = container.getBoundingClientRect().top
  for (const node of container.querySelectorAll<HTMLElement>('[data-timeline-key]')) {
    const key = node.dataset['timelineKey']
    if (!key) continue
    if (node.getBoundingClientRect().bottom > containerTop) return key
  }
  return undefined
}

/** Whether the top-level slot `key` intersects the scroll viewport. */
export function isTimelineKeyVisible(container: HTMLElement, key: string): boolean {
  const containerRect = container.getBoundingClientRect()
  for (const node of container.querySelectorAll<HTMLElement>('[data-timeline-key]')) {
    if (node.dataset['timelineKey'] !== key) continue
    const rect = node.getBoundingClientRect()
    return rect.bottom > containerRect.top && rect.top < containerRect.bottom
  }
  return false
}

/**
 * The card the viewport is "on": the focused card while it is still visible,
 * otherwise the last card at or above the first visible row. The pill's counter
 * and `moveSubagent` must both call this — if the command trusts a stale focus
 * that has scrolled off-screen, an enabled arrow can silently do nothing or jump
 * the wrong way relative to the number the user is reading.
 */
export function currentSubagentIndex(
  cards: readonly SubagentCardRef[],
  timeline: readonly TimelineItem[],
  focusedKey: string | null,
  container: HTMLElement | null,
): number {
  const focusedIndex = focusedKey === null ? -1 : subagentIndexOfKey(cards, focusedKey)
  if (container === null) return focusedIndex
  if (
    focusedIndex >= 0 &&
    focusedKey !== null &&
    isTimelineKeyVisible(container, topLevelKeyOf(focusedKey))
  ) {
    return focusedIndex
  }
  const anchorKey = firstVisibleTimelineKey(container)
  if (anchorKey === undefined) return -1
  return subagentIndexAtOrBefore(
    cards,
    timeline.findIndex((item) => itemSlotKey(item) === anchorKey),
  )
}
