/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Collapse resolution for timeline cards — shared by ChatBody (top-level slots)
 *  and ToolCallCard (nested sub-agent cards) so a single override store keyed by
 *  (possibly composite) sticky keys drives folding everywhere: chevron clicks,
 *  Alt+F, the sticky-scroll overlay, outline reveals, and persistence.
 *--------------------------------------------------------------------------------------------*/

import type { CollapseMode } from '../../services/acp/session/acpChatViewStateCache.js'
import type { AcpChildItem, TimelineItem } from '../../services/acp/session/acpSession.js'
import { buildStickyKey, findByStickyKey } from './stickyScroll.js'
import { createdFilePath } from './toolCallDisplay.js'

export interface CollapseState {
  readonly mode: CollapseMode
  readonly overrides: ReadonlyMap<string, boolean>
}

// Per-kind default under the `default` mode: read/search / sub-agent-parent
// tool calls start collapsed, everything else (thought messages included)
// starts expanded. A whole-file write (Write / add file) is an `edit` card by
// shape but a new document by content — folded so it does not flood the
// timeline; its header carries a preview / open affordance instead.
export function defaultCollapsed(item: TimelineItem | AcpChildItem, mode: CollapseMode): boolean {
  if (mode === 'collapsed') return true
  if (mode === 'expanded') return false
  switch (item.kind) {
    case 'message':
      return false
    case 'toolCall':
      if (createdFilePath(item.call) !== undefined) return true
      return item.call.kind !== 'edit' && item.call.kind !== 'switch_mode'
    case 'compaction':
    case 'resurrection':
      // A single-line status card — nothing to fold.
      return false
  }
}

// An explicit per-item override wins; otherwise fall back to the mode default.
export function resolveCollapsed(
  key: string,
  item: TimelineItem | AcpChildItem,
  state: CollapseState,
): boolean {
  const override = state.overrides.get(key)
  return override !== undefined ? override : defaultCollapsed(item, state.mode)
}

export function nextCollapseMode(mode: CollapseMode): CollapseMode {
  switch (mode) {
    case 'default':
      return 'collapsed'
    case 'collapsed':
      return 'expanded'
    case 'expanded':
      return 'default'
  }
}

/**
 * `key`'s own card plus every descendant card, pre-order (outermost first) —
 * the fold set behind "Collapse Card and Children". Empty when the key resolves
 * to nothing, so a stale key leaves the fold state untouched.
 *
 * Recurses through `AcpChildItem.call.children` exactly like ToolCallCard
 * renders nested cards: the model nests one level deep today, but encoding that
 * limit here as well would make the two disagree the day it changes.
 */
export function subtreeCardKeys(timeline: readonly TimelineItem[], key: string): string[] {
  const root = findByStickyKey(timeline, key)
  if (!root) return []
  const keys: string[] = []
  const walk = (item: TimelineItem | AcpChildItem, itemKey: string): void => {
    keys.push(itemKey)
    if (item.kind !== 'toolCall') return
    for (const child of item.call.children ?? []) {
      walk(child, buildStickyKey(itemKey, child))
    }
  }
  walk(root, key)
  return keys
}

/**
 * Resolve every ancestor of a composite key (`t:task/t:sub/m:sm2` → `t:task`,
 * `t:task/t:sub`), outermost first, each paired with the item it resolves to.
 * `undefined` when any segment on the way is missing — the key is stale, so the
 * whole chain (including the target) is gone. The shared walk behind every
 * reveal: a folded card does not mount its body, so nothing under it exists in
 * the DOM.
 */
function resolveAncestors(
  timeline: readonly TimelineItem[],
  key: string,
): { key: string; item: TimelineItem | AcpChildItem }[] | undefined {
  const segments = key.split('/')
  const ancestors: { key: string; item: TimelineItem | AcpChildItem }[] = []
  let prefix = segments[0] ?? key
  for (let i = 0; i < segments.length - 1; i++) {
    if (i > 0) prefix = `${prefix}/${segments[i]}`
    const item = findByStickyKey(timeline, prefix)
    if (!item) return undefined
    ancestors.push({ key: prefix, item })
  }
  return ancestors
}

/**
 * The ancestors of a composite key that are currently folded, outermost first —
 * exactly the cards blocking a reveal of `key`. Empty when every ancestor is
 * already expanded, and when `key` resolves to nothing (a stale key reveals no
 * target, so the caller must not touch the fold state). Multi-level paths
 * collect every folded ancestor, so one reveal unfolds the whole chain. The
 * target itself is never included: a folded target still renders its own row.
 */
export function foldedAncestorKeys(
  timeline: readonly TimelineItem[],
  key: string,
  state: CollapseState,
): string[] {
  if (!findByStickyKey(timeline, key)) return []
  const ancestors = resolveAncestors(timeline, key) ?? []
  return ancestors
    .filter(({ key: prefix, item }) => resolveCollapsed(prefix, item, state))
    .map(({ key: prefix }) => prefix)
}

/**
 * Walk a composite key's ancestor chain and return the nearest still-visible
 * key: the first folded ancestor (its header stays rendered) — or the key
 * itself when every ancestor is expanded. Unresolvable segments (stale keys) are
 * left untouched, so the caller keeps the key it had.
 */
export function visibleFocusKey(
  timeline: readonly TimelineItem[],
  key: string,
  state: CollapseState,
): string {
  const ancestors = resolveAncestors(timeline, key)
  if (!ancestors) return key
  for (const { key: prefix, item } of ancestors) {
    if (resolveCollapsed(prefix, item, state)) return prefix
  }
  return key
}
