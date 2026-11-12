/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure projections from the ACP session view model onto the mobile wire shapes,
 *  plus the diff helpers that turn consecutive projections into delta events.
 *  Kept free of DI/observables so the merge rules (prefix append vs. replace,
 *  diff statistics, notice replacement) are unit-testable in isolation.
 *--------------------------------------------------------------------------------------------*/

import type {
  AvailableCommand,
  ElicitationSchema,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import type { IObservable, IReader } from '@universe-editor/platform'
import {
  clampText,
  isPreviewableImageMimeType,
  MAX_COMMAND_DESCRIPTION_LENGTH,
  MAX_COMMAND_INPUT_HINT_LENGTH,
  MAX_COMMAND_NAME_LENGTH,
  MAX_CONFIG_OPTIONS,
  MAX_CURRENCY_LENGTH,
  MAX_ELICITATION_CONTENT_KEYS,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_ID_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MOBILE_COMMANDS,
  MAX_PERMISSION_OPTIONS,
  MAX_PLAN_ENTRIES,
  MAX_REASON_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TIMELINE_ITEMS,
  MAX_TITLE_LENGTH,
  MAX_TOOL_CALL_DIFFS,
  MAX_TOOL_CALL_LOCATIONS,
  MAX_WORKSPACE_NAME_LENGTH,
  type MobileAutoResolve,
  type MobileAvailableCommand,
  type MobileConfigOption,
  type MobileElicitationField,
  type MobileMessageAttachment,
  type MobileMessageImage,
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
import { computeLineDiff, MEDIA_TRUNCATED_META_KEY } from '@universe-editor/acp-view-model'
import { readMobileAttachmentMeta } from '../acp/promptAttachment.js'
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
  /** Durable id of the parent session when this row is a side task. */
  readonly sideTaskOf?: string
  /** Number of direct side-task children (parent rows only). */
  readonly sideTaskChildCount?: number
}

/**
 * Extra facts a timeline item needs to decide its rewind / fork affordances.
 * `firstUserId` is the local `AcpMessage.id` of the first user turn: it can be
 * rewound to, but not forked from (there is no predecessor to slice at).
 */
export interface TimelineProjectionContext {
  readonly firstUserId?: string
  readonly forkSupported: boolean
  readonly readOnly: boolean
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
    localId: clampText(session.id, MAX_ID_LENGTH),
    ...(durableId !== undefined ? { durableId: clampText(durableId, MAX_ID_LENGTH) } : {}),
    agentId: clampText(session.agentId, MAX_ID_LENGTH),
    ...(options.agentName !== undefined
      ? { agentName: clampText(options.agentName, MAX_TITLE_LENGTH) }
      : {}),
    title: clampText(options.title, MAX_TITLE_LENGTH),
    status: clampText(readObservable(session.status, r), MAX_STATUS_LENGTH),
    displayStatus: clampText(displayStatus, MAX_STATUS_LENGTH),
    bucket: statusBucketFor(displayStatus),
    ...(session.cwd !== undefined
      ? { cwd: clampText(session.cwd, MAX_WORKSPACE_NAME_LENGTH) }
      : {}),
    ...(session.authority !== undefined
      ? { authority: clampText(session.authority, MAX_WORKSPACE_NAME_LENGTH) }
      : {}),
    readOnly: session.readOnly,
    hasPendingPermission: pendingPermission !== undefined,
    hasPendingElicitation: pendingElicitation !== undefined,
    backgroundTaskCount: readObservable(session.backgroundTaskCount, r),
    imageSupported: readObservable(session.imageSupported, r),
    ...(readObservable(session.forkSupported, r) ? { forkSupported: true } : {}),
    ...(readObservable(session.rewindSupported, r) ? { rewindSupported: true } : {}),
    ...(options.sideTaskOf !== undefined
      ? { sideTaskOf: clampText(options.sideTaskOf, MAX_ID_LENGTH) }
      : {}),
    ...(options.sideTaskChildCount !== undefined && options.sideTaskChildCount > 0
      ? { sideTaskChildCount: options.sideTaskChildCount }
      : {}),
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
  const messages = readObservable(session.messages, r)
  const firstUserId = messages.find((message) => message.role === 'user')?.id
  const context: TimelineProjectionContext = {
    ...(firstUserId !== undefined ? { firstUserId } : {}),
    forkSupported: readObservable(session.forkSupported, r),
    readOnly: session.readOnly,
  }
  return {
    summary: toBridgeSummary(session, options, r),
    timeline: readObservable(session.timeline, r)
      .slice(0, MAX_TIMELINE_ITEMS)
      .map((item) => projectTimelineItem(item, context)),
    plan: readObservable(session.plan, r).slice(0, MAX_PLAN_ENTRIES).map(projectPlanEntry),
    configOptions: readObservable(session.configOptions, r)
      .slice(0, MAX_CONFIG_OPTIONS)
      .map(projectConfigOption),
    availableCommands: projectAvailableCommands(readObservable(session.availableCommands, r)),
    isReplayingHistory: readObservable(session.isReplayingHistory, r),
    ...(usage !== undefined ? { usage } : {}),
    ...(permission !== undefined ? { pendingPermission: permission } : {}),
    ...(elicitation !== undefined ? { pendingElicitation: elicitation } : {}),
  }
}

export function projectTimelineItem(
  item: TimelineItem,
  context?: TimelineProjectionContext,
): MobileTimelineItem {
  switch (item.kind) {
    case 'message':
      return projectMessage(item.message, context)
    case 'toolCall':
      return projectToolCall(item.call)
    case 'compaction':
      return {
        kind: 'notice',
        id: clampText(item.id, MAX_ID_LENGTH),
        noticeKind: 'compaction',
        phase: item.compaction.phase,
        ...(item.compaction.reason !== undefined
          ? { text: clampText(item.compaction.reason, MAX_TITLE_LENGTH) }
          : {}),
      }
    case 'resurrection':
      return {
        kind: 'notice',
        id: clampText(item.id, MAX_ID_LENGTH),
        noticeKind: 'resurrection',
        phase: item.resurrection.phase,
        ...(item.resurrection.reason !== undefined
          ? { text: clampText(item.resurrection.reason, MAX_TITLE_LENGTH) }
          : {}),
      }
  }
}

export function projectMessage(
  message: AcpMessage,
  context?: TimelineProjectionContext,
): MobileTimelineMessageItem {
  // Mirrors agentRewindPickItems.ts: only user turns with a client messageId are
  // anchors, and auto-retry "continue" turns are never user-authored.
  const anchorMessageId =
    message.role === 'user' && message.autoRetry !== true ? message.messageId : undefined
  const anchored = anchorMessageId !== undefined && anchorMessageId.length > 0
  const attachments: MobileMessageAttachment[] = []
  const images: MobileMessageImage[] = []
  const representedBlocks = new Set<number>()
  let hasNonText = false
  let imageOrdinal = 0
  for (const [blockIndex, block] of message.blocks.entries()) {
    if (block.type === 'text') continue
    if (block.type === 'image') {
      const ordinal = imageOrdinal++
      const stamped = block._meta?.['mobileAttachment'] !== undefined
      const attachment = stamped ? readMobileAttachmentMeta(block) : undefined
      if (attachment !== undefined) {
        if (attachments.length < MAX_ATTACHMENTS_PER_PROMPT) {
          attachments.push(attachment)
          representedBlocks.add(blockIndex)
        } else {
          hasNonText = true
        }
        continue
      }
      if (stamped) {
        // A phone-stamped block the phone would reject stays a plain non-text block.
        hasNonText = true
        continue
      }
      const mimeType = block.mimeType.toLowerCase()
      if (!isPreviewableImageMimeType(mimeType) || images.length >= MAX_IMAGES_PER_MESSAGE) {
        hasNonText = true
        continue
      }
      const truncated = block.data === '' || block._meta?.[MEDIA_TRUNCATED_META_KEY] === true
      images.push({
        index: ordinal,
        mimeType,
        size: truncated ? 0 : base64DecodedByteLength(block.data),
        ...(truncated ? { truncated: true } : {}),
      })
      representedBlocks.add(blockIndex)
      continue
    }
    const attachment = readMobileAttachmentMeta(block)
    if (attachment === undefined) {
      hasNonText = true
    } else if (attachments.length < MAX_ATTACHMENTS_PER_PROMPT) {
      attachments.push(attachment)
      representedBlocks.add(blockIndex)
    } else {
      hasNonText = true
    }
  }
  return {
    kind: 'message',
    id: clampText(message.id, MAX_ID_LENGTH),
    role: message.role,
    // Rebuild only when a non-text block is now represented on the wire: its
    // `[image: mime]` / `[resource: name]` placeholder must not duplicate the
    // thumbnail or file card.
    text: clampText(
      representedBlocks.size > 0
        ? projectMessageText(message.blocks, representedBlocks)
        : message.text,
      MAX_TEXT_LENGTH,
    ),
    streaming: message.streaming,
    ...(message.memoryTrimmed ? { memoryTrimmed: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(hasNonText ? { hasNonText: true } : {}),
    ...(anchored ? { messageId: clampText(anchorMessageId, MAX_ID_LENGTH) } : {}),
    ...(anchored && context !== undefined
      ? {
          canFork: context.forkSupported && !context.readOnly && message.id !== context.firstUserId,
        }
      : {}),
  }
}

/** Mirrors `blocksToText` but omits non-text blocks already represented on the wire. */
function projectMessageText(
  blocks: AcpMessage['blocks'],
  representedBlocks: ReadonlySet<number>,
): string {
  let text = ''
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type === 'text') {
      text += block.text
      continue
    }
    if (representedBlocks.has(blockIndex)) continue
    if (block.type === 'image') {
      text += `[image: ${block.mimeType}]`
      continue
    }
    if (block.type === 'resource') {
      text += `[resource: ${block.resource.uri}]`
      continue
    }
    if (block.type === 'resource_link') {
      text += `[resource: ${block.name ?? block.uri}]`
      continue
    }
    if (block.type === 'audio') {
      text += `[audio: ${block.mimeType}]`
    }
  }
  return text
}

function base64DecodedByteLength(data: string): number {
  if (data.length === 0) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

const TOOL_PREVIEW_CHARS = 1024
const MAX_PROJECTED_DIFFS = MAX_TOOL_CALL_DIFFS
const MAX_PROJECTED_LOCATIONS = MAX_TOOL_CALL_LOCATIONS

export function projectToolCall(call: AcpToolCall): MobileTimelineToolCallItem {
  const diffs = call.diffs.slice(0, MAX_PROJECTED_DIFFS).map(projectDiffStat)
  const locations = call.locations?.slice(0, MAX_PROJECTED_LOCATIONS)
  // Mirrors the desktop only-message keep-set predicates in timelineCollapse.ts.
  const subagent = call.subagent === true || (call.children?.length ?? 0) > 0
  const startedAt = nonNegativeSafeInt(call.startedAt)
  const durationMs = nonNegativeSafeInt(call.durationMs)
  const settleReason =
    call.settleReason !== undefined && call.settleReason.length > 0
      ? clampText(call.settleReason, MAX_REASON_LENGTH)
      : undefined
  return {
    kind: 'toolCall',
    id: clampText(call.id, MAX_ID_LENGTH),
    title: clampText(call.title, MAX_TITLE_LENGTH),
    toolKind: clampText(call.kind, MAX_STATUS_LENGTH),
    status: clampText(call.status, MAX_STATUS_LENGTH),
    ...(call.text.length > 0 ? { preview: call.text.slice(0, TOOL_PREVIEW_CHARS) } : {}),
    hasDetail: call.text.length > 0 || call.blocks.length > 0 || call.diffs.length > 0,
    ...(diffs.length > 0 ? { diffs } : {}),
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
    ...(call.memoryTrimmed ? { memoryTrimmed: true } : {}),
    ...(subagent ? { subagent: true } : {}),
    ...(call.requiresUserDecision === true ? { requiresUserDecision: true } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(settleReason !== undefined ? { settleReason } : {}),
    ...(call.syntheticDenial === true ? { syntheticDenial: true } : {}),
  }
}

function nonNegativeSafeInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function projectDiffStat(diff: AcpToolCall['diffs'][number]): MobileToolCallDiffStat {
  let added = 0
  let removed = 0
  for (const line of computeLineDiff(diff.oldText, diff.newText)) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { path: clampText(diff.path, MAX_WORKSPACE_NAME_LENGTH), added, removed }
}

export function projectPlanEntry(entry: AcpPlanEntry): MobilePlanEntry {
  return {
    content: clampText(entry.content, MAX_TEXT_LENGTH),
    status: entry.status,
    ...(entry.priority !== undefined
      ? { priority: clampText(entry.priority, MAX_STATUS_LENGTH) }
      : {}),
  }
}

export function projectAvailableCommands(
  commands: readonly AvailableCommand[],
): MobileAvailableCommand[] {
  const projected: MobileAvailableCommand[] = []
  const seen = new Set<string>()
  for (const command of commands) {
    if (projected.length >= MAX_MOBILE_COMMANDS) break
    const name = normalizeCommandName(command.name)
    // A name with whitespace or an empty stem cannot be a slash token; sending
    // it would fail the gateway's whole-frame validation and drop the delta.
    if (name.length === 0 || /\s/.test(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const description =
      typeof command.description === 'string' ? command.description.replace(/\s+/g, ' ').trim() : ''
    const hint =
      command.input != null && typeof command.input.hint === 'string'
        ? command.input.hint.trim()
        : ''
    projected.push({
      name: clampText(name, MAX_COMMAND_NAME_LENGTH),
      description: clampText(description, MAX_COMMAND_DESCRIPTION_LENGTH),
      ...(hint.length > 0 ? { inputHint: clampText(hint, MAX_COMMAND_INPUT_HINT_LENGTH) } : {}),
    })
  }
  return projected
}

/** Display/insertion always adds the leading slash; wire names never carry it. */
export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

export function diffAvailableCommands(
  previous: readonly MobileAvailableCommand[],
  next: readonly MobileAvailableCommand[],
): NonSummarySessionEvent | undefined {
  return sameJson(previous, next)
    ? undefined
    : { type: 'available_commands_snapshot', commands: next }
}

export function projectConfigOption(option: SessionConfigOption): MobileConfigOption {
  const category =
    option.category != null ? clampText(option.category, MAX_STATUS_LENGTH) : undefined
  if (option.type === 'boolean') {
    return {
      id: clampText(option.id, MAX_ID_LENGTH),
      name: clampText(option.name, MAX_TITLE_LENGTH),
      ...(category !== undefined ? { category } : {}),
      type: 'boolean',
      currentValue: option.currentValue ? 'On' : 'Off',
    }
  }
  const values = flattenSelectOptions(option.options)
    .slice(0, MAX_CONFIG_OPTIONS)
    .map((value) => ({
      value: clampText(value.value, MAX_TITLE_LENGTH),
      label: clampText(value.name, MAX_TITLE_LENGTH),
    }))
  return {
    id: clampText(option.id, MAX_ID_LENGTH),
    name: clampText(option.name, MAX_TITLE_LENGTH),
    ...(category !== undefined ? { category } : {}),
    type: 'select',
    currentValue: clampText(
      findConfigOptionLabel(option.options, option.currentValue),
      MAX_TITLE_LENGTH,
    ),
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
      ? {
          cost: {
            amount: usage.cost.amount,
            currency: clampText(usage.cost.currency, MAX_CURRENCY_LENGTH),
          },
        }
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
          optionId: clampText(auto.optionId, MAX_ID_LENGTH),
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
    requestId: clampText(permission.requestId, MAX_REQUEST_ID_LENGTH),
    toolCallId: clampText(permission.toolCallId, MAX_ID_LENGTH),
    title: clampText(permission.title, MAX_TITLE_LENGTH),
    ...(permission.kind !== undefined
      ? { kind: clampText(permission.kind, MAX_STATUS_LENGTH) }
      : {}),
    options: permission.options.slice(0, MAX_PERMISSION_OPTIONS).map((option) => ({
      optionId: clampText(option.optionId, MAX_ID_LENGTH),
      name: clampText(option.name, MAX_TITLE_LENGTH),
      ...(option.kind !== undefined ? { kind: clampText(option.kind, MAX_STATUS_LENGTH) } : {}),
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
      ? projectElicitationFields(request.requestedSchema as ElicitationSchema).slice(
          0,
          MAX_CONFIG_OPTIONS,
        )
      : undefined
  return {
    requestId: clampText(elicitation.requestId, MAX_REQUEST_ID_LENGTH),
    mode: clampText(request.mode, MAX_STATUS_LENGTH),
    message: clampText(request.message, MAX_TEXT_LENGTH),
    ...(title !== undefined ? { title: clampText(title, MAX_TITLE_LENGTH) } : {}),
    ...(toolCallId !== undefined ? { toolCallId: clampText(toolCallId, MAX_ID_LENGTH) } : {}),
    ...(fields !== undefined && fields.length > 0 ? { fields } : {}),
    ...(url !== undefined ? { url: clampText(url, MAX_TEXT_LENGTH) } : {}),
  }
}

function projectElicitationFields(schema: ElicitationSchema): MobileElicitationField[] {
  return normalizeElicitationForm(schema).map((field) => {
    const base = {
      name: clampText(field.name, MAX_ID_LENGTH),
      ...(field.title !== undefined ? { title: clampText(field.title, MAX_TITLE_LENGTH) } : {}),
      ...(field.description !== undefined
        ? { description: clampText(field.description, MAX_TEXT_LENGTH) }
        : {}),
      required: field.required,
    }
    switch (field.kind) {
      case 'string':
        return {
          ...base,
          kind: 'string',
          ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.pattern !== undefined
            ? { pattern: clampText(field.pattern, MAX_TEXT_LENGTH) }
            : {}),
          ...(field.format !== undefined
            ? { format: clampText(field.format, MAX_STATUS_LENGTH) }
            : {}),
          ...(field.default !== undefined
            ? { default: clampText(field.default, MAX_TEXT_LENGTH) }
            : {}),
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
          options: field.options.slice(0, MAX_CONFIG_OPTIONS).map(projectElicitationEnumOption),
          ...(field.default !== undefined
            ? { default: clampText(field.default, MAX_TITLE_LENGTH) }
            : {}),
        }
      case 'enum-multi':
        return {
          ...base,
          kind: 'enum-multi',
          options: field.options.slice(0, MAX_CONFIG_OPTIONS).map(projectElicitationEnumOption),
          ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
          ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
          ...(field.default !== undefined
            ? {
                default: [...field.default]
                  .slice(0, MAX_ELICITATION_CONTENT_KEYS)
                  .map((entry) => clampText(entry, MAX_TEXT_LENGTH)),
              }
            : {}),
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
    value: clampText(option.value, MAX_TITLE_LENGTH),
    title: clampText(option.title, MAX_TITLE_LENGTH),
    ...(option.description !== undefined
      ? { description: clampText(option.description, MAX_TEXT_LENGTH) }
      : {}),
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
  const attachmentsChanged = !sameJson(previous.attachments ?? [], next.attachments ?? [])
  const imagesChanged = !sameJson(previous.images ?? [], next.images ?? [])
  const metadataChanged =
    previous.streaming !== next.streaming ||
    previous.memoryTrimmed !== next.memoryTrimmed ||
    previous.hasNonText !== next.hasNonText ||
    attachmentsChanged ||
    imagesChanged ||
    previous.messageId !== next.messageId ||
    previous.canFork !== next.canFork
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
    ...(next.attachments !== undefined ? { attachments: next.attachments } : {}),
    ...(attachmentsChanged && next.attachments === undefined ? { attachments: [] } : {}),
    ...(next.images !== undefined ? { images: next.images } : {}),
    ...(imagesChanged && next.images === undefined ? { images: [] } : {}),
    ...(next.hasNonText !== undefined ? { hasNonText: next.hasNonText } : {}),
    ...(next.messageId !== undefined ? { messageId: next.messageId } : {}),
    ...(next.canFork !== undefined ? { canFork: next.canFork } : {}),
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
 * Summary comparison ignores `updatedAt`: a session without a history row yet
 * stamps the projection time, so comparing it would emit `summary_changed` on
 * every throttle flush.
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
