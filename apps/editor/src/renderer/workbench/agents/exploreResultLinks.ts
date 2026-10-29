/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Explore result links — a synthetic "Saved Explore result" card carries the
 *  tool-call id of the Agent/Task call that spawned it. The chat derives this
 *  small index once per timeline update so each spawn card can offer a jump to
 *  its report without threading the map through every memoized slot.
 *--------------------------------------------------------------------------------------------*/

import type { TimelineItem } from '../../services/acp/session/acpSessionService.js'
import { itemSlotKey } from './stickyScroll.js'

export interface ExploreResultLink {
  /** Sticky/slot key of the result card (`t:<toolCallId>`). */
  readonly key: string
  /** Saved report path from the card's single diff, when present. */
  readonly path?: string
}

/** Index the synthetic Explore result cards by the spawn tool-call id they
 *  point back to. Later cards win: a resumed Explore reuses the same synthetic
 *  id and updates the existing card in place. */
export function buildExploreResultLinks(
  timeline: readonly TimelineItem[],
): ReadonlyMap<string, ExploreResultLink> {
  const links = new Map<string, ExploreResultLink>()
  for (const item of timeline) {
    if (item.kind !== 'toolCall') continue
    const spawnId = item.call.exploreResultOf
    if (spawnId === undefined) continue
    // Not createdFilePath(): it returns undefined once the card is trimmed,
    // while trimToolCall keeps every diff's path precisely so affordances like
    // this one survive memory pressure.
    const path = item.call.diffs[0]?.path
    links.set(spawnId, {
      key: itemSlotKey(item),
      ...(path !== undefined ? { path } : {}),
    })
  }
  return links
}

/** Props for one timeline slot, or `{}` when it has no linked result. Mirrors
 *  `bookmarkProp` in ChatBody so `exactOptionalPropertyTypes` never sees an
 *  explicit `undefined`. */
export function exploreResultPropsFor(
  links: ReadonlyMap<string, ExploreResultLink>,
  item: TimelineItem,
): { exploreResultKey?: string; exploreResultPath?: string } {
  if (item.kind !== 'toolCall') return {}
  const link = links.get(item.call.id)
  if (link === undefined) return {}
  return {
    exploreResultKey: link.key,
    ...(link.path !== undefined ? { exploreResultPath: link.path } : {}),
  }
}
