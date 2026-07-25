/*---------------------------------------------------------------------------------------------
 *  mergeTimelineItems — k-way merge of per-provider timeline pages into one
 *  list ordered by timestamp desc (newest first), the TimelineView's core
 *  ordering rule (VSCode `TimelinePane` does the same across sources). Each
 *  input page is assumed already sorted desc; ties keep source order (stable).
 *  Items are deduped by `handle` — the cross-process stable key — so a page
 *  overlap can't surface the same entry twice.
 *--------------------------------------------------------------------------------------------*/

import type { ITimelineItemDto } from '@universe-editor/extensions-common'

export function mergeTimelineItems(
  sources: readonly (readonly ITimelineItemDto[])[],
): ITimelineItemDto[] {
  const positions = sources.map(() => 0)
  const seen = new Set<string>()
  const out: ITimelineItemDto[] = []
  for (;;) {
    let best = -1
    let bestTs = -Infinity
    for (let s = 0; s < sources.length; s++) {
      const item = sources[s]?.[positions[s] ?? 0]
      if (item === undefined) continue
      if (best < 0 || item.timestamp > bestTs) {
        best = s
        bestTs = item.timestamp
      }
    }
    if (best < 0) return out
    const item = sources[best]?.[positions[best] ?? 0]
    positions[best] = (positions[best] ?? 0) + 1
    if (item === undefined || seen.has(item.handle)) continue
    seen.add(item.handle)
    out.push(item)
  }
}
