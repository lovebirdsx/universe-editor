/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Collapse resolution for timeline cards — shared by ChatBody (top-level slots)
 *  and ToolCallCard (nested sub-agent cards) so a single override store keyed by
 *  (possibly composite) sticky keys drives folding everywhere: chevron clicks,
 *  Alt+F, the sticky-scroll overlay, and persistence.
 *--------------------------------------------------------------------------------------------*/

import type { CollapseMode } from '../../services/acp/session/acpChatViewStateCache.js'
import type { AcpChildItem, TimelineItem } from '../../services/acp/session/acpSession.js'
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
