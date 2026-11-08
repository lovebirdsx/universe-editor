/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure projections from the ACP session view model onto the mobile wire shapes,
 *  plus the diff helpers that turn consecutive projections into delta events.
 *  Kept free of DI/observables so the merge rules (prefix append vs. replace,
 *  diff statistics, notice replacement) are unit-testable in isolation.
 *--------------------------------------------------------------------------------------------*/

import type { ElicitationSchema, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { IObservable, IReader } from '@universe-editor/platform'
import {
  isConfigValueAllowedOnMobile,
  isPermissionOptionAllowedOnMobile,
  type MobileAutoResolve,
  type MobileConfigOption,
  type MobileElicitationField,
  type MobileMessageUpsertEvent,
  type MobilePendingElicitation,
  type MobilePendingPermission,
  type MobilePermissionSettleReason,
  type MobilePermissionSettleSource,
  type MobilePlanEntry,
  type MobileSessionEvent,
  type MobileTimelineItem,
  type MobileTimelineMessageItem,
  type MobileTimelineToolCallItem,
  type MobileToolCallDiffStat,
  type MobileToolCallUpsertEvent,
  type MobileUsage,
} from '@universe-editor/mobile-protocol'
import { computeLineDiff } from '@universe-editor/acp-view-model'
import type {
  AcpMessage,
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpPlanEntry,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  TimelineItem,
} from '../acp/session/acpSession.js'
import { normalizeElicitationForm } from '../acp/acpElicitationForm.js'
import { statusBucketFor } from '../acp/session/acpSessionFilterService.js'
import { computeSessionDisplayStatus } from '../acp/session/acpSessionStatus.js'
import { findConfigOptionLabel } from '../acp/configOptionLabel.js'
import type {
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
} from '../../../shared/ipc/mobileGatewayService.js'

export interface SessionProjectionOptions {
  readonly title: string
  readonly agentName?: string
  readonly now?: number
}

export function toBridgeSummary(
  session: IAcpSession,
  options: SessionProjectionOptions,
  r?: IReader,
): MobileBridgeSessionSummary {
  const displayStatus = computeSessionDisplayStatus(session, r)
  const durableId = readObservable(session.sessionIdOnAgent, r)
  const pendingPermission = readObservable(session.pendingPermission, r)
  const pendingElicitation = readObservable(session.pendingElicitation, r)
  return {
    localId: session.id,
    ...(durableId !== undefined ? { durableId } : {}),
    agentId: session.agentId,
    ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
    title: options.title,
    status: readObservable(session.status, r),
    displayStatus,
    bucket: statusBucketFor(displayStatus),
    ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    ...(session.authority !== undefined ? { authority: session.authority } : {}),
    readOnly: session.readOnly,
    hasPendingPermission: pendingPermission !== undefined,
    hasPendingElicitation: pendingElicitation !== undefined,
    backgroundTaskCount: readObservable(session.backgroundTaskCount, r),
    updatedAt: options.now ?? Date.now(),
  }
}

export function toBridgeSnapshot(
  session: IAcpSession,
  options: SessionProjectionOptions,
  r?: IReader,
): MobileBridgeSessionSnapshot {
  const usage = projectUsage(readObservable(session.usage, r))
  const permission = projectPendingPermission(readObservable(session.pendingPermission, r), r)
  const elicitation = projectPendingElicitation(readObservable(session.pendingElicitation, r))
  return {
    summary: toBridgeSummary(session, options, r),
    timeline: readObservable(session.timeline, r).map(projectTimelineItem),
    plan: readObservable(session.plan, r).map(projectPlanEntry),
    configOptions: readObservable(session.configOptions, r).map(projectConfigOption),
    isReplayingHistory: readObservable(session.isReplayingHistory, r),
    ...(usage !== undefined ? { usage } : {}),
    ...(permission !== undefined ? { pendingPermission: permission } : {}),
    ...(elicitation !== undefined ? { pendingElicitation: elicitation } : {}),
  }
}

export function projectTimelineItem(item: TimelineItem): MobileTimelineItem {
  switch (item.kind) {
    case 'message':
      return projectMessage(item.message)
    case 'toolCall':
      return projectToolCall(item.call)
    case 'compaction':
      return {
        kind: 'notice',
        id: item.id,
        noticeKind: 'compaction',
        phase: item.compaction.phase,
        ...(item.compaction.reason !== undefined ? { text: item.compaction.reason } : {}),
      }
    case 'resurrection':
      return {
        kind: 'notice',
        id: item.id,
        noticeKind: 'resurrection',
        phase: item.resurrection.phase,
        ...(item.resurrection.reason !== undefined ? { text: item.resurrection.reason } : {}),
      }
  }
}

export function projectMessage(message: AcpMessage): MobileTimelineMessageItem {
  return {
    kind: 'message',
    id: message.id,
    role: message.role,
    text: message.text,
    streaming: message.streaming,
    ...(message.memoryTrimmed ? { memoryTrimmed: true } : {}),
    ...(message.blocks.some((block) => block.type !== 'text') ? { hasNonText: true } : {}),
  }
}

const TOOL_PREVIEW_CHARS = 1024
const MAX_PROJECTED_DIFFS = 256
const MAX_PROJECTED_LOCATIONS = 256

export function projectToolCall(call: AcpToolCall): MobileTimelineToolCallItem {
  const diffs = call.diffs.slice(0, MAX_PROJECTED_DIFFS).map(projectDiffStat)
  const locations = call.locations?.slice(0, MAX_PROJECTED_LOCATIONS)
  // Mirrors the desktop only-message keep-set predicates in timelineCollapse.ts.
  const subagent = call.subagent === true || (call.children?.length ?? 0) > 0
  return {
    kind: 'toolCall',
    id: call.id,
    title: call.title,
    toolKind: call.kind,
    status: call.status,
    ...(call.text.length > 0 ? { preview: call.text.slice(0, TOOL_PREVIEW_CHARS) } : {}),
    hasDetail: call.text.length > 0 || call.blocks.length > 0 || call.diffs.length > 0,
    ...(diffs.length > 0 ? { diffs } : {}),
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
    ...(call.memoryTrimmed ? { memoryTrimmed: true } : {}),
    ...(subagent ? { subagent: true } : {}),
    ...(call.requiresUserDecision === true ? { requiresUserDecision: true } : {}),
  }
}

function projectDiffStat(diff: AcpToolCall['diffs'][number]): MobileToolCallDiffStat {
  let added = 0
  let removed = 0
  for (const line of computeLineDiff(diff.oldText, diff.newText)) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { path: diff.path, added, removed }
}

export function projectPlanEntry(entry: AcpPlanEntry): MobilePlanEntry {
  return {
    content: entry.content,
    status: entry.status,
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
  }
}

export function projectConfigOption(option: SessionConfigOption): MobileConfigOption {
  const category = option.category ?? undefined
  if (option.type === 'boolean') {
    return {
      id: option.id,
      name: option.name,
      ...(category !== undefined ? { category } : {}),
      type: 'boolean',
      currentValue: option.currentValue ? 'On' : 'Off',
      allowedOnMobile: true,
    }
  }
  const values = flattenSelectOptions(option.options).map((value) => ({
    value: value.value,
    label: value.name,
    allowedOnMobile: isConfigValueAllowedOnMobile(value.value),
  }))
  return {
    id: option.id,
    name: option.name,
    ...(category !== undefined ? { category } : {}),
    type: 'select',
    currentValue: findConfigOptionLabel(option.options, option.currentValue),
    allowedOnMobile: values.some((value) => value.allowedOnMobile),
    ...(values.length > 0 ? { options: values } : {}),
  }
}

function flattenSelectOptions(
  options: Extract<SessionConfigOption, { type: 'select' }>['options'],
): Array<{ value: string; name: string }> {
  const flattened: Array<{ value: string; name: string }> = []
  for (const entry of options) {
    if ('group' in entry) flattened.push(...entry.options)
    else flattened.push(entry)
  }
  return flattened
}

export function projectUsage(usage: AcpUsage | undefined): MobileUsage | undefined {
  if (usage === undefined) return undefined
  return {
    used: usage.used,
    size: usage.size,
    ...(usage.cost !== undefined
      ? { cost: { amount: usage.cost.amount, currency: usage.cost.currency } }
      : {}),
    ...(usage.costEstimated !== undefined ? { costEstimated: usage.costEstimated } : {}),
  }
}

export function projectPendingPermission(
  permission: AcpPendingPermission | undefined,
  r?: IReader,
): MobilePendingPermission | undefined {
  if (permission === undefined) return undefined
  const auto = permission.autoResolve
  const autoState = auto ? readObservable(auto.state, r) : undefined
  const autoResolve: MobileAutoResolve | undefined =
    auto !== undefined && autoState !== undefined
      ? {
          optionId: auto.optionId,
          paused: autoState.paused,
          ...(autoState.cancelled
            ? {}
            : autoState.paused
              ? { deadlineAt: Date.now() + autoState.remainingMs }
              : autoState.deadlineAt !== undefined
                ? { deadlineAt: autoState.deadlineAt }
                : {}),
        }
      : undefined
  return {
    requestId: permission.requestId,
    toolCallId: permission.toolCallId,
    title: permission.title,
    ...(permission.kind !== undefined ? { kind: permission.kind } : {}),
    options: permission.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      ...(option.kind !== undefined ? { kind: option.kind } : {}),
      allowedOnMobile: isPermissionOptionAllowedOnMobile(option),
    })),
    ...(autoResolve !== undefined ? { autoResolve } : {}),
  }
}

export function projectPendingElicitation(
  elicitation: AcpPendingElicitation | undefined,
): MobilePendingElicitation | undefined {
  if (elicitation === undefined) return undefined
  const request = elicitation.request
  const title = typeof request._meta?.['title'] === 'string' ? request._meta['title'] : undefined
  const toolCallId =
    'toolCallId' in request && typeof request.toolCallId === 'string'
      ? request.toolCallId
      : undefined
  const url = 'url' in request && typeof request.url === 'string' ? request.url : undefined
  const fields =
    request.mode === 'form'
      ? projectElicitationFields(request.requestedSchema as ElicitationSchema)
      : undefined
  return {
    requestId: elicitation.requestId,
    mode: request.mode,
    message: request.message,
    ...(title !== undefined ? { title } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(fields !== undefined && fields.length > 0 ? { fields } : {}),
    ...(url !== undefined ? { url } : {}),
  }
}

function projectElicitationFields(schema: ElicitationSchema): MobileElicitationField[] {
  return normalizeElicitationForm(schema).map((field) => {
    const base = {
      name: field.name,
      ...(field.title !== undefined ? { title: field.title } : {}),
      ...(field.description !== undefined ? { description: field.description } : {}),
      required: field.required,
    }
    switch (field.kind) {
      case 'string':
        return {
          ...base,
          kind: 'string',
          ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
          ...(field.format !== undefined ? { format: field.format } : {}),
          ...(field.default !== undefined ? { default: field.default } : {}),
        }
      case 'number':
        return {
          ...base,
          kind: 'number',
          integer: field.integer,
          ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
          ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
          ...(field.default !== undefined ? { default: field.default } : {}),
        }
      case 'boolean':
        return {
          ...base,
          kind: 'boolean',
          ...(field.default !== undefined ? { default: field.default } : {}),
        }
      case 'enum':
        return {
          ...base,
          kind: 'enum',
          options: field.options.map(projectElicitationEnumOption),
          ...(field.default !== undefined ? { default: field.default } : {}),
        }
      case 'enum-multi':
        return {
          ...base,
          kind: 'enum-multi',
          options: field.options.map(projectElicitationEnumOption),
          ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
          ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
          ...(field.default !== undefined ? { default: [...field.default] } : {}),
        }
    }
  })
}

function projectElicitationEnumOption(option: {
  value: string
  title: string
  description?: string
}): { value: string; title: string; description?: string } {
  return {
    value: option.value,
    title: option.title,
    ...(option.description !== undefined ? { description: option.description } : {}),
  }
}

type NonSummarySessionEvent = Exclude<MobileSessionEvent, { type: 'summary_changed' }>

export interface TimelineDiff {
  readonly events: NonSummarySessionEvent[]
  readonly changedMessageIds: readonly string[]
}

/**
 * Structural + content diff of two consecutive projected timelines.
 *
 * New ids become `timeline_item_added` (so the phone can append in order),
 * vanished ids become `timeline_item_removed`, existing messages become
 * `message_upsert` (suffix append when the text only grew) and existing tool
 * calls become `tool_call_upsert` when any projected field changed. Notices
 * have no upsert event, so a notice that changed in place is replaced by a
 * remove/add pair.
 */
export function diffTimeline(
  previous: readonly MobileTimelineItem[],
  next: readonly MobileTimelineItem[],
): TimelineDiff {
  const events: NonSummarySessionEvent[] = []
  const changedMessageIds: string[] = []
  const prevById = new Map(previous.map((item) => [item.id, item]))
  const nextIds = new Set(next.map((item) => item.id))

  for (const item of next) {
    const prior = prevById.get(item.id)
    if (prior === undefined) {
      events.push({ type: 'timeline_item_added', item })
      continue
    }
    if (prior.kind !== item.kind) {
      events.push({ type: 'timeline_item_removed', id: item.id })
      events.push({ type: 'timeline_item_added', item })
      continue
    }
    if (item.kind === 'message' && prior.kind === 'message') {
      const upsert = diffMessage(prior, item)
      if (upsert !== undefined) {
        events.push(upsert)
        changedMessageIds.push(item.id)
      }
    } else if (item.kind === 'toolCall' && prior.kind === 'toolCall') {
      if (!sameJson(prior, item)) events.push({ type: 'tool_call_upsert', item })
    } else if (!sameJson(prior, item)) {
      events.push({ type: 'timeline_item_removed', id: item.id })
      events.push({ type: 'timeline_item_added', item })
    }
  }

  for (const item of previous) {
    if (!nextIds.has(item.id)) events.push({ type: 'timeline_item_removed', id: item.id })
  }

  return { events, changedMessageIds }
}

export function diffMessage(
  previous: MobileTimelineMessageItem,
  next: MobileTimelineMessageItem,
): MobileMessageUpsertEvent | undefined {
  const textChanged = previous.text !== next.text
  const sameAppend = textChanged && next.text.startsWith(previous.text)
  const metadataChanged =
    previous.streaming !== next.streaming ||
    previous.memoryTrimmed !== next.memoryTrimmed ||
    previous.hasNonText !== next.hasNonText
  if (!textChanged && !metadataChanged) return undefined
  const textAppend = sameAppend && textChanged ? next.text.slice(previous.text.length) : undefined
  const textReplace = textChanged && !sameAppend ? next.text : undefined
  return {
    type: 'message_upsert',
    id: next.id,
    role: next.role,
    streaming: next.streaming,
    ...(textAppend !== undefined ? { textAppend } : {}),
    ...(textReplace !== undefined ? { textReplace } : {}),
    ...(next.memoryTrimmed !== undefined ? { memoryTrimmed: next.memoryTrimmed } : {}),
    ...(next.hasNonText !== undefined ? { hasNonText: next.hasNonText } : {}),
  }
}

export function diffToolCalls(
  previous: readonly MobileTimelineToolCallItem[],
  next: readonly MobileTimelineToolCallItem[],
): MobileToolCallUpsertEvent[] {
  const prevById = new Map(previous.map((item) => [item.id, item]))
  const events: MobileToolCallUpsertEvent[] = []
  for (const item of next) {
    const prior = prevById.get(item.id)
    if (prior === undefined) continue
    if (!sameJson(prior, item)) events.push({ type: 'tool_call_upsert', item })
  }
  return events
}

export function diffPlan(
  previous: readonly MobilePlanEntry[],
  next: readonly MobilePlanEntry[],
): NonSummarySessionEvent | undefined {
  return sameJson(previous, next) ? undefined : { type: 'plan_snapshot', plan: next }
}

export function diffConfigOptions(
  previous: readonly MobileConfigOption[],
  next: readonly MobileConfigOption[],
): NonSummarySessionEvent | undefined {
  return sameJson(previous, next) ? undefined : { type: 'config_options_snapshot', options: next }
}

/**
 * Summary comparison ignores `updatedAt`: it advances on every projection and
 * would otherwise emit a `summary_changed` event on every throttle flush.
 */
export function summaryChanged(
  previous: MobileBridgeSessionSummary,
  next: MobileBridgeSessionSummary,
): boolean {
  return !sameJson({ ...previous, updatedAt: 0 }, { ...next, updatedAt: 0 })
}

export interface PermissionClearMetadata {
  readonly requestId: string
  readonly reason: MobilePermissionSettleReason
  readonly source: MobilePermissionSettleSource
}

/**
 * A superseded request replaces the previous one before a flush runs, so the
 * old request must still get its `permission_cleared` (phone-side cache and UI
 * key off `requestId`). Returns zero, one, or two events in wire order.
 */
export function diffPermission(
  previous: MobilePendingPermission | undefined,
  next: MobilePendingPermission | undefined,
  cleared?: PermissionClearMetadata,
): NonSummarySessionEvent[] {
  const events: NonSummarySessionEvent[] = []
  const replaced = previous !== undefined && next?.requestId !== previous.requestId
  if (previous !== undefined && replaced) {
    const metadata = cleared?.requestId === previous.requestId ? cleared : undefined
    events.push({
      type: 'permission_cleared',
      requestId: previous.requestId,
      reason: metadata?.reason ?? 'cancelled',
      source: metadata?.source ?? 'pc',
    })
  }
  if (next !== undefined && (previous === undefined || replaced || !sameJson(previous, next))) {
    events.push({ type: 'permission_upsert', permission: next })
  }
  return events
}

export function diffElicitation(
  previous: MobilePendingElicitation | undefined,
  next: MobilePendingElicitation | undefined,
): NonSummarySessionEvent | undefined {
  if (next === undefined) {
    return previous === undefined ? undefined : { type: 'elicitation_cleared' }
  }
  if (previous !== undefined && sameJson(previous, next)) return undefined
  return { type: 'elicitation_upsert', elicitation: next }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function readObservable<T>(observable: IObservable<T>, r?: IReader): T {
  return r ? observable.read(r) : observable.get()
}
