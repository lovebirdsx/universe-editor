/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Collapse resolution for timeline cards — shared by ChatBody (top-level slots)
 *  and ToolCallCard (nested sub-agent cards) so a single override store keyed by
 *  (possibly composite) sticky keys drives folding everywhere: chevron clicks,
 *  Alt+F, the sticky-scroll overlay, and persistence.
 *--------------------------------------------------------------------------------------------*/

import type { CollapseMode } from '../../services/acp/acpChatViewStateCache.js'
import type { AcpChildItem, TimelineItem } from '../../services/acp/acpSession.js'

export interface CollapseState {
  readonly mode: CollapseMode
  readonly overrides: ReadonlyMap<string, boolean>
}

// Per-kind default under the `default` mode: thought messages and read/search /
// sub-agent-parent tool calls start collapsed, the rest expanded.
export function defaultCollapsed(item: TimelineItem | AcpChildItem, mode: CollapseMode): boolean {
  if (mode === 'collapsed') return true
  if (mode === 'expanded') return false
  switch (item.kind) {
    case 'message':
      return item.message.role === 'thought'
    case 'toolCall':
      return (
        item.call.kind === 'read' ||
        item.call.kind === 'search' ||
        (item.call.children?.length ?? 0) > 0
      )
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
