/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Display-mode filtering for the agent timeline: which slots actually render
 *  under `hideThinking` / `onlyMessage`, which nested thoughts the card bodies
 *  drop, the tail activity hint (with its tool / thought summary), and
 *  keyboard-focus convergence when the selected slot disappears. Pure
 *  functions — no React / DOM — so the rules stay testable and the data-layer
 *  timeline is never mutated.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { CollapseMode } from '../../services/acp/session/acpChatViewStateCache.js'
import type {
  AcpChildItem,
  AcpMessage,
  AcpToolCall,
  TimelineItem,
} from '../../services/acp/session/acpSession.js'
import { firstLineSummary, stripCodeFence } from '../../services/acp/session/acpSessionContent.js'
import { findByStickyKey, itemSlotKey } from './stickyScroll.js'
import { deriveToolCallDisplay, isSyntheticDenial } from './toolCallDisplay.js'
import {
  isMessageRendered,
  isSubagentCard,
  visibleFocusKey,
  type CollapseState,
} from './timelineCollapse.js'

/** The last settled hidden tool behind a still-running agent. */
export interface HiddenPreviousTool {
  readonly title: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  /** Short failure / settlement reason, already localized where fixed. */
  readonly reason?: string
  /** Frozen span at settle; shown as a secondary clue when available. */
  readonly durationMs?: number
}

/** Display-ready tail activity for the modes that can hide the streaming slot. */
export type HiddenActivity =
  | {
      readonly kind: 'thinking'
      /** First non-empty line of the thought (only surfaced by `onlyMessage`). */
      readonly detail?: string
    }
  | {
      readonly kind: 'tool'
      readonly title: string
      /** Command / target path / MCP server behind the title. */
      readonly detail?: string
      /** Epoch ms start for the live stopwatch. */
      readonly startedAt?: number
      readonly durationMs?: number
    }
  | {
      readonly kind: 'settledTool'
      readonly tool: HiddenPreviousTool
    }

function isUserMessage(item: TimelineItem): boolean {
  return item.kind === 'message' && item.message.role === 'user'
}

function isThoughtMessage(item: TimelineItem | AcpChildItem): boolean {
  return item.kind === 'message' && item.message.role === 'thought'
}

function isErrorAgentMessage(item: TimelineItem): boolean {
  return (
    item.kind === 'message' &&
    item.message.role === 'agent' &&
    item.message.text.trimStart().startsWith('[error]')
  )
}

function isAlwaysKept(item: TimelineItem): boolean {
  if (item.kind === 'compaction' || item.kind === 'resurrection') return true
  if (isErrorAgentMessage(item)) return true
  if (item.kind === 'toolCall') {
    return (
      isSubagentCard(item) ||
      item.call.kind === 'switch_mode' ||
      item.call.requiresUserDecision === true
    )
  }
  return false
}

/**
 * Keep every user and agent text message. Sub-agent cards, compaction /
 * resurrection cards, error messages, plan-confirmation (`switch_mode`) cards
 * and user-decision cards (AskUserQuestion / elicitation-backed tools) are
 * always kept; ordinary tool cards (failed included) and thoughts are dropped.
 * Settled agent messages with no visible content are dropped too — a streaming
 * first frame stays because `isMessageRendered` keeps it for the caret.
 */
function selectOnlyMessages(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  if (timeline.length === 0) return timeline
  return timeline.filter(
    (item) =>
      isUserMessage(item) ||
      isAlwaysKept(item) ||
      (item.kind === 'message' &&
        item.message.role === 'agent' &&
        isMessageRendered(item.message, false)),
  )
}

export function selectTimelineForDisplay(
  timeline: readonly TimelineItem[],
  mode: CollapseMode,
): readonly TimelineItem[] {
  switch (mode) {
    case 'default':
    case 'collapsed':
    case 'expanded':
      return timeline
    case 'hideThinking':
      return timeline.filter((item) => !isThoughtMessage(item))
    case 'onlyMessage':
      return selectOnlyMessages(timeline)
  }
}

function filterChildItemsDeep(children: readonly AcpChildItem[]): readonly AcpChildItem[] {
  let changed = false
  const out: AcpChildItem[] = []
  for (const child of children) {
    if (isThoughtMessage(child)) {
      changed = true
      continue
    }
    if (child.kind === 'toolCall') {
      const nested = child.call.children
      if (nested !== undefined && nested.length > 0) {
        const filteredNested = filterChildItemsDeep(nested)
        if (filteredNested !== nested) {
          changed = true
          out.push({ ...child, call: { ...child.call, children: filteredNested } })
          continue
        }
      }
    }
    out.push(child)
  }
  return changed ? out : children
}

function filterTimelineItemChildren(item: TimelineItem, mode: CollapseMode): TimelineItem {
  if (mode !== 'hideThinking' || item.kind !== 'toolCall') return item
  const children = item.call.children
  if (children === undefined || children.length === 0) return item
  const filtered = filterChildItemsDeep(children)
  return filtered === children ? item : { ...item, call: { ...item.call, children: filtered } }
}

/** Outline-visible timeline: top-level filtering plus nested-thought removal
 *  under `hideThinking`, so the tree never lists a row with no render target. */
export function selectTimelineForOutline(
  timeline: readonly TimelineItem[],
  mode: CollapseMode,
): readonly TimelineItem[] {
  const visible = selectTimelineForDisplay(timeline, mode)
  if (mode !== 'hideThinking') return visible
  return visible.map((item) => filterTimelineItemChildren(item, mode))
}

/** Direct children a card body renders for the current mode. Recursion happens
 *  as each nested card renders its own children through this same function. */
export function filterChildItemsForDisplay(
  children: readonly AcpChildItem[],
  mode: CollapseMode,
): readonly AcpChildItem[] {
  if (mode !== 'hideThinking' || children.length === 0) return children
  let changed = false
  const out: AcpChildItem[] = []
  for (const child of children) {
    if (isThoughtMessage(child)) {
      changed = true
      continue
    }
    out.push(child)
  }
  return changed ? out : children
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

function thoughtSummary(message: AcpMessage): string | undefined {
  const line = firstNonEmptyLine(message.text)
  return line.length > 0 ? firstLineSummary(line) : undefined
}

function toolDisplayTitle(call: AcpToolCall, fallback: string): string {
  const title = deriveToolCallDisplay(call).title.trim()
  return title.length > 0 ? title : fallback
}

/** Command / argument fragment first, then the target the tool acts on. */
function runningToolDetail(call: AcpToolCall, subtitle: string | undefined): string | undefined {
  const trimmedSubtitle = subtitle?.trim()
  if (trimmedSubtitle !== undefined && trimmedSubtitle.length > 0) return trimmedSubtitle
  const location = call.locations?.[0]
  if (location !== undefined) {
    return location.line !== undefined ? `${location.path}:${location.line}` : location.path
  }
  const diff = call.diffs[0]
  if (diff !== undefined) return diff.path
  if (call.mcpServer !== undefined) {
    return localize('acp.collapse.activity.mcpServer', 'MCP · {server}', {
      server: call.mcpServer,
    })
  }
  return undefined
}

function settledReason(call: AcpToolCall): string | undefined {
  if (call.settleReason !== undefined && call.settleReason.length > 0) return call.settleReason
  if (call.status !== 'failed') return undefined
  // A synthetic denial's `text` is the misleading "user rejected" line the CLI
  // fabricated; the badge wording is the only safe thing to surface.
  if (isSyntheticDenial(call)) {
    return localize('acp.syntheticDenial.badge', 'Upstream interruption')
  }
  const line = firstNonEmptyLine(stripCodeFence(call.text).trim())
  return line.length > 0 ? firstLineSummary(line) : undefined
}

/**
 * Tail activity hint for the modes that can hide the slot currently streaming.
 * Only fires while the tail is genuinely hidden and the agent is still working;
 * visible tails (agent reply, sub-agent card, status card) and old folding
 * modes return null, so the row never flickers next to content that is already
 * on screen. The returned object carries the detail the row can show without
 * touching the session model again.
 */
export function getHiddenActivity(
  filteredTimeline: readonly TimelineItem[],
  tail: TimelineItem | undefined,
  mode: CollapseMode,
  active: boolean,
): HiddenActivity | null {
  if (!active || tail === undefined) return null
  // Old folding modes never remove a slot, so the hint can only come from a
  // display filter; spell that out instead of relying on array identity.
  switch (mode) {
    case 'default':
    case 'collapsed':
    case 'expanded':
      return null
    case 'hideThinking':
    case 'onlyMessage':
      break
  }
  if (filteredTimeline[filteredTimeline.length - 1] === tail) return null
  if (tail.kind === 'message') {
    if (tail.message.role !== 'thought') return null
    // `hideThinking` must not leak the thought it exists to hide; only
    // `onlyMessage` promotes the first line into the hint.
    const detail = mode === 'onlyMessage' ? thoughtSummary(tail.message) : undefined
    return detail === undefined ? { kind: 'thinking' } : { kind: 'thinking', detail }
  }
  if (tail.kind === 'toolCall') {
    const call = tail.call
    if (call.status === 'pending' || call.status === 'in_progress') {
      const display = deriveToolCallDisplay(call)
      const detail = runningToolDetail(call, display.subtitle)
      const title = display.title.trim()
      return {
        kind: 'tool',
        title: title.length > 0 ? title : localize('acp.collapse.activity.tool', 'Calling a tool…'),
        ...(detail !== undefined ? { detail } : {}),
        ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      }
    }
    const reason = settledReason(call)
    return {
      kind: 'settledTool',
      tool: {
        title: toolDisplayTitle(call, call.kind),
        status: call.status,
        ...(reason !== undefined ? { reason } : {}),
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      },
    }
  }
  return null
}

function nearestVisibleKey(
  fullTimeline: readonly TimelineItem[],
  filteredTimeline: readonly TimelineItem[],
  displayKeys: ReadonlySet<string>,
  hiddenTopKey: string,
  collapse: CollapseState,
): string | null {
  const index = fullTimeline.findIndex((item) => itemSlotKey(item) === hiddenTopKey)
  if (index === -1) return null
  for (let i = index - 1; i >= 0; i--) {
    const item = fullTimeline[i]
    if (item === undefined) continue
    const key = itemSlotKey(item)
    if (displayKeys.has(key)) return visibleFocusKey(filteredTimeline, key, collapse)
  }
  for (let i = index + 1; i < fullTimeline.length; i++) {
    const item = fullTimeline[i]
    if (item === undefined) continue
    const key = itemSlotKey(item)
    if (displayKeys.has(key)) return visibleFocusKey(filteredTimeline, key, collapse)
  }
  return null
}

/** Pull a keyboard focus off a slot the current display mode no longer renders:
 *  nested hidden thoughts converge to their parent card, hidden top-level slots
 *  to the nearest visible neighbour, and anything unresolvable to `null`. */
export function convergeDisplayFocusKey(
  fullTimeline: readonly TimelineItem[],
  filteredTimeline: readonly TimelineItem[],
  displayKeys: ReadonlySet<string>,
  key: string,
  collapse: CollapseState,
): string | null {
  const top = key.split('/')[0] ?? key
  if (!displayKeys.has(top)) {
    return nearestVisibleKey(fullTimeline, filteredTimeline, displayKeys, top, collapse)
  }
  if (collapse.mode === 'hideThinking' && key.includes('/')) {
    const item = findByStickyKey(fullTimeline, key)
    if (item !== undefined && isThoughtMessage(item)) {
      const parent = key.slice(0, key.lastIndexOf('/'))
      return visibleFocusKey(filteredTimeline, parent.length > 0 ? parent : top, collapse)
    }
  }
  if (findByStickyKey(filteredTimeline, key) === undefined) {
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : null
    return parent !== null && parent.length > 0
      ? visibleFocusKey(filteredTimeline, parent, collapse)
      : null
  }
  return visibleFocusKey(filteredTimeline, key, collapse)
}
