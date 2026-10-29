/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Timeline display-mode transition shared by the session view-model and the
 *  renderer-side dropdown / keyboard cycle. Lives in the service layer so
 *  AcpSession does not import UI helpers from workbench/agents.
 *--------------------------------------------------------------------------------------------*/

import type { CollapseMode } from './acpChatViewStateCache.js'

export const COLLAPSE_MODE_ORDER = [
  'default',
  'collapsed',
  'expanded',
  'hideThinking',
  'lastMessage',
] as const satisfies readonly CollapseMode[]

const COLLAPSE_MODE_SET: ReadonlySet<string> = new Set(COLLAPSE_MODE_ORDER)

export function isCollapseMode(value: unknown): value is CollapseMode {
  return typeof value === 'string' && COLLAPSE_MODE_SET.has(value)
}

/** default → collapsed → expanded → hideThinking → lastMessage → default */
export function nextCollapseMode(mode: CollapseMode): CollapseMode {
  const index = COLLAPSE_MODE_ORDER.indexOf(mode)
  return COLLAPSE_MODE_ORDER[(index + 1) % COLLAPSE_MODE_ORDER.length] ?? 'default'
}
