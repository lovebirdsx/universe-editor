/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Collapse resolution for timeline cards — shared by ChatBody (top-level slots)
 *  and ToolCallCard (nested sub-agent cards) so a single override store keyed by
 *  (possibly composite) sticky keys drives folding everywhere: chevron clicks,
 *  Alt+F, the sticky-scroll overlay, outline reveals, and persistence. Also owns
 *  the derived view of what folding leaves on screen — the flattened row
 *  sequence the keyboard navigation walks.
 *--------------------------------------------------------------------------------------------*/

import type { CollapseMode } from '../../services/acp/session/acpChatViewStateCache.js'
import type {
  AcpChildItem,
  AcpMessage,
  TimelineItem,
} from '../../services/acp/session/acpSession.js'
import { hasVisibleMessageContent } from '../../services/acp/session/acpSession.js'
import { buildStickyKey, findByStickyKey, itemSlotKey } from './stickyScroll.js'
import { createdFilePath } from './toolCallDisplay.js'

export interface CollapseState {
  readonly mode: CollapseMode
  readonly overrides: ReadonlyMap<string, boolean>
  /**
   * The one top-level sub-agent card allowed to be open, `null` when none is.
   * Kept apart from `overrides` because "at most one open" is a single-slot
   * pointer, not a per-item boolean: a second card opening has to close the
   * first, which no autonomous override can express.
   */
  readonly openSubagent: string | null
}

/**
 * Whether this card owns a sub-agent timeline. The fork stamps `subagent` on the
 * spawning tool call, but a card that only carries children counts too — history
 * replay of an older session may omit the stamp, and children are what actually
 * fold inside the card.
 */
export function isSubagentCard(item: TimelineItem | AcpChildItem): boolean {
  return (
    item.kind === 'toolCall' &&
    (item.call.subagent === true || (item.call.children?.length ?? 0) > 0)
  )
}

/**
 * Whether a sticky key names a top-level sub-agent card — the unit the
 * exclusivity rule counts. A composite key (`t:task/t:sub`) is content *inside*
 * an open card, never a card of its own; treating it as one would fold the very
 * parent card the user just opened to reach it.
 */
export function isSubagentSlot(key: string, item: TimelineItem | AcpChildItem): boolean {
  return !key.includes('/') && isSubagentCard(item)
}

/** Compaction / resurrection are single-line status cards drawn without a
 *  chevron — Alt+H/L must step past them rather than fold them. */
export function isCollapsibleItem(item: TimelineItem | AcpChildItem): boolean {
  return item.kind !== 'compaction' && item.kind !== 'resurrection'
}

/**
 * Whether a message draws a row at all — the two render sites drop a settled
 * message with no visible content (an agent's empty/whitespace thought
 * turn-marker). Mirrors them exactly: a top-level card keeps a streaming first
 * frame so the caret shows before its first chunk lands, whereas a `nested`
 * sub-agent message has no caret frame to keep.
 */
export function isMessageRendered(message: AcpMessage, nested: boolean): boolean {
  if (message.role === 'user') return true
  if (hasVisibleMessageContent(message.blocks)) return true
  return !nested && message.streaming
}

// Per-kind default under the `default` mode: read/search / sub-agent-parent
// tool calls start collapsed, everything else (thought messages included)
// starts expanded. No top-level sub-agent card ever reaches this — {@link
// resolveCollapsed} decides those from the designation alone. A whole-file
// write (Write / add file) is an `edit` card by shape but a new document by
// content — folded so it does not flood the timeline; its header carries a
// preview / open affordance instead.
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
// Sub-agent cards are the exception and are decided before either: only the
// designated one may be open, in every mode — so "expand all" (expanded) still
// leaves a single sub-agent timeline unfolded rather than flooding the view.
export function resolveCollapsed(
  key: string,
  item: TimelineItem | AcpChildItem,
  state: CollapseState,
): boolean {
  if (isSubagentSlot(key, item)) return state.openSubagent !== key
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

/** One row of the timeline, in the order it is stacked vertically. */
export interface TimelineRow {
  readonly key: string
  /** 0 for a top-level slot, 1+ inside a sub-agent timeline. */
  readonly depth: number
  /** False for a card that draws nothing at all — a settled message with no
   *  content. Its row still anchors the walk (it can hold the focus when it
   *  stops drawing) but the keyboard steps over it, never onto it. */
  readonly rendered: boolean
}

/** A row rendered outside the timeline (the pinned plan bar) to splice in. */
export interface PinnedTimelineRow {
  readonly key: string
  /** Splice right after this key; `null` (or an anchor that is gone) prepends. */
  readonly afterKey: string | null
}

/**
 * The row sequence Alt+J/K walk — the timeline counterpart of the Explorer's
 * `TreeModel.getVisibleNodes()`. A card's children follow its own row while it
 * is expanded and vanish while it is folded (their DOM is unmounted too), so
 * descending into a sub-agent timeline is an ordinary step rather than a
 * separate command. Rows that draw nothing are kept — anchored, never stopped on
 * — so a step off a card that just stopped drawing still moves one row.
 */
export function collectTimelineRows(
  timeline: readonly TimelineItem[],
  state: CollapseState,
  pinned?: PinnedTimelineRow,
): TimelineRow[] {
  const rows: TimelineRow[] = []
  const pushChild = (item: AcpChildItem, parentKey: string, depth: number): void => {
    const rendered = item.kind !== 'message' || isMessageRendered(item.message, true)
    const key = buildStickyKey(parentKey, item)
    rows.push({ key, depth, rendered })
    if (item.kind !== 'toolCall' || resolveCollapsed(key, item, state)) return
    for (const child of item.call.children ?? []) pushChild(child, key, depth + 1)
  }
  for (const item of timeline) {
    const rendered = item.kind !== 'message' || isMessageRendered(item.message, false)
    const key = itemSlotKey(item)
    rows.push({ key, depth: 0, rendered })
    if (item.kind !== 'toolCall' || resolveCollapsed(key, item, state)) continue
    for (const child of item.call.children ?? []) pushChild(child, key, 1)
  }
  if (pinned !== undefined) {
    const anchor =
      pinned.afterKey === null ? -1 : rows.findIndex((row) => row.key === pinned.afterKey)
    rows.splice(anchor + 1, 0, { key: pinned.key, depth: 0, rendered: true })
  }
  return rows
}
