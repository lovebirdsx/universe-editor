import {
  firstLineSummary,
  firstNonEmptyLine,
  stripAnsi,
  stripCodeFence,
} from '@universe-editor/acp-view-model'
import type {
  MobileTimelineItem,
  MobileTimelineMessageItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { readStoredString, writeStoredString } from '../preferences.js'
import { strings } from '../strings.js'

export type SessionDisplayPreference = 'onlyMessage' | 'full'

export const SESSION_DISPLAY_STORAGE_KEY = 'universe.mobile.sessionDisplay'
export const DEFAULT_SESSION_DISPLAY: SessionDisplayPreference = 'onlyMessage'

export function isSessionDisplayPreference(value: unknown): value is SessionDisplayPreference {
  return value === 'onlyMessage' || value === 'full'
}

export function readSessionDisplayPreference(): SessionDisplayPreference {
  const stored = readStoredString(SESSION_DISPLAY_STORAGE_KEY)
  return isSessionDisplayPreference(stored) ? stored : DEFAULT_SESSION_DISPLAY
}

export function setSessionDisplayPreference(preference: SessionDisplayPreference): void {
  writeStoredString(SESSION_DISPLAY_STORAGE_KEY, preference)
}

/**
 * Mirrors the desktop `onlyMessage` keep-set (timelineDisplay.ts) against the
 * phone wire shapes: user/agent text, errors, status notices and the three
 * always-kept tool cards survive; thoughts and ordinary tools are dropped.
 */
export function selectTimelineForDisplay(
  timeline: readonly MobileTimelineItem[],
  preference: SessionDisplayPreference,
): readonly MobileTimelineItem[] {
  if (preference === 'full') return timeline
  return timeline.filter(isOnlyMessageVisible)
}

function isOnlyMessageVisible(item: MobileTimelineItem): boolean {
  switch (item.kind) {
    case 'notice':
      return true
    case 'message':
      return isMessageVisible(item)
    case 'toolCall':
      return isAlwaysKeptToolCall(item)
  }
}

function isMessageVisible(item: MobileTimelineMessageItem): boolean {
  if (item.role === 'user') return true
  if (item.role === 'thought') return false
  return isErrorMessage(item) || hasVisibleContent(item)
}

function isErrorMessage(item: MobileTimelineMessageItem): boolean {
  return item.role === 'agent' && item.text.trimStart().startsWith('[error]')
}

function hasVisibleContent(item: MobileTimelineMessageItem): boolean {
  return (
    item.text.trim().length > 0 ||
    (item.images?.length ?? 0) > 0 ||
    item.hasNonText === true ||
    item.streaming
  )
}

function isAlwaysKeptToolCall(item: MobileTimelineToolCallItem): boolean {
  return (
    item.subagent === true || item.requiresUserDecision === true || item.toolKind === 'switch_mode'
  )
}

/** The last settled hidden tool behind a still-running agent. */
export interface MobileHiddenPreviousTool {
  readonly title: string
  readonly status: string
  /** Short failure / settlement reason, already reduced to display text. */
  readonly reason?: string
  /** Frozen span at settle; shown as a secondary clue when available. */
  readonly durationMs?: number
}

/** Display-ready tail activity for the mode that hides the streaming slot. */
export type MobileHiddenActivity =
  | {
      readonly kind: 'thinking'
      /** First non-empty line of the thought. */
      readonly detail?: string
    }
  | {
      readonly kind: 'tool'
      readonly title: string
      /** Target path behind the title. */
      readonly detail?: string
      /** PC epoch ms start for the live stopwatch. */
      readonly startedAt?: number
      readonly durationMs?: number
    }
  | {
      readonly kind: 'settledTool'
      readonly tool: MobileHiddenPreviousTool
    }

/**
 * Mirrors the desktop `getHiddenActivity` (timelineDisplay.ts): the hint only
 * fires while the tail slot is hidden by the `onlyMessage` filter and the agent
 * is still running. Visible tails (agent reply, kept card) and the `full` mode
 * return null, so the row never flickers next to content already on screen.
 */
export function getHiddenActivity(
  displayTimeline: readonly MobileTimelineItem[],
  tail: MobileTimelineItem | undefined,
  preference: SessionDisplayPreference,
  active: boolean,
): MobileHiddenActivity | null {
  if (!active || tail === undefined) return null
  // `full` keeps every slot, so the hint can only come from the display filter.
  if (preference === 'full') return null
  if (displayTimeline[displayTimeline.length - 1] === tail) return null
  if (tail.kind === 'message') {
    if (tail.role !== 'thought') return null
    const detail = thoughtSummary(tail.text)
    return detail === undefined ? { kind: 'thinking' } : { kind: 'thinking', detail }
  }
  if (tail.kind === 'toolCall') return toolActivity(tail)
  return null
}

/**
 * Mirrors the desktop `getSubagentHiddenActivity`: a running sub-agent card's
 * own hidden last child, which the PC ships as `subagentTail` already filtered
 * by the only-message rule. A pending decision owns the footer instead.
 */
export function getSubagentHiddenActivity(
  item: MobileTimelineToolCallItem,
  preference: SessionDisplayPreference,
  awaitingDecision: boolean,
): MobileHiddenActivity | null {
  if (awaitingDecision || preference === 'full' || item.subagent !== true) return null
  if (item.status !== 'pending' && item.status !== 'in_progress') return null
  const tail = item.subagentTail
  if (tail === undefined) return null
  if (tail.kind === 'thought') {
    return tail.summary === undefined
      ? { kind: 'thinking' }
      : { kind: 'thinking', detail: tail.summary }
  }
  return toolActivity(tail)
}

/** The fields both the top-level card and a sub-agent tail carry. */
type ActivityToolFields = Pick<
  MobileTimelineToolCallItem,
  | 'title'
  | 'toolKind'
  | 'status'
  | 'preview'
  | 'locations'
  | 'diffs'
  | 'startedAt'
  | 'durationMs'
  | 'settleReason'
  | 'syntheticDenial'
>

function toolActivity(tool: ActivityToolFields): MobileHiddenActivity {
  if (tool.status === 'pending' || tool.status === 'in_progress') {
    const title = tool.title.trim()
    const detail = runningToolDetail(tool)
    return {
      kind: 'tool',
      title: title.length > 0 ? title : strings.activityToolFallback,
      ...(detail !== undefined ? { detail } : {}),
      ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
      ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    }
  }
  const reason = settledToolReason(tool)
  return {
    kind: 'settledTool',
    tool: {
      title: toolDisplayTitle(tool),
      status: tool.status,
      ...(reason !== undefined ? { reason } : {}),
      ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    },
  }
}

function thoughtSummary(text: string): string | undefined {
  const line = firstNonEmptyLine(text)
  if (line.length === 0) return undefined
  const summary = firstLineSummary(line)
  return summary.length > 0 ? summary : undefined
}

function toolDisplayTitle(item: ActivityToolFields): string {
  const title = item.title.trim()
  return title.length > 0 ? title : item.toolKind
}

function runningToolDetail(item: ActivityToolFields): string | undefined {
  const location = item.locations?.[0]
  if (location !== undefined) {
    return location.line !== undefined ? `${location.path}:${location.line}` : location.path
  }
  return item.diffs?.[0]?.path
}

function settledToolReason(item: ActivityToolFields): string | undefined {
  if (item.settleReason !== undefined && item.settleReason.length > 0) return item.settleReason
  if (item.status !== 'failed') return undefined
  // A synthetic denial's `preview` is the misleading "user rejected" line the CLI
  // fabricated; the upstream-interruption wording is the only safe thing to surface.
  if (item.syntheticDenial === true) return strings.activitySyntheticDenial
  return previewReason(item.preview)
}

function previewReason(preview: string | undefined): string | undefined {
  if (preview === undefined) return undefined
  // `preview` is the first 1KB of the card body: strip ANSI noise and a possibly
  // truncated whole-block fence before taking the first meaningful line.
  const text = stripAnsi(preview)
  for (const line of stripCodeFence(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || /^```[\w-]*$/.test(trimmed)) continue
    const summary = firstLineSummary(trimmed)
    return summary.length > 0 ? summary : undefined
  }
  return undefined
}
