/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sticky-scroll geometry — pure helpers behind StickyScrollOverlay. Given the
 *  measured rectangles of every (possibly nested) timeline card, compute the
 *  stack of headers that should pin to the top of the chat viewport for a given
 *  scrollTop, mirroring VSCode's "containing scopes" sticky scroll with a
 *  partial push-out transition. Kept React-free so the stack maths is unit
 *  testable without a DOM.
 *--------------------------------------------------------------------------------------------*/

import type { AcpChildItem, TimelineItem } from '../../services/acp/acpSession.js'

/** Stable per-card identity, shared with ChatBody's timeline keys (`m:`/`t:`/`c:`). */
export function itemSlotKey(item: {
  readonly kind: 'message' | 'toolCall' | 'compaction'
  readonly id: string
}): string {
  switch (item.kind) {
    case 'message':
      return `m:${item.id}`
    case 'toolCall':
      return `t:${item.id}`
    case 'compaction':
      return `c:${item.id}`
  }
}

/** Compose a nested card key by joining a parent's sticky key with a child slot key. */
export function buildStickyKey(parentKey: string, child: AcpChildItem): string {
  return `${parentKey}/${itemSlotKey(child)}`
}

/**
 * Resolve a (possibly composite, `/`-joined) sticky key back to its timeline
 * item by drilling down through `children`. Returns undefined if any segment is
 * missing — e.g. the card was removed or collapsed away mid-stream.
 */
export function findByStickyKey(
  timeline: readonly TimelineItem[],
  key: string,
): TimelineItem | AcpChildItem | undefined {
  const segments = key.split('/')
  let list: readonly (TimelineItem | AcpChildItem)[] = timeline
  let found: TimelineItem | AcpChildItem | undefined
  for (const seg of segments) {
    found = list.find((it) => itemSlotKey(it) === seg)
    if (!found) return undefined
    list = found.kind === 'toolCall' ? (found.call.children ?? []) : []
  }
  return found
}

export interface CardRect {
  readonly key: string
  /** Nesting depth: top-level cards 0, their sub-timeline cards 1, … */
  readonly depth: number
  /** Top edge in scroll-content coordinates (px from the top of the content). */
  readonly top: number
  /** Bottom edge in scroll-content coordinates. */
  readonly bottom: number
  /** Height of just the card's clickable header row. */
  readonly headerHeight: number
}

export interface StickyEntry {
  readonly key: string
  readonly depth: number
  readonly headerHeight: number
  /** Y offset of this header inside the overlay (0 = viewport top). */
  readonly translateY: number
}

export interface StickyOptions {
  /** Stop stacking past this nesting depth (default 6). */
  readonly maxDepth?: number
  /** Stop stacking once headers would exceed this total height (default 50% of the container). */
  readonly maxTotalHeight?: number
}

// Cards no taller than their header (collapsed cards / one-liners) never sticky:
// pinning a header that already fully shows is pointless and just flickers.
const SHORT_CARD_EPSILON = 1

/**
 * Compute the ordered stack of sticky headers for the current scroll position.
 * Ancestors come first (shallower depth on top); the deepest header is pushed
 * up — and eventually dropped — as its card scrolls past, so transitions are
 * smooth rather than popping.
 */
export function computeStickyStack(
  rects: readonly CardRect[],
  scrollTop: number,
  containerHeight: number,
  opts?: StickyOptions,
): StickyEntry[] {
  const maxDepth = opts?.maxDepth ?? 6
  const maxTotalHeight = opts?.maxTotalHeight ?? containerHeight * 0.5

  // Containing scopes: the viewport's top line cuts through the card, and the
  // card is taller than its header (otherwise it is already fully visible).
  const containing = rects
    .filter(
      (r) =>
        r.top <= scrollTop &&
        scrollTop < r.bottom &&
        r.bottom - r.top > r.headerHeight + SHORT_CARD_EPSILON,
    )
    .sort((a, b) => a.depth - b.depth || a.top - b.top)

  const entries: StickyEntry[] = []
  let accum = 0
  for (const r of containing) {
    if (entries.length >= maxDepth) break
    if (accum + r.headerHeight > maxTotalHeight) break
    // How far the card's bottom has risen into this header's resting slot. Once
    // it eats a full header height the header has no room left → drop it.
    const push = Math.max(0, scrollTop + accum + r.headerHeight - r.bottom)
    if (push >= r.headerHeight) continue
    const translateY = accum - push
    entries.push({ key: r.key, depth: r.depth, headerHeight: r.headerHeight, translateY })
    accum = translateY + r.headerHeight
  }
  return entries
}
