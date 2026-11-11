import {
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_ATTACHMENT_ID_LENGTH,
  MAX_ATTACHMENT_MIME_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS_PER_PROMPT,
  isMobileAttachmentKind,
  isMobileImageMimeType,
  type MobileMessageAttachment,
} from './attachments.js'
import type {
  DraftUpdateFrame,
  MobileDraftContextSummary,
  MobileDraftFileRef,
  MobileDraftImageRef,
  MobileDraftPayload,
  MobileDraftRefSummary,
  MobileDraftState,
} from './draft.js'
import { MOBILE_DRAFT_SOURCES } from './draft.js'
import { isMobileErrorCode } from './errors.js'
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_INDEX,
  type MobileMessageImage,
} from './images.js'
import type {
  ClientFrame,
  ClientStateFrame,
  CommandFrame,
  DeviceTrustChangedFrame,
  HelloFrame,
  HelloOkFrame,
  InboxDeltaFrame,
  InboxSnapshotFrame,
  MobileAttentionKind,
  MobileAvailableCommand,
  MobileConfigOption,
  MobileConfigOptionType,
  MobileConfigOptionValue,
  MobileDeliveryError,
  MobileDeliveryExpectation,
  MobileDeliveryPhase,
  MobileDeliverySummary,
  MobileDeliverySyncSummary,
  MobileDraftUpdateEvent,
  MobileElicitationAction,
  MobileElicitationContentValue,
  MobileElicitationEnumOption,
  MobileElicitationField,
  MobileElicitationFieldKind,
  MobileMessageRole,
  MobileNoticeKind,
  MobileNoticePhase,
  MobileNotificationPrefs,
  MobilePermissionSettleReason,
  MobilePermissionSettleSource,
  MobilePendingElicitation,
  MobilePendingPermission,
  MobilePermissionOption,
  MobilePlanEntry,
  MobilePlanEntryStatus,
  MobilePushSubscription,
  MobileResyncScope,
  MobileSessionBucket,
  MobileSessionEvent,
  MobileSessionRef,
  MobileSessionSnapshot,
  MobileSessionSummary,
  MobileTimelineItem,
  MobileTimelineItemKind,
  MobileTimelineMessageItem,
  MobileTimelineNoticeItem,
  MobileTimelineToolCallItem,
  MobileToolCallDiffStat,
  MobileToolCallLocation,
  MobileUsage,
  NotificationFrame,
  PingFrame,
  PongFrame,
  PushSubscribeFrame,
  ResyncRequiredFrame,
  ServerErrorFrame,
  ServerFrame,
  SessionDeltaFrame,
  SessionRemovedFrame,
  SessionSnapshotFrame,
  SetNotificationPrefsFrame,
  SubscribeInboxFrame,
  SubscribeSessionFrame,
  UnsubscribeSessionFrame,
} from './frames.js'
import {
  MOBILE_ATTENTION_KINDS,
  MOBILE_CONFIG_OPTION_TYPES,
  MOBILE_DELIVERY_PHASES,
  MOBILE_ELICITATION_ACTIONS,
  MOBILE_ELICITATION_FIELD_KINDS,
  MOBILE_MESSAGE_ROLES,
  MOBILE_NOTICE_KINDS,
  MOBILE_NOTICE_PHASES,
  MOBILE_PERMISSION_SETTLE_REASONS,
  MOBILE_PERMISSION_SETTLE_SOURCES,
  MOBILE_PLAN_ENTRY_STATUSES,
  MOBILE_RESYNC_SCOPES,
  MOBILE_SESSION_BUCKETS,
  MOBILE_TIMELINE_ITEM_KINDS,
} from './frames.js'
import type { PairDevicePlatform, PairRequest } from './pairing.js'
import { isValidPairCodeShape, normalizePairCode, PAIR_DEVICE_PLATFORMS } from './pairing.js'
import { MOBILE_PROTOCOL_VERSION } from './version.js'

/**
 * Compared against JS string length (UTF-16 code units), not encoded bytes.
 * The transport is JSON text. Drafts are the only client payload that can
 * approach the cap: 32K non-ASCII characters are ~96KB encoded, so the limit
 * leaves room for JSON overhead rather than silently dropping long drafts.
 */
export const MAX_CLIENT_FRAME_BYTES = 192 * 1024
/**
 * Soft ceiling for one server → client frame. The gateway trims oversized
 * snapshots (oldest timeline items first) rather than dropping the frame.
 */
export const MAX_SERVER_FRAME_BYTES = 1024 * 1024
export const MAX_TOKEN_LENGTH = 128
export const MAX_DEVICE_NAME_LENGTH = 64
export const MAX_CLIENT_VERSION_LENGTH = 64
export const MAX_SERVER_VERSION_LENGTH = 64
export const MAX_CAPABILITIES = 32
/** One delivery is a bounded commit range; larger ranges are rejected. */
export const MAX_DELIVERY_COMMITS = 200
export const MAX_DELIVERY_ERROR_LENGTH = 2000
export const MAX_DELIVERY_DETAIL_LENGTH = 8000
export const MAX_ID_LENGTH = 128
export const MAX_TITLE_LENGTH = 512
export const MAX_WORKSPACE_NAME_LENGTH = 256
export const MAX_STATUS_LENGTH = 64
export const MAX_TEXT_LENGTH = MAX_SERVER_FRAME_BYTES
export const MAX_PREVIEW_LENGTH = 4096
export const MAX_TIMELINE_ITEMS = 20_000
export const MAX_EVENTS_PER_DELTA = 5_000
export const MAX_PLAN_ENTRIES = 500
export const MAX_CONFIG_OPTIONS = 200
export const MAX_MOBILE_COMMANDS = 100
export const MAX_COMMAND_NAME_LENGTH = 128
export const MAX_COMMAND_DESCRIPTION_LENGTH = 256
export const MAX_COMMAND_INPUT_HINT_LENGTH = 128
export const MAX_PERMISSION_OPTIONS = 64
export const MAX_TOOL_CALL_DIFFS = 256
export const MAX_TOOL_CALL_LOCATIONS = 256
export const MAX_REASON_LENGTH = 1024
export const MAX_REQUEST_ID_LENGTH = 128
export const MAX_CURRENCY_LENGTH = 16
/** Phone prompt cap; also applies to a new session's initial prompt. */
export const MAX_PROMPT_LENGTH = 32 * 1024
export const MAX_DRAFT_TEXT_LENGTH = MAX_PROMPT_LENGTH
export const MAX_DRAFT_REFS = 64
export const MAX_DRAFT_REF_KIND_LENGTH = 64
export const MAX_DRAFT_REF_LABEL_LENGTH = 512
export const MAX_DRAFT_CONTEXTS = 16
export const MAX_DRAFT_CONTEXT_PATH_LENGTH = MAX_WORKSPACE_NAME_LENGTH
export const MAX_DRAFT_CONTEXT_LANGUAGE_LENGTH = 64
export const MAX_DRAFT_IMAGES = MAX_IMAGE_ATTACHMENTS_PER_PROMPT
export const MAX_DRAFT_FILES = MAX_ATTACHMENTS_PER_PROMPT
/** The PC can hold its own image set plus files uploaded by a phone. */
export const MAX_DRAFT_ATTACHMENTS = MAX_DRAFT_IMAGES + MAX_DRAFT_FILES
export const MAX_DRAFT_NAME_LENGTH = MAX_ATTACHMENT_NAME_LENGTH
export const MAX_DRAFT_UPDATE_ID_LENGTH = 64
/** Whole-message quote cap for side tasks; mirrors the desktop selection cap. */
export const MAX_SIDE_TASK_QUOTE_LENGTH = 8000
/** First-prompt excerpt carried by a session-history row (search + secondary line). */
export const MAX_HISTORY_PROMPT_LENGTH = 280
export const MAX_FEEDBACK_LENGTH = 8 * 1024
export const MAX_ELICITATION_CONTENT_KEYS = 128
export const MAX_PUSH_ENDPOINT_LENGTH = 2048
export const MAX_PUSH_KEY_LENGTH = 256
export const MAX_NOTIFICATION_ID_LENGTH = 128
export const MAX_NOTIFICATION_BODY_LENGTH = 1024

export type ParseErrorCode = 'bad_request' | 'protocol_mismatch'

export interface ParseError {
  code: ParseErrorCode
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ParseError }

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function fail<T>(code: ParseErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function parseJsonObject(text: string): Result<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('bad_request', 'frame is not valid JSON')
  }
  if (!isRecord(parsed)) return fail('bad_request', 'frame must be a JSON object')
  return ok(parsed)
}

function parseCapabilities(value: unknown): Result<string[]> {
  if (!Array.isArray(value)) return fail('bad_request', 'capabilities must be an array')
  if (value.length > MAX_CAPABILITIES) {
    return fail('bad_request', `capabilities must contain at most ${MAX_CAPABILITIES} entries`)
  }
  const capabilities: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return fail('bad_request', 'capabilities entries must be strings')
    }
    capabilities.push(item)
  }
  return ok(capabilities)
}

export function parseClientFrame(text: string): Result<ClientFrame> {
  if (text.length > MAX_CLIENT_FRAME_BYTES) {
    return fail('bad_request', `frame exceeds ${MAX_CLIENT_FRAME_BYTES} characters`)
  }
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return parsed
  const frame = parsed.value
  const type = frame.type
  if (typeof type !== 'string') return fail('bad_request', 'frame.type must be a string')
  switch (type) {
    case 'hello':
      return parseHelloFrame(frame)
    case 'ping':
      return parsePingFrame(frame)
    case 'subscribe_inbox':
      return parseSubscribeInboxFrame(frame)
    case 'unsubscribe_inbox':
      return ok({ type: 'unsubscribe_inbox' })
    case 'subscribe_session':
      return parseSubscribeSessionFrame(frame)
    case 'unsubscribe_session':
      return parseUnsubscribeSessionFrame(frame)
    case 'command':
      return parseCommandFrame(frame)
    case 'push_subscribe':
      return parsePushSubscribeFrame(frame)
    case 'push_unsubscribe':
      return ok({ type: 'push_unsubscribe' })
    case 'set_notification_prefs':
      return parseSetNotificationPrefsFrame(frame)
    case 'client_state':
      return parseClientStateFrame(frame)
    case 'draft_update':
      return parseDraftUpdateFrame(frame)
    default:
      return fail('bad_request', `unknown client frame type: ${type}`)
  }
}

export function parseServerFrame(text: string): Result<ServerFrame> {
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return parsed
  const frame = parsed.value
  const type = frame.type
  if (typeof type !== 'string') return fail('bad_request', 'frame.type must be a string')
  switch (type) {
    case 'hello_ok':
      return parseHelloOkFrame(frame)
    case 'pong':
      return parsePongFrame(frame)
    case 'inbox_snapshot':
      return parseInboxSnapshotFrame(frame)
    case 'inbox_delta':
      return parseInboxDeltaFrame(frame)
    case 'session_snapshot':
      return parseSessionSnapshotFrame(frame)
    case 'session_delta':
      return parseSessionDeltaFrame(frame)
    case 'session_removed':
      return parseSessionRemovedFrame(frame)
    case 'command_result':
      return parseCommandResultFrame(frame)
    case 'notification':
      return parseNotificationFrame(frame)
    case 'resync_required':
      return parseResyncRequiredFrame(frame)
    case 'server_error':
      return parseServerErrorFrame(frame)
    case 'device_revoked':
      return ok({ type: 'device_revoked' })
    case 'device_trust_changed':
      return parseDeviceTrustChangedFrame(frame)
    default:
      return fail('bad_request', `unknown server frame type: ${type}`)
  }
}

export function parsePairRequest(json: unknown): Result<PairRequest> {
  if (!isRecord(json)) return fail('bad_request', 'pair request must be a JSON object')
  const rawCode = json.code
  if (typeof rawCode !== 'string') return fail('bad_request', 'code must be a string')
  const code = normalizePairCode(rawCode)
  if (!isValidPairCodeShape(code)) return fail('bad_request', 'code is not a valid pairing code')
  const deviceName = json.deviceName
  if (!isNonEmptyBoundedString(deviceName, MAX_DEVICE_NAME_LENGTH)) {
    return fail('bad_request', `deviceName must be 1–${MAX_DEVICE_NAME_LENGTH} characters`)
  }
  const platform = json.platform
  if (typeof platform !== 'string' || !isPairDevicePlatform(platform)) {
    return fail('bad_request', 'platform must be ios, android, or other')
  }
  return ok({ code, deviceName, platform })
}

export function serializeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame)
}

function parseHelloFrame(frame: Record<string, unknown>): Result<HelloFrame> {
  const protocolVersion = frame.protocolVersion
  if (!isNonNegativeInteger(protocolVersion)) {
    return fail('bad_request', 'hello.protocolVersion must be a non-negative integer')
  }
  if (protocolVersion !== MOBILE_PROTOCOL_VERSION) {
    return fail('protocol_mismatch', `unsupported protocol version: ${protocolVersion}`)
  }
  const token = frame.token
  if (!isNonEmptyBoundedString(token, MAX_TOKEN_LENGTH)) {
    return fail('bad_request', `hello.token must be 1–${MAX_TOKEN_LENGTH} characters`)
  }
  const clientVersion = frame.clientVersion
  if (!isBoundedString(clientVersion, MAX_CLIENT_VERSION_LENGTH)) {
    return fail('bad_request', `hello.clientVersion must be at most ${MAX_CLIENT_VERSION_LENGTH}`)
  }
  const capabilities = parseCapabilities(frame.capabilities)
  if (!capabilities.ok) return capabilities
  return ok({
    type: 'hello',
    protocolVersion,
    token,
    clientVersion,
    capabilities: capabilities.value,
  })
}

function parsePingFrame(frame: Record<string, unknown>): Result<PingFrame> {
  const t = frame.t
  if (!isFiniteNumber(t)) return fail('bad_request', 'ping.t must be a finite number')
  return ok({ type: 'ping', t })
}

function parseSubscribeInboxFrame(frame: Record<string, unknown>): Result<SubscribeInboxFrame> {
  const afterSeq = frame.afterSeq
  if (afterSeq === undefined) return ok({ type: 'subscribe_inbox' })
  if (!isNonNegativeInteger(afterSeq)) {
    return fail('bad_request', 'subscribe_inbox.afterSeq must be a non-negative integer')
  }
  return ok({ type: 'subscribe_inbox', afterSeq })
}

function parseSubscribeSessionFrame(frame: Record<string, unknown>): Result<SubscribeSessionFrame> {
  const ref = parseSessionRef(frame.ref)
  if (!ref.ok) return ref
  const afterSeq = frame.afterSeq
  if (afterSeq === undefined) return ok({ type: 'subscribe_session', ref: ref.value })
  if (!isNonNegativeInteger(afterSeq)) {
    return fail('bad_request', 'subscribe_session.afterSeq must be a non-negative integer')
  }
  return ok({ type: 'subscribe_session', ref: ref.value, afterSeq })
}

function parseUnsubscribeSessionFrame(
  frame: Record<string, unknown>,
): Result<UnsubscribeSessionFrame> {
  const ref = parseSessionRef(frame.ref)
  if (!ref.ok) return ref
  return ok({ type: 'unsubscribe_session', ref: ref.value })
}

function parsePushSubscribeFrame(frame: Record<string, unknown>): Result<PushSubscribeFrame> {
  const subscription = parsePushSubscription(frame.subscription)
  if (!subscription.ok) return subscription
  if (frame.prefs === undefined) {
    return ok({ type: 'push_subscribe', subscription: subscription.value })
  }
  const prefs = parseNotificationPrefs(frame.prefs, 'push_subscribe.prefs')
  if (!prefs.ok) return prefs
  return ok({ type: 'push_subscribe', subscription: subscription.value, prefs: prefs.value })
}

function parseSetNotificationPrefsFrame(
  frame: Record<string, unknown>,
): Result<SetNotificationPrefsFrame> {
  const prefs = parseNotificationPrefs(frame, 'set_notification_prefs')
  if (!prefs.ok) return prefs
  return ok({
    type: 'set_notification_prefs',
    enabled: prefs.value.enabled,
    ...(prefs.value.kinds !== undefined ? { kinds: prefs.value.kinds } : {}),
    alwaysNotify: prefs.value.alwaysNotify,
  })
}

function parseClientStateFrame(frame: Record<string, unknown>): Result<ClientStateFrame> {
  const visible = frame.visible
  if (typeof visible !== 'boolean') {
    return fail('bad_request', 'client_state.visible must be a boolean')
  }
  return ok({ type: 'client_state', visible })
}

function parseDraftUpdateFrame(frame: Record<string, unknown>): Result<DraftUpdateFrame> {
  const ref = parseSessionRef(frame.ref)
  if (!ref.ok) return ref
  const baseRevision = frame.baseRevision
  if (!isNonNegativeInteger(baseRevision)) {
    return fail('bad_request', 'draft_update.baseRevision must be a non-negative integer')
  }
  const clientUpdateId = frame.clientUpdateId
  if (!isNonEmptyBoundedString(clientUpdateId, MAX_DRAFT_UPDATE_ID_LENGTH)) {
    return fail(
      'bad_request',
      `draft_update.clientUpdateId must be 1–${MAX_DRAFT_UPDATE_ID_LENGTH} characters`,
    )
  }
  const draft = parseDraftPayload(frame.draft)
  if (!draft.ok) return draft
  return ok({
    type: 'draft_update',
    ref: ref.value,
    baseRevision,
    clientUpdateId,
    draft: draft.value,
  })
}

function parseDraftPayload(value: unknown): Result<MobileDraftPayload> {
  if (!isRecord(value)) return fail('bad_request', 'draft_update.draft must be an object')
  if (value['refs'] !== undefined || value['contexts'] !== undefined) {
    return fail('bad_request', 'draft_update.draft must not carry refs or contexts')
  }
  const text = parseDraftText(value['text'])
  if (!text.ok) return text
  const caret = parseDraftCaret(value['caret'], text.value.length)
  if (!caret.ok) return caret
  const images = parseDraftImages(value['images'], 'draft_update.draft.images')
  if (!images.ok) return images
  const files = parseDraftFiles(value['files'], 'draft_update.draft.files')
  if (!files.ok) return files
  const total = parseDraftAttachmentTotal(images.value, files.value)
  if (total !== undefined) return fail('bad_request', total)
  return ok({
    text: text.value,
    caret: caret.value,
    images: images.value,
    ...(files.value !== undefined ? { files: files.value } : {}),
  })
}

function parseDraftState(value: unknown): Result<MobileDraftState> {
  if (!isRecord(value)) return fail('bad_request', 'session.draft must be an object')
  const text = parseDraftText(value['text'])
  if (!text.ok) return text
  const caret = parseDraftCaret(value['caret'], text.value.length)
  if (!caret.ok) return caret
  const images = parseDraftImages(value['images'], 'session.draft.images')
  if (!images.ok) return images
  const files = parseDraftFiles(value['files'], 'session.draft.files')
  if (!files.ok) return files
  const total = parseDraftAttachmentTotal(images.value, files.value)
  if (total !== undefined) return fail('bad_request', total)
  const refs = parseDraftRefs(value['refs'], text.value.length)
  if (!refs.ok) return refs
  const contexts = parseDraftContexts(value['contexts'])
  if (!contexts.ok) return contexts
  const revision = value['revision']
  if (!isNonNegativeInteger(revision)) {
    return fail('bad_request', 'session.draft.revision must be a non-negative integer')
  }
  const updatedAt = value['updatedAt']
  if (!isNonNegativeInteger(updatedAt)) {
    return fail('bad_request', 'session.draft.updatedAt must be a non-negative integer')
  }
  const source = value['source']
  if (typeof source !== 'string' || !isDraftSource(source)) {
    return fail('bad_request', 'session.draft.source is not known')
  }
  return ok({
    text: text.value,
    caret: caret.value,
    images: images.value,
    ...(files.value !== undefined ? { files: files.value } : {}),
    ...(refs.value !== undefined ? { refs: refs.value } : {}),
    ...(contexts.value !== undefined ? { contexts: contexts.value } : {}),
    revision,
    updatedAt,
    source,
  })
}

function parseDraftText(value: unknown): Result<string> {
  if (!isBoundedString(value, MAX_DRAFT_TEXT_LENGTH)) {
    return fail('bad_request', `draft.text must be at most ${MAX_DRAFT_TEXT_LENGTH} characters`)
  }
  return ok(value)
}

function parseDraftCaret(value: unknown, textLength: number): Result<number> {
  if (!isNonNegativeInteger(value) || value > textLength) {
    return fail('bad_request', 'draft.caret must be an integer within the draft text')
  }
  return ok(value)
}

function parseDraftAttachmentTotal(
  images: readonly MobileDraftImageRef[],
  files: readonly MobileDraftFileRef[] | undefined,
): string | undefined {
  if (images.length + (files?.length ?? 0) > MAX_DRAFT_ATTACHMENTS) {
    return `draft attachments must contain at most ${MAX_DRAFT_ATTACHMENTS} entries`
  }
  return undefined
}

function parseDraftImages(value: unknown, field: string): Result<readonly MobileDraftImageRef[]> {
  if (!Array.isArray(value)) return fail('bad_request', `${field} must be an array`)
  if (value.length > MAX_DRAFT_IMAGES) {
    return fail('bad_request', `${field} must contain at most ${MAX_DRAFT_IMAGES} entries`)
  }
  const images: MobileDraftImageRef[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return fail('bad_request', `${field} entries must be objects`)
    const id = item['id']
    if (!isNonEmptyBoundedString(id, MAX_ATTACHMENT_ID_LENGTH)) {
      return fail('bad_request', `${field}.id must be 1–${MAX_ATTACHMENT_ID_LENGTH} characters`)
    }
    if (seen.has(id)) return fail('bad_request', `${field} must not contain duplicate ids`)
    seen.add(id)
    const source = item['source']
    if (typeof source !== 'string' || !isDraftSource(source)) {
      return fail('bad_request', `${field}.source is not known`)
    }
    const mimeType = item['mimeType']
    if (!isNonEmptyBoundedString(mimeType, MAX_ATTACHMENT_MIME_LENGTH)) {
      return fail(
        'bad_request',
        `${field}.mimeType must be 1–${MAX_ATTACHMENT_MIME_LENGTH} characters`,
      )
    }
    if (!isMobileImageMimeType(mimeType)) {
      return fail('bad_request', `${field}.mimeType is not a supported image type`)
    }
    const byteSize = item['byteSize']
    if (!isNonNegativeInteger(byteSize) || byteSize > MAX_IMAGE_ATTACHMENT_BYTES) {
      return fail('bad_request', `${field}.byteSize is out of range`)
    }
    const name = parseOptionalNonEmptyString(item['name'], MAX_DRAFT_NAME_LENGTH, `${field}.name`)
    if (!name.ok) return name
    images.push({
      id,
      source,
      mimeType,
      byteSize,
      ...(name.value !== undefined ? { name: name.value } : {}),
    })
  }
  return ok(images)
}

function parseDraftFiles(
  value: unknown,
  field: string,
): Result<readonly MobileDraftFileRef[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', `${field} must be an array`)
  if (value.length > MAX_DRAFT_FILES) {
    return fail('bad_request', `${field} must contain at most ${MAX_DRAFT_FILES} entries`)
  }
  const files: MobileDraftFileRef[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return fail('bad_request', `${field} entries must be objects`)
    const id = item['id']
    if (!isNonEmptyBoundedString(id, MAX_ATTACHMENT_ID_LENGTH)) {
      return fail('bad_request', `${field}.id must be 1–${MAX_ATTACHMENT_ID_LENGTH} characters`)
    }
    if (seen.has(id)) return fail('bad_request', `${field} must not contain duplicate ids`)
    seen.add(id)
    const name = item['name']
    if (!isNonEmptyBoundedString(name, MAX_DRAFT_NAME_LENGTH)) {
      return fail('bad_request', `${field}.name must be 1–${MAX_DRAFT_NAME_LENGTH} characters`)
    }
    const mimeType = parseOptionalString(
      item['mimeType'],
      MAX_ATTACHMENT_MIME_LENGTH,
      `${field}.mimeType`,
    )
    if (!mimeType.ok) return mimeType
    const byteSize = item['byteSize']
    if (!isNonNegativeInteger(byteSize) || byteSize > MAX_FILE_ATTACHMENT_BYTES) {
      return fail('bad_request', `${field}.byteSize is out of range`)
    }
    files.push({
      id,
      name,
      ...(mimeType.value !== undefined ? { mimeType: mimeType.value } : {}),
      byteSize,
    })
  }
  return ok(files)
}

function parseDraftRefs(
  value: unknown,
  textLength: number,
): Result<readonly MobileDraftRefSummary[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', 'session.draft.refs must be an array')
  if (value.length > MAX_DRAFT_REFS) {
    return fail('bad_request', `session.draft.refs must contain at most ${MAX_DRAFT_REFS} entries`)
  }
  const refs: MobileDraftRefSummary[] = []
  for (const item of value) {
    if (!isRecord(item)) return fail('bad_request', 'session.draft.refs entries must be objects')
    const id = item['id']
    if (!isNonEmptyBoundedString(id, MAX_ATTACHMENT_ID_LENGTH)) {
      return fail('bad_request', 'session.draft.refs.id must be 1–128 characters')
    }
    const kind = item['kind']
    if (!isNonEmptyBoundedString(kind, MAX_DRAFT_REF_KIND_LENGTH)) {
      return fail('bad_request', 'session.draft.refs.kind is out of range')
    }
    const label = item['label']
    if (!isNonEmptyBoundedString(label, MAX_DRAFT_REF_LABEL_LENGTH)) {
      return fail('bad_request', 'session.draft.refs.label is out of range')
    }
    const start = item['start']
    const end = item['end']
    if (
      !isNonNegativeInteger(start) ||
      !isNonNegativeInteger(end) ||
      start >= end ||
      end > textLength
    ) {
      return fail('bad_request', 'session.draft.refs range is out of bounds')
    }
    refs.push({ id, kind, label, start, end })
  }
  return ok(refs)
}

function parseDraftContexts(
  value: unknown,
): Result<readonly MobileDraftContextSummary[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', 'session.draft.contexts must be an array')
  if (value.length > MAX_DRAFT_CONTEXTS) {
    return fail(
      'bad_request',
      `session.draft.contexts must contain at most ${MAX_DRAFT_CONTEXTS} entries`,
    )
  }
  const contexts: MobileDraftContextSummary[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      return fail('bad_request', 'session.draft.contexts entries must be objects')
    }
    const relPath = item['relPath']
    if (!isNonEmptyBoundedString(relPath, MAX_DRAFT_CONTEXT_PATH_LENGTH)) {
      return fail('bad_request', 'session.draft.contexts.relPath is out of range')
    }
    const startLine = item['startLine']
    const endLine = item['endLine']
    if (!isNonNegativeInteger(startLine) || !isNonNegativeInteger(endLine) || startLine > endLine) {
      return fail('bad_request', 'session.draft.contexts line range is invalid')
    }
    const languageId = parseOptionalNonEmptyString(
      item['languageId'],
      MAX_DRAFT_CONTEXT_LANGUAGE_LENGTH,
      'session.draft.contexts.languageId',
    )
    if (!languageId.ok) return languageId
    contexts.push({
      relPath,
      startLine,
      endLine,
      ...(languageId.value !== undefined ? { languageId: languageId.value } : {}),
    })
  }
  return ok(contexts)
}

function isDraftSource(value: string): value is MobileDraftState['source'] {
  return (MOBILE_DRAFT_SOURCES as readonly string[]).includes(value)
}

function parsePushSubscription(value: unknown): Result<MobilePushSubscription> {
  if (!isRecord(value)) return fail('bad_request', 'push subscription must be an object')
  const endpoint = value['endpoint']
  if (!isNonEmptyBoundedString(endpoint, MAX_PUSH_ENDPOINT_LENGTH)) {
    return fail(
      'bad_request',
      `push subscription endpoint must be 1–${MAX_PUSH_ENDPOINT_LENGTH} characters`,
    )
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return fail('bad_request', 'push subscription endpoint must be a URL')
  }
  // Push services are HTTPS only; the gateway forwards to this URL, so anything
  // else would turn it into an SSRF gadget.
  if (url.protocol !== 'https:') {
    return fail('bad_request', 'push subscription endpoint must use https')
  }
  if (url.username !== '' || url.password !== '') {
    return fail('bad_request', 'push subscription endpoint must not carry credentials')
  }
  const keys = value['keys']
  if (!isRecord(keys)) return fail('bad_request', 'push subscription keys must be an object')
  const p256dh = keys['p256dh']
  const auth = keys['auth']
  if (!isNonEmptyBoundedString(p256dh, MAX_PUSH_KEY_LENGTH)) {
    return fail('bad_request', `push subscription keys.p256dh must be 1–${MAX_PUSH_KEY_LENGTH}`)
  }
  if (!isNonEmptyBoundedString(auth, MAX_PUSH_KEY_LENGTH)) {
    return fail('bad_request', `push subscription keys.auth must be 1–${MAX_PUSH_KEY_LENGTH}`)
  }
  return ok({ endpoint, keys: { p256dh, auth } })
}

function parseNotificationPrefs(value: unknown, field: string): Result<MobileNotificationPrefs> {
  if (!isRecord(value)) return fail('bad_request', `${field} must be an object`)
  const enabled = value['enabled']
  if (typeof enabled !== 'boolean') {
    return fail('bad_request', `${field}.enabled must be a boolean`)
  }
  const kinds = parseOptionalAttentionKinds(value['kinds'], `${field}.kinds`)
  if (!kinds.ok) return kinds
  const rawAlwaysNotify = value['alwaysNotify']
  if (rawAlwaysNotify !== undefined && typeof rawAlwaysNotify !== 'boolean') {
    return fail('bad_request', `${field}.alwaysNotify must be a boolean`)
  }
  return ok({
    enabled,
    ...(kinds.value !== undefined ? { kinds: kinds.value } : {}),
    alwaysNotify: rawAlwaysNotify === true,
  })
}

function parseOptionalAttentionKinds(
  value: unknown,
  field: string,
): Result<MobileAttentionKind[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', `${field} must be an array`)
  if (value.length > MOBILE_ATTENTION_KINDS.length) {
    return fail('bad_request', `${field} has too many entries`)
  }
  const kinds: MobileAttentionKind[] = []
  for (const entry of value) {
    if (!isAttentionKind(entry)) {
      return fail('bad_request', `${field} contains an unknown kind`)
    }
    if (!kinds.includes(entry)) kinds.push(entry)
  }
  return ok(kinds)
}

function parseNotificationFrame(frame: Record<string, unknown>): Result<NotificationFrame> {
  const id = frame['id']
  if (!isNonEmptyBoundedString(id, MAX_NOTIFICATION_ID_LENGTH)) {
    return fail('bad_request', `notification.id must be 1–${MAX_NOTIFICATION_ID_LENGTH}`)
  }
  const kind = frame['kind']
  if (!isAttentionKind(kind)) return fail('bad_request', 'notification.kind is unknown')
  const ref = parseSessionRef(frame['ref'])
  if (!ref.ok) return ref
  const title = frame['title']
  if (!isBoundedString(title, MAX_TITLE_LENGTH)) {
    return fail('bad_request', `notification.title must be at most ${MAX_TITLE_LENGTH}`)
  }
  const body = frame['body']
  if (!isBoundedString(body, MAX_NOTIFICATION_BODY_LENGTH)) {
    return fail('bad_request', `notification.body must be at most ${MAX_NOTIFICATION_BODY_LENGTH}`)
  }
  const at = frame['at']
  if (!isFiniteNumber(at)) return fail('bad_request', 'notification.at must be a finite number')
  return ok({ type: 'notification', id, kind, ref: ref.value, title, body, at })
}

function parseCommandFrame(frame: Record<string, unknown>): Result<CommandFrame> {
  const requestId = frame.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail('bad_request', `command.requestId must be 1–${MAX_REQUEST_ID_LENGTH} characters`)
  }
  const kind = frame.kind
  if (!isNonEmptyBoundedString(kind, MAX_ID_LENGTH)) {
    return fail('bad_request', `command.kind must be 1–${MAX_ID_LENGTH} characters`)
  }
  const idempotencyKey = parseOptionalString(
    frame.idempotencyKey,
    MAX_REQUEST_ID_LENGTH,
    'command.idempotencyKey',
  )
  if (!idempotencyKey.ok) return idempotencyKey
  const payload = frame.payload
  const parsed = parseCommandPayload(kind, payload)
  if (!parsed.ok) return parsed
  return ok({
    type: 'command',
    requestId,
    kind,
    payload: parsed.value,
    ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
  })
}

/**
 * Unknown kinds pass their payload through untouched so a newer client gets
 * `not_supported` from the command handler rather than a parse error.
 */
function parseCommandPayload(kind: string, value: unknown): Result<unknown> {
  switch (kind) {
    case 'getToolCallDetail':
      return parseGetToolCallDetailPayload(value)
    case 'sendPrompt':
      return parseSendPromptPayload(value)
    case 'cancelTurn':
      return parseRefOnlyPayload(value, 'cancelTurn')
    case 'resolvePermission':
      return parseResolvePermissionPayload(value)
    case 'cancelPermission':
      return parseRequestRefPayload(value, 'cancelPermission')
    case 'resolveElicitation':
      return parseResolveElicitationPayload(value)
    case 'setConfigOption':
      return parseSetConfigOptionPayload(value)
    case 'pauseAutoResolve':
    case 'resumeAutoResolve':
      return parseRequestRefPayload(value, kind)
    case 'newSession':
      return parseNewSessionPayload(value)
    case 'renameSession':
      return parseRenameSessionPayload(value)
    case 'closeSession':
    case 'deleteSession':
      return parseRefOnlyPayload(value, kind)
    case 'forkSession':
      return parseForkSessionPayload(value)
    case 'previewRewind':
      return parseRewindPayload(value, 'previewRewind', false)
    case 'rewindSession':
      return parseRewindPayload(value, 'rewindSession', true)
    case 'createSideTask':
      return parseCreateSideTaskPayload(value)
    case 'listSideTasks':
      return parseRefOnlyPayload(value, 'listSideTasks')
    case 'openSideTask':
      return parseSideTaskIdPayload(value, 'openSideTask')
    case 'deleteSideTask':
      return parseSideTaskIdPayload(value, 'deleteSideTask')
    case 'listWorkspaces':
    case 'listAgents':
    case 'listSessionHistory':
      return parseEmptyPayload(value, kind)
    case 'openSession':
      return parseOpenSessionPayload(value)
    case 'previewDelivery':
      return parseRefOnlyPayload(value, 'previewDelivery')
    case 'startDelivery':
      return parseStartDeliveryPayload(value)
    case 'getDelivery':
    case 'confirmDeliveryPush':
    case 'retryDelivery':
    case 'undoDelivery':
    case 'openDeliveryMainWorktree':
      return parseDeliveryCommandPayload(value, kind)
    default:
      return ok(value)
  }
}

function parseDeliveryCommandPayload(
  value: unknown,
  kind: string,
): Result<{ ref: MobileSessionRef; deliveryId: string }> {
  if (!isRecord(value)) return fail('bad_request', `${kind}.payload must be an object`)
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const deliveryId = value.deliveryId
  if (!isNonEmptyBoundedString(deliveryId, MAX_ID_LENGTH)) {
    return fail('bad_request', `${kind}.deliveryId must be 1–${MAX_ID_LENGTH} characters`)
  }
  return ok({ ref: ref.value, deliveryId })
}

function parseDeliveryExpectation(value: unknown): Result<MobileDeliveryExpectation> {
  if (!isRecord(value)) {
    return fail('bad_request', 'startDelivery.expectation must be an object')
  }
  const fields = [
    'mainHead',
    'mainBranch',
    'targetBranch',
    'remote',
    'remoteBranch',
    'upstreamRef',
    'upstreamHead',
    'sourceHead',
    'baseSha',
  ] as const
  const parsed: Record<(typeof fields)[number], string> = {
    mainHead: '',
    mainBranch: '',
    targetBranch: '',
    remote: '',
    remoteBranch: '',
    upstreamRef: '',
    upstreamHead: '',
    sourceHead: '',
    baseSha: '',
  }
  for (const field of fields) {
    const raw = value[field]
    if (!isNonEmptyBoundedString(raw, MAX_TEXT_LENGTH)) {
      return fail(
        'bad_request',
        `startDelivery.expectation.${field} must be 1–${MAX_TEXT_LENGTH} characters`,
      )
    }
    parsed[field] = raw
  }
  const rawCommits = value.commits
  if (!Array.isArray(rawCommits)) {
    return fail('bad_request', 'startDelivery.expectation.commits must be an array')
  }
  if (rawCommits.length > MAX_DELIVERY_COMMITS) {
    return fail(
      'bad_request',
      `startDelivery.expectation.commits must contain at most ${MAX_DELIVERY_COMMITS} entries`,
    )
  }
  const commits: string[] = []
  for (const sha of rawCommits) {
    if (!isNonEmptyBoundedString(sha, MAX_ID_LENGTH)) {
      return fail('bad_request', 'startDelivery.expectation.commits entries must be strings')
    }
    commits.push(sha)
  }
  return ok({ ...parsed, commits })
}

function parseStartDeliveryPayload(
  value: unknown,
): Result<{ ref: MobileSessionRef; expectation: MobileDeliveryExpectation }> {
  if (!isRecord(value)) return fail('bad_request', 'startDelivery.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const expectation = parseDeliveryExpectation(value.expectation)
  if (!expectation.ok) return expectation
  return ok({ ref: ref.value, expectation: expectation.value })
}

function parseOpenSessionPayload(value: unknown): Result<{
  durableId: string
  windowId?: number
  folder?: string
  authority?: string
}> {
  if (!isRecord(value)) return fail('bad_request', 'openSession.payload must be an object')
  const durableId = value.durableId
  if (!isNonEmptyBoundedString(durableId, MAX_ID_LENGTH)) {
    return fail('bad_request', `openSession.durableId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const folder = parseOptionalNonEmptyString(value.folder, MAX_TEXT_LENGTH, 'openSession.folder')
  if (!folder.ok) return folder
  const authority = parseOptionalNonEmptyString(
    value.authority,
    MAX_WORKSPACE_NAME_LENGTH,
    'openSession.authority',
  )
  if (!authority.ok) return authority
  const windowId = value.windowId
  if (windowId !== undefined && !isNonNegativeInteger(windowId)) {
    return fail('bad_request', 'openSession.windowId must be a non-negative integer')
  }
  return ok({
    durableId,
    ...(windowId !== undefined ? { windowId } : {}),
    ...(folder.value !== undefined ? { folder: folder.value } : {}),
    ...(authority.value !== undefined ? { authority: authority.value } : {}),
  })
}

function parseRefOnlyPayload(value: unknown, kind: string): Result<{ ref: MobileSessionRef }> {
  if (!isRecord(value)) return fail('bad_request', `${kind}.payload must be an object`)
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  return ok({ ref: ref.value })
}

function parseRequestRefPayload(
  value: unknown,
  kind: string,
): Result<{ ref: MobileSessionRef; requestId: string }> {
  if (!isRecord(value)) return fail('bad_request', `${kind}.payload must be an object`)
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const requestId = value.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail('bad_request', `${kind}.requestId must be 1–${MAX_REQUEST_ID_LENGTH} characters`)
  }
  return ok({ ref: ref.value, requestId })
}

function parseForkSessionPayload(
  value: unknown,
): Result<{ ref: MobileSessionRef; messageId?: string }> {
  if (!isRecord(value)) return fail('bad_request', 'forkSession.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const messageId = parseOptionalNonEmptyString(
    value.messageId,
    MAX_ID_LENGTH,
    'forkSession.messageId',
  )
  if (!messageId.ok) return messageId
  return ok({
    ref: ref.value,
    ...(messageId.value !== undefined ? { messageId: messageId.value } : {}),
  })
}

function parseRewindPayload(
  value: unknown,
  kind: string,
  withRewindFiles: boolean,
): Result<{ ref: MobileSessionRef; messageId: string; rewindFiles?: boolean }> {
  if (!isRecord(value)) return fail('bad_request', `${kind}.payload must be an object`)
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const messageId = value.messageId
  if (!isNonEmptyBoundedString(messageId, MAX_ID_LENGTH)) {
    return fail('bad_request', `${kind}.messageId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const rewindFiles = parseOptionalBoolean(value.rewindFiles, `${kind}.rewindFiles`)
  if (!rewindFiles.ok) return rewindFiles
  return ok({
    ref: ref.value,
    messageId,
    ...(withRewindFiles && rewindFiles.value !== undefined
      ? { rewindFiles: rewindFiles.value }
      : {}),
  })
}

function parseCreateSideTaskPayload(
  value: unknown,
): Result<{ ref: MobileSessionRef; quote?: string }> {
  if (!isRecord(value)) return fail('bad_request', 'createSideTask.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const quote = parseOptionalString(value.quote, MAX_SIDE_TASK_QUOTE_LENGTH, 'createSideTask.quote')
  if (!quote.ok) return quote
  return ok({
    ref: ref.value,
    ...(quote.value !== undefined ? { quote: quote.value } : {}),
  })
}

function parseSideTaskIdPayload(
  value: unknown,
  kind: string,
): Result<{ ref: MobileSessionRef; sideTaskId: string }> {
  if (!isRecord(value)) return fail('bad_request', `${kind}.payload must be an object`)
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const sideTaskId = value.sideTaskId
  if (!isNonEmptyBoundedString(sideTaskId, MAX_ID_LENGTH)) {
    return fail('bad_request', `${kind}.sideTaskId must be 1–${MAX_ID_LENGTH} characters`)
  }
  return ok({ ref: ref.value, sideTaskId })
}

function parseEmptyPayload(value: unknown, kind: string): Result<Record<string, never>> {
  if (value !== undefined && !isRecord(value)) {
    return fail('bad_request', `${kind}.payload must be an object`)
  }
  return ok({})
}

function parseSendPromptPayload(value: unknown): Result<{
  ref: MobileSessionRef
  text: string
  attachmentIds?: readonly string[]
  draftImageIds?: readonly string[]
  draftFileIds?: readonly string[]
}> {
  if (!isRecord(value)) return fail('bad_request', 'sendPrompt.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const text = value.text
  if (!isBoundedString(text, MAX_PROMPT_LENGTH)) {
    return fail('bad_request', `sendPrompt.text must be at most ${MAX_PROMPT_LENGTH} characters`)
  }
  const attachmentIds = parsePromptIdList(
    value.attachmentIds,
    MAX_ATTACHMENTS_PER_PROMPT,
    'sendPrompt.attachmentIds',
  )
  if (!attachmentIds.ok) return attachmentIds
  const draftImageIds = parsePromptIdList(
    value.draftImageIds,
    MAX_DRAFT_IMAGES,
    'sendPrompt.draftImageIds',
  )
  if (!draftImageIds.ok) return draftImageIds
  const draftFileIds = parsePromptIdList(
    value.draftFileIds,
    MAX_DRAFT_FILES,
    'sendPrompt.draftFileIds',
  )
  if (!draftFileIds.ok) return draftFileIds
  const attachmentCount = attachmentIds.value?.length ?? 0
  const draftImageCount = draftImageIds.value?.length ?? 0
  const draftFileCount = draftFileIds.value?.length ?? 0
  if (attachmentCount + draftImageCount + draftFileCount === 0 && text.trim() === '') {
    return fail('bad_request', 'sendPrompt requires text or at least one attachment')
  }
  return ok({
    ref: ref.value,
    text,
    ...(attachmentIds.value !== undefined ? { attachmentIds: attachmentIds.value } : {}),
    ...(draftImageIds.value !== undefined ? { draftImageIds: draftImageIds.value } : {}),
    ...(draftFileIds.value !== undefined ? { draftFileIds: draftFileIds.value } : {}),
  })
}

function parsePromptIdList(
  value: unknown,
  maxEntries: number,
  field: string,
): Result<readonly string[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', `${field} must be an array`)
  if (value.length > maxEntries) {
    return fail('bad_request', `${field} must contain at most ${maxEntries} entries`)
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isNonEmptyBoundedString(item, MAX_ATTACHMENT_ID_LENGTH)) {
      return fail(
        'bad_request',
        `${field} entries must be 1–${MAX_ATTACHMENT_ID_LENGTH} characters`,
      )
    }
    if (seen.has(item)) return fail('bad_request', `${field} must not contain duplicates`)
    seen.add(item)
    ids.push(item)
  }
  return ok(ids.length > 0 ? ids : undefined)
}

function parseResolvePermissionPayload(value: unknown): Result<{
  ref: MobileSessionRef
  requestId: string
  optionId: string
  feedback?: string
}> {
  if (!isRecord(value)) return fail('bad_request', 'resolvePermission.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const requestId = value.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail(
      'bad_request',
      `resolvePermission.requestId must be 1–${MAX_REQUEST_ID_LENGTH} characters`,
    )
  }
  const optionId = value.optionId
  if (!isNonEmptyBoundedString(optionId, MAX_ID_LENGTH)) {
    return fail('bad_request', `resolvePermission.optionId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const feedback = parseOptionalString(
    value.feedback,
    MAX_FEEDBACK_LENGTH,
    'resolvePermission.feedback',
  )
  if (!feedback.ok) return feedback
  return ok({
    ref: ref.value,
    requestId,
    optionId,
    ...(feedback.value !== undefined ? { feedback: feedback.value } : {}),
  })
}

function parseResolveElicitationPayload(value: unknown): Result<{
  ref: MobileSessionRef
  requestId: string
  action: MobileElicitationAction
  content?: Record<string, MobileElicitationContentValue>
}> {
  if (!isRecord(value)) {
    return fail('bad_request', 'resolveElicitation.payload must be an object')
  }
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const requestId = value.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail(
      'bad_request',
      `resolveElicitation.requestId must be 1–${MAX_REQUEST_ID_LENGTH} characters`,
    )
  }
  const action = value.action
  if (typeof action !== 'string' || !isElicitationAction(action)) {
    return fail('bad_request', 'resolveElicitation.action must be accept, decline, or cancel')
  }
  const content = parseElicitationContent(value.content)
  if (!content.ok) return content
  return ok({
    ref: ref.value,
    requestId,
    action,
    ...(content.value !== undefined ? { content: content.value } : {}),
  })
}

function parseElicitationContent(
  value: unknown,
): Result<Record<string, MobileElicitationContentValue> | undefined> {
  if (value === undefined) return ok(undefined)
  if (!isRecord(value)) return fail('bad_request', 'resolveElicitation.content must be an object')
  const keys = Object.keys(value)
  if (keys.length > MAX_ELICITATION_CONTENT_KEYS) {
    return fail(
      'bad_request',
      `resolveElicitation.content must have at most ${MAX_ELICITATION_CONTENT_KEYS} keys`,
    )
  }
  const content: Record<string, MobileElicitationContentValue> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (isValidElicitationContentValue(raw)) {
      content[key] = raw
      continue
    }
    return fail('bad_request', `resolveElicitation.content.${key} has an unsupported value`)
  }
  return ok(content)
}

function isValidElicitationContentValue(value: unknown): value is MobileElicitationContentValue {
  if (typeof value === 'string') return value.length <= MAX_TEXT_LENGTH
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  return (
    Array.isArray(value) &&
    value.length <= MAX_ELICITATION_CONTENT_KEYS &&
    value.every((entry) => typeof entry === 'string' && entry.length <= MAX_TEXT_LENGTH)
  )
}

function parseSetConfigOptionPayload(value: unknown): Result<{
  ref: MobileSessionRef
  configId: string
  value: string | boolean
}> {
  if (!isRecord(value)) return fail('bad_request', 'setConfigOption.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const configId = value.configId
  if (!isNonEmptyBoundedString(configId, MAX_ID_LENGTH)) {
    return fail('bad_request', `setConfigOption.configId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const configValue = value.value
  if (typeof configValue === 'boolean') {
    return ok({ ref: ref.value, configId, value: configValue })
  }
  if (!isNonEmptyBoundedString(configValue, MAX_TITLE_LENGTH)) {
    return fail('bad_request', 'setConfigOption.value must be a boolean or a short string')
  }
  return ok({ ref: ref.value, configId, value: configValue })
}

function parseNewSessionPayload(value: unknown): Result<{
  agentId: string
  workspace: { folder: string; authority?: string }
  initialPrompt?: string
}> {
  if (!isRecord(value)) return fail('bad_request', 'newSession.payload must be an object')
  const agentId = value.agentId
  if (!isNonEmptyBoundedString(agentId, MAX_ID_LENGTH)) {
    return fail('bad_request', `newSession.agentId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const workspace = value.workspace
  if (!isRecord(workspace)) {
    return fail('bad_request', 'newSession.workspace must be an object')
  }
  const folder = workspace.folder
  if (!isNonEmptyBoundedString(folder, MAX_TEXT_LENGTH)) {
    return fail('bad_request', 'newSession.workspace.folder must be a URI string')
  }
  const authority = parseOptionalString(
    workspace.authority,
    MAX_WORKSPACE_NAME_LENGTH,
    'newSession.workspace.authority',
  )
  if (!authority.ok) return authority
  const initialPrompt = parseOptionalString(
    value.initialPrompt,
    MAX_PROMPT_LENGTH,
    'newSession.initialPrompt',
  )
  if (!initialPrompt.ok) return initialPrompt
  return ok({
    agentId,
    workspace: {
      folder,
      ...(authority.value !== undefined ? { authority: authority.value } : {}),
    },
    ...(initialPrompt.value !== undefined ? { initialPrompt: initialPrompt.value } : {}),
  })
}

function parseRenameSessionPayload(value: unknown): Result<{
  ref: MobileSessionRef
  title: string
}> {
  if (!isRecord(value)) return fail('bad_request', 'renameSession.payload must be an object')
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const title = value.title
  if (!isNonEmptyBoundedString(title, MAX_TITLE_LENGTH)) {
    return fail('bad_request', `renameSession.title must be 1–${MAX_TITLE_LENGTH} characters`)
  }
  return ok({ ref: ref.value, title })
}

function parseGetToolCallDetailPayload(
  value: unknown,
): Result<{ ref: MobileSessionRef; toolCallId: string }> {
  if (!isRecord(value)) {
    return fail('bad_request', 'getToolCallDetail.payload must be an object')
  }
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const toolCallId = value.toolCallId
  if (!isNonEmptyBoundedString(toolCallId, MAX_ID_LENGTH)) {
    return fail('bad_request', 'getToolCallDetail.toolCallId must be 1–128 characters')
  }
  return ok({ ref: ref.value, toolCallId })
}

function parseHelloOkFrame(frame: Record<string, unknown>): Result<HelloOkFrame> {
  const protocolVersion = frame.protocolVersion
  if (!isNonNegativeInteger(protocolVersion)) {
    return fail('bad_request', 'hello_ok.protocolVersion must be a non-negative integer')
  }
  if (protocolVersion !== MOBILE_PROTOCOL_VERSION) {
    return fail('protocol_mismatch', `unsupported protocol version: ${protocolVersion}`)
  }
  const serverVersion = frame.serverVersion
  if (!isBoundedString(serverVersion, MAX_SERVER_VERSION_LENGTH)) {
    return fail(
      'bad_request',
      `hello_ok.serverVersion must be at most ${MAX_SERVER_VERSION_LENGTH}`,
    )
  }
  const deviceId = frame.deviceId
  if (!isNonEmptyBoundedString(deviceId, MAX_ID_LENGTH)) {
    return fail('bad_request', `hello_ok.deviceId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const trusted = frame.trusted
  if (typeof trusted !== 'boolean') {
    return fail('bad_request', 'hello_ok.trusted must be a boolean')
  }
  const serverTime = frame.serverTime
  if (!isFiniteNumber(serverTime)) {
    return fail('bad_request', 'hello_ok.serverTime must be a finite number')
  }
  const capabilities = parseCapabilities(frame.capabilities)
  if (!capabilities.ok) return capabilities
  const vapidPublicKey = parseOptionalString(
    frame.vapidPublicKey,
    MAX_PUSH_KEY_LENGTH,
    'hello_ok.vapidPublicKey',
  )
  if (!vapidPublicKey.ok) return vapidPublicKey
  return ok({
    type: 'hello_ok',
    protocolVersion,
    serverVersion,
    deviceId,
    trusted,
    serverTime,
    capabilities: capabilities.value,
    ...(vapidPublicKey.value !== undefined ? { vapidPublicKey: vapidPublicKey.value } : {}),
  })
}

function parseDeviceTrustChangedFrame(
  frame: Record<string, unknown>,
): Result<DeviceTrustChangedFrame> {
  const trusted = frame.trusted
  if (typeof trusted !== 'boolean') {
    return fail('bad_request', 'device_trust_changed.trusted must be a boolean')
  }
  return ok({ type: 'device_trust_changed', trusted })
}

function parsePongFrame(frame: Record<string, unknown>): Result<PongFrame> {
  const t = frame.t
  if (!isFiniteNumber(t)) return fail('bad_request', 'pong.t must be a finite number')
  return ok({ type: 'pong', t })
}

function parseInboxSnapshotFrame(frame: Record<string, unknown>): Result<InboxSnapshotFrame> {
  const seq = frame.seq
  if (!isNonNegativeInteger(seq)) {
    return fail('bad_request', 'inbox_snapshot.seq must be a non-negative integer')
  }
  const rawSessions = frame.sessions
  if (!Array.isArray(rawSessions)) {
    return fail('bad_request', 'inbox_snapshot.sessions must be an array')
  }
  const sessions: MobileSessionSummary[] = []
  for (const raw of rawSessions) {
    const session = parseSessionSummary(raw)
    if (!session.ok) return session
    sessions.push(session.value)
  }
  return ok({ type: 'inbox_snapshot', seq, sessions })
}

function parseInboxDeltaFrame(frame: Record<string, unknown>): Result<InboxDeltaFrame> {
  const seq = frame.seq
  if (!isNonNegativeInteger(seq)) {
    return fail('bad_request', 'inbox_delta.seq must be a non-negative integer')
  }
  const rawUpserts = frame.upserts
  if (!Array.isArray(rawUpserts)) {
    return fail('bad_request', 'inbox_delta.upserts must be an array')
  }
  const upserts: MobileSessionSummary[] = []
  for (const raw of rawUpserts) {
    const session = parseSessionSummary(raw)
    if (!session.ok) return session
    upserts.push(session.value)
  }
  const rawRemoves = frame.removes
  if (!Array.isArray(rawRemoves)) {
    return fail('bad_request', 'inbox_delta.removes must be an array')
  }
  const removes: MobileSessionRef[] = []
  for (const raw of rawRemoves) {
    const ref = parseSessionRef(raw)
    if (!ref.ok) return ref
    removes.push(ref.value)
  }
  return ok({ type: 'inbox_delta', seq, upserts, removes })
}

function parseSessionSnapshotFrame(frame: Record<string, unknown>): Result<SessionSnapshotFrame> {
  const seq = frame.seq
  if (!isNonNegativeInteger(seq)) {
    return fail('bad_request', 'session_snapshot.seq must be a non-negative integer')
  }
  const snapshot = parseSessionSnapshot(frame.session)
  if (!snapshot.ok) return snapshot
  return ok({ type: 'session_snapshot', seq, session: snapshot.value })
}

function parseSessionSnapshot(value: unknown): Result<MobileSessionSnapshot> {
  if (!isRecord(value)) {
    return fail('bad_request', 'session_snapshot.session must be an object')
  }
  const seq = value.seq
  if (!isNonNegativeInteger(seq)) {
    return fail('bad_request', 'session.seq must be a non-negative integer')
  }
  const summary = parseSessionSummary(value.summary)
  if (!summary.ok) return summary
  const timeline = parseTimeline(value.timeline)
  if (!timeline.ok) return timeline
  const plan = parsePlan(value.plan)
  if (!plan.ok) return plan
  const configOptions = parseConfigOptions(value.configOptions)
  if (!configOptions.ok) return configOptions
  const availableCommands = parseAvailableCommands(value.availableCommands)
  if (!availableCommands.ok) return availableCommands
  const isReplayingHistory = value.isReplayingHistory
  if (typeof isReplayingHistory !== 'boolean') {
    return fail('bad_request', 'session.isReplayingHistory must be a boolean')
  }
  const usage = parseOptional(value.usage, parseUsage)
  if (!usage.ok) return usage
  const pendingPermission = parseOptional(value.pendingPermission, parsePendingPermission)
  if (!pendingPermission.ok) return pendingPermission
  const pendingElicitation = parseOptional(value.pendingElicitation, parsePendingElicitation)
  if (!pendingElicitation.ok) return pendingElicitation
  const draft = parseOptional(value.draft, parseDraftState)
  if (!draft.ok) return draft
  const truncated = value.truncated
  if (truncated !== undefined && typeof truncated !== 'boolean') {
    return fail('bad_request', 'session.truncated must be a boolean')
  }
  return ok({
    seq,
    summary: summary.value,
    timeline: timeline.value,
    plan: plan.value,
    configOptions: configOptions.value,
    availableCommands: availableCommands.value,
    isReplayingHistory,
    ...(usage.value !== undefined ? { usage: usage.value } : {}),
    ...(pendingPermission.value !== undefined
      ? { pendingPermission: pendingPermission.value }
      : {}),
    ...(pendingElicitation.value !== undefined
      ? { pendingElicitation: pendingElicitation.value }
      : {}),
    ...(draft.value !== undefined ? { draft: draft.value } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  })
}

function parseSessionSummary(value: unknown): Result<MobileSessionSummary> {
  if (!isRecord(value)) {
    return fail('bad_request', 'session summary entries must be objects')
  }
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const agentId = value.agentId
  if (!isNonEmptyBoundedString(agentId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.agentId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const agentName = parseOptionalString(value.agentName, MAX_TITLE_LENGTH, 'session.agentName')
  if (!agentName.ok) return agentName
  const title = value.title
  if (!isBoundedString(title, MAX_TITLE_LENGTH)) {
    return fail('bad_request', `session.title must be at most ${MAX_TITLE_LENGTH} characters`)
  }
  const status = value.status
  if (!isBoundedString(status, MAX_STATUS_LENGTH)) {
    return fail('bad_request', `session.status must be at most ${MAX_STATUS_LENGTH} characters`)
  }
  const displayStatus = value.displayStatus
  if (!isBoundedString(displayStatus, MAX_STATUS_LENGTH)) {
    return fail(
      'bad_request',
      `session.displayStatus must be at most ${MAX_STATUS_LENGTH} characters`,
    )
  }
  const bucket = value.bucket
  if (typeof bucket !== 'string' || !isMobileSessionBucket(bucket)) {
    return fail('bad_request', 'session.bucket is not a known bucket')
  }
  const workspaceName = value.workspaceName
  if (!isBoundedString(workspaceName, MAX_WORKSPACE_NAME_LENGTH)) {
    return fail(
      'bad_request',
      `session.workspaceName must be at most ${MAX_WORKSPACE_NAME_LENGTH} characters`,
    )
  }
  const cwd = parseOptionalString(value.cwd, MAX_WORKSPACE_NAME_LENGTH, 'session.cwd')
  if (!cwd.ok) return cwd
  const authority = parseOptionalString(
    value.authority,
    MAX_WORKSPACE_NAME_LENGTH,
    'session.authority',
  )
  if (!authority.ok) return authority
  const readOnly = value.readOnly
  if (typeof readOnly !== 'boolean') {
    return fail('bad_request', 'session.readOnly must be a boolean')
  }
  const hasPendingPermission = value.hasPendingPermission
  if (typeof hasPendingPermission !== 'boolean') {
    return fail('bad_request', 'session.hasPendingPermission must be a boolean')
  }
  const hasPendingElicitation = value.hasPendingElicitation
  if (typeof hasPendingElicitation !== 'boolean') {
    return fail('bad_request', 'session.hasPendingElicitation must be a boolean')
  }
  const backgroundTaskCount = value.backgroundTaskCount
  if (!isNonNegativeInteger(backgroundTaskCount)) {
    return fail('bad_request', 'session.backgroundTaskCount must be a non-negative integer')
  }
  const imageSupported = parseOptionalBoolean(value.imageSupported, 'session.imageSupported')
  if (!imageSupported.ok) return imageSupported
  const forkSupported = parseOptionalBoolean(value.forkSupported, 'session.forkSupported')
  if (!forkSupported.ok) return forkSupported
  const rewindSupported = parseOptionalBoolean(value.rewindSupported, 'session.rewindSupported')
  if (!rewindSupported.ok) return rewindSupported
  const sideTaskOf = parseOptionalNonEmptyString(
    value.sideTaskOf,
    MAX_ID_LENGTH,
    'session.sideTaskOf',
  )
  if (!sideTaskOf.ok) return sideTaskOf
  const sideTaskChildCount = parseOptionalNonNegativeInteger(
    value.sideTaskChildCount,
    'session.sideTaskChildCount',
  )
  if (!sideTaskChildCount.ok) return sideTaskChildCount
  const delivery = parseOptional(value.delivery, parseDeliverySummary)
  if (!delivery.ok) return delivery
  const deliveryAvailable = parseOptionalBoolean(
    value.deliveryAvailable,
    'session.deliveryAvailable',
  )
  if (!deliveryAvailable.ok) return deliveryAvailable
  const updatedAt = value.updatedAt
  if (!isFiniteNumber(updatedAt)) {
    return fail('bad_request', 'session.updatedAt must be a finite number')
  }
  return ok({
    ref: ref.value,
    agentId,
    ...(agentName.value !== undefined ? { agentName: agentName.value } : {}),
    title,
    status,
    displayStatus,
    bucket,
    workspaceName,
    ...(cwd.value !== undefined ? { cwd: cwd.value } : {}),
    ...(authority.value !== undefined ? { authority: authority.value } : {}),
    readOnly,
    hasPendingPermission,
    hasPendingElicitation,
    backgroundTaskCount,
    ...(imageSupported.value !== undefined ? { imageSupported: imageSupported.value } : {}),
    ...(forkSupported.value !== undefined ? { forkSupported: forkSupported.value } : {}),
    ...(rewindSupported.value !== undefined ? { rewindSupported: rewindSupported.value } : {}),
    ...(sideTaskOf.value !== undefined ? { sideTaskOf: sideTaskOf.value } : {}),
    ...(sideTaskChildCount.value !== undefined
      ? { sideTaskChildCount: sideTaskChildCount.value }
      : {}),
    ...(delivery.value !== undefined ? { delivery: delivery.value } : {}),
    ...(deliveryAvailable.value !== undefined
      ? { deliveryAvailable: deliveryAvailable.value }
      : {}),
    updatedAt,
  })
}

function parseDeliverySummary(value: unknown): Result<MobileDeliverySummary> {
  if (!isRecord(value)) return fail('bad_request', 'session.delivery must be an object')
  const deliveryId = value.deliveryId
  if (!isNonEmptyBoundedString(deliveryId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.delivery.deliveryId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const phase = value.phase
  if (typeof phase !== 'string' || !isDeliveryPhase(phase)) {
    return fail('bad_request', 'session.delivery.phase is not known')
  }
  const commitCount = value.commitCount
  if (!isNonNegativeInteger(commitCount)) {
    return fail('bad_request', 'session.delivery.commitCount must be a non-negative integer')
  }
  const dirtySource = value.dirtySource
  if (typeof dirtySource !== 'boolean') {
    return fail('bad_request', 'session.delivery.dirtySource must be a boolean')
  }
  const mainBranch = value.mainBranch
  if (!isNonEmptyBoundedString(mainBranch, MAX_WORKSPACE_NAME_LENGTH)) {
    return fail(
      'bad_request',
      `session.delivery.mainBranch must be 1–${MAX_WORKSPACE_NAME_LENGTH} characters`,
    )
  }
  const updatedAt = value.updatedAt
  if (!isFiniteNumber(updatedAt)) {
    return fail('bad_request', 'session.delivery.updatedAt must be a finite number')
  }
  const error = parseOptional(value.error, parseDeliveryError)
  if (!error.ok) return error
  const canConfirmPush = parseOptionalBoolean(
    value.canConfirmPush,
    'session.delivery.canConfirmPush',
  )
  if (!canConfirmPush.ok) return canConfirmPush
  const canRetry = parseOptionalBoolean(value.canRetry, 'session.delivery.canRetry')
  if (!canRetry.ok) return canRetry
  const canUndo = parseOptionalBoolean(value.canUndo, 'session.delivery.canUndo')
  if (!canUndo.ok) return canUndo
  const sync = parseDeliverySyncSummary(value.sync)
  if (!sync.ok) return sync
  return ok({
    deliveryId,
    phase,
    commitCount,
    dirtySource,
    mainBranch,
    updatedAt,
    ...(error.value !== undefined ? { error: error.value } : {}),
    canConfirmPush: canConfirmPush.value === true,
    canRetry: canRetry.value === true,
    canUndo: canUndo.value === true,
    sync: sync.value,
  })
}

function parseDeliveryError(value: unknown): Result<MobileDeliveryError> {
  if (!isRecord(value)) return fail('bad_request', 'delivery.error must be an object')
  const code = value.code
  if (!isNonEmptyBoundedString(code, MAX_STATUS_LENGTH)) {
    return fail('bad_request', 'delivery.error.code must be a short string')
  }
  const message = value.message
  if (!isNonEmptyBoundedString(message, MAX_DELIVERY_ERROR_LENGTH)) {
    return fail('bad_request', 'delivery.error.message is missing or too long')
  }
  const detail = parseOptionalString(
    value.detail,
    MAX_DELIVERY_DETAIL_LENGTH,
    'delivery.error.detail',
  )
  if (!detail.ok) return detail
  return ok({
    code,
    message,
    ...(detail.value !== undefined ? { detail: detail.value } : {}),
  })
}

function parseDeliverySyncSummary(value: unknown): Result<MobileDeliverySyncSummary> {
  if (!isRecord(value)) return fail('bad_request', 'delivery.sync must be an object')
  const counters = ['synced', 'upToDate', 'skipped', 'failed'] as const
  const parsed: Record<(typeof counters)[number], number> = {
    synced: 0,
    upToDate: 0,
    skipped: 0,
    failed: 0,
  }
  for (const counter of counters) {
    const raw = value[counter]
    if (!isNonNegativeInteger(raw)) {
      return fail('bad_request', `delivery.sync.${counter} must be a non-negative integer`)
    }
    parsed[counter] = raw
  }
  return ok(parsed)
}

function isDeliveryPhase(value: string): value is MobileDeliveryPhase {
  return (MOBILE_DELIVERY_PHASES as readonly string[]).includes(value)
}

function parseSessionRef(value: unknown): Result<MobileSessionRef> {
  if (!isRecord(value)) return fail('bad_request', 'session.ref must be an object')
  const windowId = value.windowId
  if (!isNonNegativeInteger(windowId)) {
    return fail('bad_request', 'session.ref.windowId must be a non-negative integer')
  }
  const localId = value.localId
  if (!isNonEmptyBoundedString(localId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.ref.localId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const durableId = value.durableId
  if (durableId === undefined) return ok({ windowId, localId })
  if (!isNonEmptyBoundedString(durableId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.ref.durableId must be 1–${MAX_ID_LENGTH} characters`)
  }
  return ok({ windowId, localId, durableId })
}

function parseAttachments(
  value: unknown,
  field: string,
): Result<readonly MobileMessageAttachment[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', `${field} must be an array`)
  if (value.length > MAX_ATTACHMENTS_PER_PROMPT) {
    return fail(
      'bad_request',
      `${field} must contain at most ${MAX_ATTACHMENTS_PER_PROMPT} entries`,
    )
  }
  const attachments: MobileMessageAttachment[] = []
  for (const item of value) {
    if (!isRecord(item)) return fail('bad_request', `${field} entries must be objects`)
    const id = item.id
    if (!isNonEmptyBoundedString(id, MAX_ATTACHMENT_ID_LENGTH)) {
      return fail('bad_request', `${field}.id must be 1–${MAX_ATTACHMENT_ID_LENGTH} characters`)
    }
    const kind = item.kind
    if (!isMobileAttachmentKind(kind)) {
      return fail('bad_request', `${field}.kind is not known`)
    }
    const name = item.name
    if (!isNonEmptyBoundedString(name, MAX_ATTACHMENT_NAME_LENGTH)) {
      return fail('bad_request', `${field}.name must be 1–${MAX_ATTACHMENT_NAME_LENGTH} characters`)
    }
    const mimeType = parseOptionalString(
      item.mimeType,
      MAX_ATTACHMENT_MIME_LENGTH,
      `${field}.mimeType`,
    )
    if (!mimeType.ok) return mimeType
    const size = item.size
    if (!isNonNegativeInteger(size) || size > MAX_FILE_ATTACHMENT_BYTES) {
      return fail(
        'bad_request',
        `${field}.size must be a non-negative integer up to ${MAX_FILE_ATTACHMENT_BYTES}`,
      )
    }
    attachments.push({
      id,
      kind,
      name,
      ...(mimeType.value !== undefined && mimeType.value !== ''
        ? { mimeType: mimeType.value }
        : {}),
      size,
    })
  }
  return ok(attachments)
}

function parseImages(
  value: unknown,
  field: string,
): Result<readonly MobileMessageImage[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (!Array.isArray(value)) return fail('bad_request', `${field} must be an array`)
  if (value.length > MAX_IMAGES_PER_MESSAGE) {
    return fail('bad_request', `${field} must contain at most ${MAX_IMAGES_PER_MESSAGE} entries`)
  }
  const images: MobileMessageImage[] = []
  for (const item of value) {
    if (!isRecord(item)) return fail('bad_request', `${field} entries must be objects`)
    const index = item.index
    if (!isNonNegativeInteger(index) || index > MAX_MESSAGE_IMAGE_INDEX) {
      return fail(
        'bad_request',
        `${field}.index must be a non-negative integer up to ${MAX_MESSAGE_IMAGE_INDEX}`,
      )
    }
    const mimeType = item.mimeType
    if (!isNonEmptyBoundedString(mimeType, MAX_ATTACHMENT_MIME_LENGTH)) {
      return fail(
        'bad_request',
        `${field}.mimeType must be 1–${MAX_ATTACHMENT_MIME_LENGTH} characters`,
      )
    }
    const size = item.size
    if (!isNonNegativeInteger(size) || size > MAX_MESSAGE_IMAGE_BYTES) {
      return fail(
        'bad_request',
        `${field}.size must be a non-negative integer up to ${MAX_MESSAGE_IMAGE_BYTES}`,
      )
    }
    const truncated = item.truncated
    if (truncated !== undefined && typeof truncated !== 'boolean') {
      return fail('bad_request', `${field}.truncated must be a boolean`)
    }
    images.push({
      index,
      mimeType,
      size,
      ...(truncated === true ? { truncated: true } : {}),
    })
  }
  return ok(images)
}

function parseTimeline(value: unknown): Result<MobileTimelineItem[]> {
  if (!Array.isArray(value)) {
    return fail('bad_request', 'session.timeline must be an array')
  }
  if (value.length > MAX_TIMELINE_ITEMS) {
    return fail('bad_request', `session.timeline must contain at most ${MAX_TIMELINE_ITEMS} items`)
  }
  const items: MobileTimelineItem[] = []
  for (const raw of value) {
    const item = parseTimelineItem(raw)
    if (!item.ok) return item
    items.push(item.value)
  }
  return ok(items)
}

function parseTimelineItem(value: unknown): Result<MobileTimelineItem> {
  if (!isRecord(value)) return fail('bad_request', 'timeline item must be an object')
  const kind = value.kind
  if (typeof kind !== 'string' || !isTimelineItemKind(kind)) {
    return fail('bad_request', 'timeline item kind is not known')
  }
  switch (kind) {
    case 'message':
      return parseTimelineMessage(value)
    case 'toolCall':
      return parseTimelineToolCall(value)
    case 'notice':
      return parseTimelineNotice(value)
  }
  return fail('bad_request', 'timeline item kind is not known')
}

function parseTimelineMessage(value: Record<string, unknown>): Result<MobileTimelineMessageItem> {
  const id = value.id
  if (!isNonEmptyBoundedString(id, MAX_ID_LENGTH)) {
    return fail('bad_request', 'message.id must be 1–128 characters')
  }
  const role = value.role
  if (typeof role !== 'string' || !isMessageRole(role)) {
    return fail('bad_request', 'message.role is not known')
  }
  const text = value.text
  if (!isBoundedString(text, MAX_TEXT_LENGTH)) {
    return fail('bad_request', 'message.text is too large')
  }
  const streaming = value.streaming
  if (typeof streaming !== 'boolean') {
    return fail('bad_request', 'message.streaming must be a boolean')
  }
  const memoryTrimmed = parseOptionalBoolean(value.memoryTrimmed, 'message.memoryTrimmed')
  if (!memoryTrimmed.ok) return memoryTrimmed
  const hasNonText = parseOptionalBoolean(value.hasNonText, 'message.hasNonText')
  if (!hasNonText.ok) return hasNonText
  const attachments = parseAttachments(value.attachments, 'message.attachments')
  if (!attachments.ok) return attachments
  const images = parseImages(value.images, 'message.images')
  if (!images.ok) return images
  const messageId = parseOptionalNonEmptyString(value.messageId, MAX_ID_LENGTH, 'message.messageId')
  if (!messageId.ok) return messageId
  const canFork = parseOptionalBoolean(value.canFork, 'message.canFork')
  if (!canFork.ok) return canFork
  return ok({
    kind: 'message',
    id,
    role,
    text,
    streaming,
    ...(memoryTrimmed.value !== undefined ? { memoryTrimmed: memoryTrimmed.value } : {}),
    ...(attachments.value !== undefined ? { attachments: attachments.value } : {}),
    ...(images.value !== undefined ? { images: images.value } : {}),
    ...(hasNonText.value !== undefined ? { hasNonText: hasNonText.value } : {}),
    ...(messageId.value !== undefined ? { messageId: messageId.value } : {}),
    ...(canFork.value !== undefined ? { canFork: canFork.value } : {}),
  })
}

function parseTimelineToolCall(value: Record<string, unknown>): Result<MobileTimelineToolCallItem> {
  const id = value.id
  if (!isNonEmptyBoundedString(id, MAX_ID_LENGTH)) {
    return fail('bad_request', 'toolCall.id must be 1–128 characters')
  }
  const title = value.title
  if (!isBoundedString(title, MAX_TITLE_LENGTH)) {
    return fail('bad_request', 'toolCall.title is too large')
  }
  const toolKind = value.toolKind
  if (!isBoundedString(toolKind, MAX_STATUS_LENGTH)) {
    return fail('bad_request', 'toolCall.toolKind is too large')
  }
  const status = value.status
  if (!isNonEmptyBoundedString(status, MAX_STATUS_LENGTH)) {
    return fail('bad_request', 'toolCall.status must be 1–64 characters')
  }
  const preview = parseOptionalString(value.preview, MAX_PREVIEW_LENGTH, 'toolCall.preview')
  if (!preview.ok) return preview
  const hasDetail = value.hasDetail
  if (typeof hasDetail !== 'boolean') {
    return fail('bad_request', 'toolCall.hasDetail must be a boolean')
  }
  const diffs = parseOptional(value.diffs, parseDiffStats)
  if (!diffs.ok) return diffs
  const locations = parseOptional(value.locations, parseLocations)
  if (!locations.ok) return locations
  const memoryTrimmed = parseOptionalBoolean(value.memoryTrimmed, 'toolCall.memoryTrimmed')
  if (!memoryTrimmed.ok) return memoryTrimmed
  const subagent = parseOptionalBoolean(value.subagent, 'toolCall.subagent')
  if (!subagent.ok) return subagent
  const requiresUserDecision = parseOptionalBoolean(
    value.requiresUserDecision,
    'toolCall.requiresUserDecision',
  )
  if (!requiresUserDecision.ok) return requiresUserDecision
  const startedAt = parseOptionalNonNegativeInteger(value.startedAt, 'toolCall.startedAt')
  if (!startedAt.ok) return startedAt
  const durationMs = parseOptionalNonNegativeInteger(value.durationMs, 'toolCall.durationMs')
  if (!durationMs.ok) return durationMs
  const settleReason = parseOptionalNonEmptyString(
    value.settleReason,
    MAX_REASON_LENGTH,
    'toolCall.settleReason',
  )
  if (!settleReason.ok) return settleReason
  const syntheticDenial = parseOptionalBoolean(value.syntheticDenial, 'toolCall.syntheticDenial')
  if (!syntheticDenial.ok) return syntheticDenial
  return ok({
    kind: 'toolCall',
    id,
    title,
    toolKind,
    status,
    hasDetail,
    ...(preview.value !== undefined ? { preview: preview.value } : {}),
    ...(diffs.value !== undefined ? { diffs: diffs.value } : {}),
    ...(locations.value !== undefined ? { locations: locations.value } : {}),
    ...(memoryTrimmed.value !== undefined ? { memoryTrimmed: memoryTrimmed.value } : {}),
    ...(subagent.value !== undefined ? { subagent: subagent.value } : {}),
    ...(requiresUserDecision.value !== undefined
      ? { requiresUserDecision: requiresUserDecision.value }
      : {}),
    ...(startedAt.value !== undefined ? { startedAt: startedAt.value } : {}),
    ...(durationMs.value !== undefined ? { durationMs: durationMs.value } : {}),
    ...(settleReason.value !== undefined ? { settleReason: settleReason.value } : {}),
    ...(syntheticDenial.value !== undefined ? { syntheticDenial: syntheticDenial.value } : {}),
  })
}

function parseTimelineNotice(value: Record<string, unknown>): Result<MobileTimelineNoticeItem> {
  const id = value.id
  if (!isNonEmptyBoundedString(id, MAX_ID_LENGTH)) {
    return fail('bad_request', 'notice.id must be 1–128 characters')
  }
  const noticeKind = value.noticeKind
  if (typeof noticeKind !== 'string' || !isNoticeKind(noticeKind)) {
    return fail('bad_request', 'notice.noticeKind is not known')
  }
  const phase = value.phase
  if (typeof phase !== 'string' || !isNoticePhase(phase)) {
    return fail('bad_request', 'notice.phase is not known')
  }
  const text = parseOptionalString(value.text, MAX_TITLE_LENGTH, 'notice.text')
  if (!text.ok) return text
  return ok({
    kind: 'notice',
    id,
    noticeKind,
    phase,
    ...(text.value !== undefined ? { text: text.value } : {}),
  })
}

function parseDiffStats(value: unknown): Result<MobileToolCallDiffStat[]> {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALL_DIFFS) {
    return fail('bad_request', `toolCall.diffs must be an array of at most ${MAX_TOOL_CALL_DIFFS}`)
  }
  const diffs: MobileToolCallDiffStat[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return fail('bad_request', 'toolCall.diffs entries must be objects')
    const path = raw.path
    if (!isBoundedString(path, MAX_WORKSPACE_NAME_LENGTH)) {
      return fail('bad_request', 'toolCall.diffs.path is too large')
    }
    const added = raw.added
    const removed = raw.removed
    if (!isNonNegativeInteger(added) || !isNonNegativeInteger(removed)) {
      return fail('bad_request', 'toolCall.diffs.added/removed must be non-negative integers')
    }
    diffs.push({ path, added, removed })
  }
  return ok(diffs)
}

function parseLocations(value: unknown): Result<MobileToolCallLocation[]> {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALL_LOCATIONS) {
    return fail(
      'bad_request',
      `toolCall.locations must be an array of at most ${MAX_TOOL_CALL_LOCATIONS}`,
    )
  }
  const locations: MobileToolCallLocation[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return fail('bad_request', 'toolCall.locations entries must be objects')
    const path = raw.path
    if (!isBoundedString(path, MAX_WORKSPACE_NAME_LENGTH)) {
      return fail('bad_request', 'toolCall.locations.path is too large')
    }
    const line = raw.line
    if (line !== undefined && !isNonNegativeInteger(line)) {
      return fail('bad_request', 'toolCall.locations.line must be a non-negative integer')
    }
    locations.push({ path, ...(line !== undefined ? { line } : {}) })
  }
  return ok(locations)
}

function parsePlan(value: unknown): Result<MobilePlanEntry[]> {
  if (!Array.isArray(value) || value.length > MAX_PLAN_ENTRIES) {
    return fail('bad_request', `session.plan must be an array of at most ${MAX_PLAN_ENTRIES}`)
  }
  const plan: MobilePlanEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return fail('bad_request', 'plan entries must be objects')
    const content = raw.content
    if (!isBoundedString(content, MAX_TEXT_LENGTH)) {
      return fail('bad_request', 'plan.content is too large')
    }
    const status = raw.status
    if (typeof status !== 'string' || !isPlanEntryStatus(status)) {
      return fail('bad_request', 'plan.status is not known')
    }
    const priority = parseOptionalString(raw.priority, MAX_STATUS_LENGTH, 'plan.priority')
    if (!priority.ok) return priority
    plan.push({
      content,
      status,
      ...(priority.value !== undefined ? { priority: priority.value } : {}),
    })
  }
  return ok(plan)
}

function parseConfigOptions(value: unknown): Result<MobileConfigOption[]> {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_OPTIONS) {
    return fail(
      'bad_request',
      `session.configOptions must be an array of at most ${MAX_CONFIG_OPTIONS}`,
    )
  }
  const options: MobileConfigOption[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return fail('bad_request', 'config option entries must be objects')
    const id = raw.id
    if (!isNonEmptyBoundedString(id, MAX_ID_LENGTH)) {
      return fail('bad_request', 'configOption.id must be 1–128 characters')
    }
    const name = raw.name
    if (!isBoundedString(name, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'configOption.name is too large')
    }
    const category = parseOptionalString(raw.category, MAX_STATUS_LENGTH, 'configOption.category')
    if (!category.ok) return category
    const type = raw.type
    if (typeof type !== 'string' || !isConfigOptionType(type)) {
      return fail('bad_request', 'configOption.type is not known')
    }
    const currentValue = raw.currentValue
    if (!isBoundedString(currentValue, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'configOption.currentValue is too large')
    }
    if (typeof raw.allowedOnMobile !== 'boolean') {
      return fail('bad_request', 'configOption.allowedOnMobile must be a boolean')
    }
    const values = parseOptional(raw.options, parseConfigOptionValues)
    if (!values.ok) return values
    options.push({
      id,
      name,
      type,
      currentValue,
      allowedOnMobile: raw.allowedOnMobile,
      ...(category.value !== undefined ? { category: category.value } : {}),
      ...(values.value !== undefined ? { options: values.value } : {}),
    })
  }
  return ok(options)
}

function parseAvailableCommands(value: unknown): Result<MobileAvailableCommand[]> {
  if (!Array.isArray(value) || value.length > MAX_MOBILE_COMMANDS) {
    return fail(
      'bad_request',
      `availableCommands must be an array of at most ${MAX_MOBILE_COMMANDS}`,
    )
  }
  const commands: MobileAvailableCommand[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return fail('bad_request', 'availableCommands entries must be objects')
    const name = raw.name
    if (!isNonEmptyBoundedString(name, MAX_COMMAND_NAME_LENGTH)) {
      return fail('bad_request', `command.name must be 1–${MAX_COMMAND_NAME_LENGTH} characters`)
    }
    if (/\s/.test(name)) {
      return fail('bad_request', 'command.name must not contain whitespace')
    }
    const description = raw.description
    if (!isBoundedString(description, MAX_COMMAND_DESCRIPTION_LENGTH)) {
      return fail(
        'bad_request',
        `command.description must be at most ${MAX_COMMAND_DESCRIPTION_LENGTH} characters`,
      )
    }
    const inputHint = parseOptionalString(
      raw.inputHint,
      MAX_COMMAND_INPUT_HINT_LENGTH,
      'command.inputHint',
    )
    if (!inputHint.ok) return inputHint
    commands.push({
      name,
      description,
      ...(inputHint.value !== undefined ? { inputHint: inputHint.value } : {}),
    })
  }
  return ok(commands)
}

function parseConfigOptionValues(value: unknown): Result<MobileConfigOptionValue[]> {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_OPTIONS) {
    return fail('bad_request', 'configOption.options must be a bounded array')
  }
  const options: MobileConfigOptionValue[] = []
  for (const raw of value) {
    if (!isRecord(raw)) {
      return fail('bad_request', 'configOption.options entries must be objects')
    }
    const optionValue = raw.value
    if (!isNonEmptyBoundedString(optionValue, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'configOption.options.value is too large')
    }
    const label = raw.label
    if (!isBoundedString(label, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'configOption.options.label is too large')
    }
    if (typeof raw.allowedOnMobile !== 'boolean') {
      return fail('bad_request', 'configOption.options.allowedOnMobile must be a boolean')
    }
    options.push({ value: optionValue, label, allowedOnMobile: raw.allowedOnMobile })
  }
  return ok(options)
}

function parseUsage(value: unknown): Result<MobileUsage> {
  if (!isRecord(value)) return fail('bad_request', 'session.usage must be an object')
  const used = value.used
  const size = value.size
  if (!isNonNegativeInteger(used) || !isNonNegativeInteger(size)) {
    return fail('bad_request', 'session.usage.used/size must be non-negative integers')
  }
  let cost: { amount: number; currency: string } | undefined
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) return fail('bad_request', 'session.usage.cost must be an object')
    const amount = value.cost.amount
    const currency = value.cost.currency
    if (!isFiniteNumber(amount) || !isNonEmptyBoundedString(currency, MAX_CURRENCY_LENGTH)) {
      return fail('bad_request', 'session.usage.cost is malformed')
    }
    cost = { amount, currency }
  }
  const costEstimated = parseOptionalBoolean(value.costEstimated, 'session.usage.costEstimated')
  if (!costEstimated.ok) return costEstimated
  return ok({
    used,
    size,
    ...(cost !== undefined ? { cost } : {}),
    ...(costEstimated.value !== undefined ? { costEstimated: costEstimated.value } : {}),
  })
}

function parsePendingPermission(value: unknown): Result<MobilePendingPermission> {
  if (!isRecord(value)) return fail('bad_request', 'session.pendingPermission must be an object')
  const requestId = value.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail('bad_request', 'permission.requestId must be 1–128 characters')
  }
  const toolCallId = value.toolCallId
  if (!isNonEmptyBoundedString(toolCallId, MAX_ID_LENGTH)) {
    return fail('bad_request', 'permission.toolCallId must be 1–128 characters')
  }
  const title = value.title
  if (!isBoundedString(title, MAX_TITLE_LENGTH)) {
    return fail('bad_request', 'permission.title is too large')
  }
  const kind = parseOptionalString(value.kind, MAX_STATUS_LENGTH, 'permission.kind')
  if (!kind.ok) return kind
  if (!Array.isArray(value.options) || value.options.length > MAX_PERMISSION_OPTIONS) {
    return fail(
      'bad_request',
      `permission.options must be an array of at most ${MAX_PERMISSION_OPTIONS}`,
    )
  }
  const options: MobilePermissionOption[] = []
  for (const raw of value.options) {
    if (!isRecord(raw)) return fail('bad_request', 'permission.options entries must be objects')
    const optionId = raw.optionId
    if (!isNonEmptyBoundedString(optionId, MAX_ID_LENGTH)) {
      return fail('bad_request', 'permission.options.optionId must be 1–128 characters')
    }
    const name = raw.name
    if (!isBoundedString(name, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'permission.options.name is too large')
    }
    const optionKind = parseOptionalString(raw.kind, MAX_STATUS_LENGTH, 'permission.options.kind')
    if (!optionKind.ok) return optionKind
    if (typeof raw.allowedOnMobile !== 'boolean') {
      return fail('bad_request', 'permission.options.allowedOnMobile must be a boolean')
    }
    options.push({
      optionId,
      name,
      ...(optionKind.value !== undefined ? { kind: optionKind.value } : {}),
      allowedOnMobile: raw.allowedOnMobile,
    })
  }
  let autoResolve: { optionId: string; deadlineAt?: number; paused: boolean } | undefined
  if (value.autoResolve !== undefined) {
    if (!isRecord(value.autoResolve)) {
      return fail('bad_request', 'permission.autoResolve must be an object')
    }
    const optionId = value.autoResolve.optionId
    if (!isNonEmptyBoundedString(optionId, MAX_ID_LENGTH)) {
      return fail('bad_request', 'permission.autoResolve.optionId must be 1–128 characters')
    }
    const deadlineAt = value.autoResolve.deadlineAt
    if (deadlineAt !== undefined && !isFiniteNumber(deadlineAt)) {
      return fail('bad_request', 'permission.autoResolve.deadlineAt must be finite')
    }
    if (typeof value.autoResolve.paused !== 'boolean') {
      return fail('bad_request', 'permission.autoResolve.paused must be a boolean')
    }
    autoResolve = {
      optionId,
      paused: value.autoResolve.paused,
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    }
  }
  return ok({
    requestId,
    toolCallId,
    title,
    options,
    ...(kind.value !== undefined ? { kind: kind.value } : {}),
    ...(autoResolve !== undefined ? { autoResolve } : {}),
  })
}

function parsePendingElicitation(value: unknown): Result<MobilePendingElicitation> {
  if (!isRecord(value)) return fail('bad_request', 'session.pendingElicitation must be an object')
  const requestId = value.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail('bad_request', 'elicitation.requestId must be 1–128 characters')
  }
  const mode = value.mode
  if (!isNonEmptyBoundedString(mode, MAX_STATUS_LENGTH)) {
    return fail('bad_request', 'elicitation.mode must be 1–64 characters')
  }
  const message = value.message
  if (!isBoundedString(message, MAX_TEXT_LENGTH)) {
    return fail('bad_request', 'elicitation.message is too large')
  }
  const title = parseOptionalString(value.title, MAX_TITLE_LENGTH, 'elicitation.title')
  if (!title.ok) return title
  const toolCallId = parseOptionalString(value.toolCallId, MAX_ID_LENGTH, 'elicitation.toolCallId')
  if (!toolCallId.ok) return toolCallId
  const url = parseOptionalString(value.url, MAX_TEXT_LENGTH, 'elicitation.url')
  if (!url.ok) return url
  const fields = parseOptional(value.fields, parseElicitationFields)
  if (!fields.ok) return fields
  return ok({
    requestId,
    mode,
    message,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(toolCallId.value !== undefined ? { toolCallId: toolCallId.value } : {}),
    ...(url.value !== undefined ? { url: url.value } : {}),
    ...(fields.value !== undefined ? { fields: fields.value } : {}),
  })
}

function parseElicitationFields(value: unknown): Result<MobileElicitationField[]> {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_OPTIONS) {
    return fail('bad_request', 'elicitation.fields must be an array of bounded length')
  }
  const fields: MobileElicitationField[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return fail('bad_request', 'elicitation.fields entries must be objects')
    const name = raw.name
    if (!isNonEmptyBoundedString(name, MAX_ID_LENGTH)) {
      return fail('bad_request', 'elicitation.fields.name must be 1–128 characters')
    }
    const kind = raw.kind
    if (typeof kind !== 'string' || !isElicitationFieldKind(kind)) {
      return fail('bad_request', 'elicitation.fields.kind is not known')
    }
    if (typeof raw.required !== 'boolean') {
      return fail('bad_request', 'elicitation.fields.required must be a boolean')
    }
    const title = parseOptionalString(raw.title, MAX_TITLE_LENGTH, 'elicitation.fields.title')
    if (!title.ok) return title
    const description = parseOptionalString(
      raw.description,
      MAX_TEXT_LENGTH,
      'elicitation.fields.description',
    )
    if (!description.ok) return description
    const minLength = parseOptionalInteger(raw.minLength, 'elicitation.fields.minLength')
    if (!minLength.ok) return minLength
    const maxLength = parseOptionalInteger(raw.maxLength, 'elicitation.fields.maxLength')
    if (!maxLength.ok) return maxLength
    const pattern = parseOptionalString(raw.pattern, MAX_TEXT_LENGTH, 'elicitation.fields.pattern')
    if (!pattern.ok) return pattern
    const format = parseOptionalString(raw.format, MAX_STATUS_LENGTH, 'elicitation.fields.format')
    if (!format.ok) return format
    const integer = parseOptionalBoolean(raw.integer, 'elicitation.fields.integer')
    if (!integer.ok) return integer
    const minimum = parseOptionalNumber(raw.minimum, 'elicitation.fields.minimum')
    if (!minimum.ok) return minimum
    const maximum = parseOptionalNumber(raw.maximum, 'elicitation.fields.maximum')
    if (!maximum.ok) return maximum
    const minItems = parseOptionalInteger(raw.minItems, 'elicitation.fields.minItems')
    if (!minItems.ok) return minItems
    const maxItems = parseOptionalInteger(raw.maxItems, 'elicitation.fields.maxItems')
    if (!maxItems.ok) return maxItems
    const def = parseElicitationFieldDefault(raw.default)
    if (!def.ok) return def
    const options = parseOptional(raw.options, parseElicitationEnumOptions)
    if (!options.ok) return options
    fields.push({
      name,
      kind,
      required: raw.required,
      ...(title.value !== undefined ? { title: title.value } : {}),
      ...(description.value !== undefined ? { description: description.value } : {}),
      ...(minLength.value !== undefined ? { minLength: minLength.value } : {}),
      ...(maxLength.value !== undefined ? { maxLength: maxLength.value } : {}),
      ...(pattern.value !== undefined ? { pattern: pattern.value } : {}),
      ...(format.value !== undefined ? { format: format.value } : {}),
      ...(integer.value !== undefined ? { integer: integer.value } : {}),
      ...(minimum.value !== undefined ? { minimum: minimum.value } : {}),
      ...(maximum.value !== undefined ? { maximum: maximum.value } : {}),
      ...(options.value !== undefined ? { options: options.value } : {}),
      ...(minItems.value !== undefined ? { minItems: minItems.value } : {}),
      ...(maxItems.value !== undefined ? { maxItems: maxItems.value } : {}),
      ...(def.value !== undefined ? { default: def.value } : {}),
    })
  }
  return ok(fields)
}

function parseElicitationEnumOptions(value: unknown): Result<MobileElicitationEnumOption[]> {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_OPTIONS) {
    return fail('bad_request', 'elicitation.fields.options must be a bounded array')
  }
  const options: MobileElicitationEnumOption[] = []
  for (const raw of value) {
    if (!isRecord(raw)) {
      return fail('bad_request', 'elicitation.fields.options entries must be objects')
    }
    const optionValue = raw.value
    if (!isNonEmptyBoundedString(optionValue, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'elicitation.fields.options.value is too large')
    }
    const title = raw.title
    if (!isBoundedString(title, MAX_TITLE_LENGTH)) {
      return fail('bad_request', 'elicitation.fields.options.title is too large')
    }
    const description = parseOptionalString(
      raw.description,
      MAX_TEXT_LENGTH,
      'elicitation.fields.options.description',
    )
    if (!description.ok) return description
    options.push({
      value: optionValue,
      title,
      ...(description.value !== undefined ? { description: description.value } : {}),
    })
  }
  return ok(options)
}

function parseElicitationFieldDefault(
  value: unknown,
): Result<string | number | boolean | readonly string[] | undefined> {
  if (value === undefined) return ok(undefined)
  if (isValidElicitationContentValue(value)) return ok(value)
  return fail('bad_request', 'elicitation.fields.default has an unsupported value')
}

function parseOptionalInteger(value: unknown, field: string): Result<number | undefined> {
  if (value === undefined) return ok(undefined)
  if (!isNonNegativeInteger(value)) return fail('bad_request', `${field} must be an integer`)
  return ok(value)
}

function parseOptionalNumber(value: unknown, field: string): Result<number | undefined> {
  if (value === undefined) return ok(undefined)
  if (!isFiniteNumber(value)) return fail('bad_request', `${field} must be finite`)
  return ok(value)
}

function parseSessionDeltaFrame(frame: Record<string, unknown>): Result<SessionDeltaFrame> {
  const seq = frame.seq
  if (!isNonNegativeInteger(seq)) {
    return fail('bad_request', 'session_delta.seq must be a non-negative integer')
  }
  const ref = parseSessionRef(frame.ref)
  if (!ref.ok) return ref
  const rawEvents = frame.events
  if (!Array.isArray(rawEvents)) {
    return fail('bad_request', 'session_delta.events must be an array')
  }
  if (rawEvents.length > MAX_EVENTS_PER_DELTA) {
    return fail(
      'bad_request',
      `session_delta.events must contain at most ${MAX_EVENTS_PER_DELTA} entries`,
    )
  }
  const events: MobileSessionEvent[] = []
  for (const raw of rawEvents) {
    const event = parseSessionEvent(raw)
    if (!event.ok) return event
    events.push(event.value)
  }
  return ok({ type: 'session_delta', seq, ref: ref.value, events })
}

function parseSessionEvent(value: unknown): Result<MobileSessionEvent> {
  if (!isRecord(value)) return fail('bad_request', 'session event must be an object')
  const type = value.type
  if (typeof type !== 'string') {
    return fail('bad_request', 'session event.type must be a string')
  }
  switch (type) {
    case 'message_upsert':
      return parseMessageUpsertEvent(value)
    case 'tool_call_upsert': {
      if (!isRecord(value.item)) {
        return fail('bad_request', 'tool_call_upsert.item must be an object')
      }
      const item = parseTimelineToolCall(value.item)
      if (!item.ok) return item
      return ok({ type: 'tool_call_upsert', item: item.value })
    }
    case 'timeline_item_added': {
      const item = parseTimelineItem(value.item)
      if (!item.ok) return item
      return ok({ type: 'timeline_item_added', item: item.value })
    }
    case 'timeline_item_removed': {
      const id = value.id
      if (!isNonEmptyBoundedString(id, MAX_ID_LENGTH)) {
        return fail('bad_request', 'timeline_item_removed.id must be 1–128 characters')
      }
      return ok({ type: 'timeline_item_removed', id })
    }
    case 'plan_snapshot': {
      const plan = parsePlan(value.plan)
      if (!plan.ok) return plan
      return ok({ type: 'plan_snapshot', plan: plan.value })
    }
    case 'config_options_snapshot': {
      const options = parseConfigOptions(value.options)
      if (!options.ok) return options
      return ok({ type: 'config_options_snapshot', options: options.value })
    }
    case 'available_commands_snapshot': {
      const commands = parseAvailableCommands(value.commands)
      if (!commands.ok) return commands
      return ok({ type: 'available_commands_snapshot', commands: commands.value })
    }
    case 'summary_changed': {
      const summary = parseSessionSummary(value.summary)
      if (!summary.ok) return summary
      return ok({ type: 'summary_changed', summary: summary.value })
    }
    case 'permission_upsert': {
      const permission = parsePendingPermission(value.permission)
      if (!permission.ok) return permission
      return ok({ type: 'permission_upsert', permission: permission.value })
    }
    case 'permission_cleared': {
      const requestId = value.requestId
      if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
        return fail('bad_request', 'permission_cleared.requestId must be 1–128 characters')
      }
      const reason = value.reason
      if (typeof reason !== 'string' || !isPermissionSettleReason(reason)) {
        return fail('bad_request', 'permission_cleared.reason is not known')
      }
      const source = value.source
      if (typeof source !== 'string' || !isPermissionSettleSource(source)) {
        return fail('bad_request', 'permission_cleared.source is not known')
      }
      return ok({ type: 'permission_cleared', requestId, reason, source })
    }
    case 'elicitation_upsert': {
      const elicitation = parsePendingElicitation(value.elicitation)
      if (!elicitation.ok) return elicitation
      return ok({ type: 'elicitation_upsert', elicitation: elicitation.value })
    }
    case 'elicitation_cleared':
      return ok({ type: 'elicitation_cleared' })
    case 'draft_update': {
      const draft = parseDraftState(value.draft)
      if (!draft.ok) return draft
      const clientUpdateId = parseOptionalNonEmptyString(
        value.clientUpdateId,
        MAX_DRAFT_UPDATE_ID_LENGTH,
        'draft_update.clientUpdateId',
      )
      if (!clientUpdateId.ok) return clientUpdateId
      return ok({
        type: 'draft_update',
        draft: draft.value,
        ...(clientUpdateId.value !== undefined ? { clientUpdateId: clientUpdateId.value } : {}),
      } satisfies MobileDraftUpdateEvent)
    }
    default:
      return fail('bad_request', `unknown session event type: ${type}`)
  }
}

function parseMessageUpsertEvent(value: Record<string, unknown>): Result<MobileSessionEvent> {
  const id = value.id
  if (!isNonEmptyBoundedString(id, MAX_ID_LENGTH)) {
    return fail('bad_request', 'message_upsert.id must be 1–128 characters')
  }
  const role = value.role
  if (typeof role !== 'string' || !isMessageRole(role)) {
    return fail('bad_request', 'message_upsert.role is not known')
  }
  const textAppend = parseOptionalString(
    value.textAppend,
    MAX_TEXT_LENGTH,
    'message_upsert.textAppend',
  )
  if (!textAppend.ok) return textAppend
  const textReplace = parseOptionalString(
    value.textReplace,
    MAX_TEXT_LENGTH,
    'message_upsert.textReplace',
  )
  if (!textReplace.ok) return textReplace
  const streaming = value.streaming
  if (typeof streaming !== 'boolean') {
    return fail('bad_request', 'message_upsert.streaming must be a boolean')
  }
  const memoryTrimmed = parseOptionalBoolean(value.memoryTrimmed, 'message_upsert.memoryTrimmed')
  if (!memoryTrimmed.ok) return memoryTrimmed
  const hasNonText = parseOptionalBoolean(value.hasNonText, 'message_upsert.hasNonText')
  if (!hasNonText.ok) return hasNonText
  const attachments = parseAttachments(value.attachments, 'message_upsert.attachments')
  if (!attachments.ok) return attachments
  const images = parseImages(value.images, 'message_upsert.images')
  if (!images.ok) return images
  const messageId = parseOptionalNonEmptyString(
    value.messageId,
    MAX_ID_LENGTH,
    'message_upsert.messageId',
  )
  if (!messageId.ok) return messageId
  const canFork = parseOptionalBoolean(value.canFork, 'message_upsert.canFork')
  if (!canFork.ok) return canFork
  return ok({
    type: 'message_upsert',
    id,
    role,
    streaming,
    ...(textAppend.value !== undefined ? { textAppend: textAppend.value } : {}),
    ...(textReplace.value !== undefined ? { textReplace: textReplace.value } : {}),
    ...(memoryTrimmed.value !== undefined ? { memoryTrimmed: memoryTrimmed.value } : {}),
    ...(attachments.value !== undefined ? { attachments: attachments.value } : {}),
    ...(images.value !== undefined ? { images: images.value } : {}),
    ...(hasNonText.value !== undefined ? { hasNonText: hasNonText.value } : {}),
    ...(messageId.value !== undefined ? { messageId: messageId.value } : {}),
    ...(canFork.value !== undefined ? { canFork: canFork.value } : {}),
  })
}

function parseSessionRemovedFrame(frame: Record<string, unknown>): Result<SessionRemovedFrame> {
  const ref = parseSessionRef(frame.ref)
  if (!ref.ok) return ref
  return ok({ type: 'session_removed', ref: ref.value })
}

function parseCommandResultFrame(frame: Record<string, unknown>): Result<ServerFrame> {
  const requestId = frame.requestId
  if (!isNonEmptyBoundedString(requestId, MAX_REQUEST_ID_LENGTH)) {
    return fail('bad_request', 'command_result.requestId must be 1–128 characters')
  }
  const success = frame.ok
  if (typeof success !== 'boolean') {
    return fail('bad_request', 'command_result.ok must be a boolean')
  }
  const error = frame.error
  if (error !== undefined && !isMobileErrorCode(error)) {
    return fail('bad_request', 'command_result.error is not a known code')
  }
  return ok({
    type: 'command_result',
    requestId,
    ok: success,
    ...(frame.result !== undefined ? { result: frame.result } : {}),
    ...(error !== undefined ? { error } : {}),
  })
}

function parseResyncRequiredFrame(frame: Record<string, unknown>): Result<ResyncRequiredFrame> {
  const scope = frame.scope
  if (typeof scope !== 'string' || !isResyncScope(scope)) {
    return fail('bad_request', 'resync_required.scope is not known')
  }
  const reason = frame.reason
  if (!isBoundedString(reason, MAX_REASON_LENGTH)) {
    return fail('bad_request', 'resync_required.reason is too large')
  }
  const ref = frame.ref === undefined ? undefined : parseSessionRef(frame.ref)
  if (ref !== undefined && !ref.ok) return ref
  return ok({
    type: 'resync_required',
    scope,
    reason,
    ...(ref !== undefined && ref.ok ? { ref: ref.value } : {}),
  })
}

function parseServerErrorFrame(frame: Record<string, unknown>): Result<ServerErrorFrame> {
  const code = frame.code
  if (!isMobileErrorCode(code)) return fail('bad_request', 'server_error.code is not known')
  const message = frame.message
  if (typeof message !== 'string') {
    return fail('bad_request', 'server_error.message must be a string')
  }
  const retryable = frame.retryable
  if (typeof retryable !== 'boolean') {
    return fail('bad_request', 'server_error.retryable must be a boolean')
  }
  return ok({ type: 'server_error', code, message, retryable })
}

function parseOptional<T>(
  value: unknown,
  parser: (value: unknown) => Result<T>,
): Result<T | undefined> {
  if (value === undefined) return ok(undefined)
  return parser(value)
}

function parseOptionalString(
  value: unknown,
  maxLength: number,
  field: string,
): Result<string | undefined> {
  if (value === undefined) return ok(undefined)
  if (!isBoundedString(value, maxLength)) {
    return fail('bad_request', `${field} must be at most ${maxLength} characters`)
  }
  return ok(value)
}

function parseOptionalNonEmptyString(
  value: unknown,
  maxLength: number,
  field: string,
): Result<string | undefined> {
  if (value === undefined) return ok(undefined)
  if (!isNonEmptyBoundedString(value, maxLength)) {
    return fail('bad_request', `${field} must be 1–${maxLength} characters`)
  }
  return ok(value)
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  field: string,
): Result<number | undefined> {
  if (value === undefined) return ok(undefined)
  if (!isNonNegativeInteger(value)) {
    return fail('bad_request', `${field} must be a non-negative integer`)
  }
  return ok(value)
}

function parseOptionalBoolean(value: unknown, field: string): Result<boolean | undefined> {
  if (value === undefined) return ok(undefined)
  if (typeof value !== 'boolean') return fail('bad_request', `${field} must be a boolean`)
  return ok(value)
}

const MOBILE_SESSION_BUCKET_SET: ReadonlySet<string> = new Set(MOBILE_SESSION_BUCKETS)

function isMobileSessionBucket(value: unknown): value is MobileSessionBucket {
  return typeof value === 'string' && MOBILE_SESSION_BUCKET_SET.has(value)
}

const MESSAGE_ROLE_SET: ReadonlySet<string> = new Set(MOBILE_MESSAGE_ROLES)

function isMessageRole(value: unknown): value is MobileMessageRole {
  return typeof value === 'string' && MESSAGE_ROLE_SET.has(value)
}

const TIMELINE_ITEM_KIND_SET: ReadonlySet<string> = new Set(MOBILE_TIMELINE_ITEM_KINDS)

function isTimelineItemKind(value: unknown): value is MobileTimelineItemKind {
  return typeof value === 'string' && TIMELINE_ITEM_KIND_SET.has(value)
}

const NOTICE_KIND_SET: ReadonlySet<string> = new Set(MOBILE_NOTICE_KINDS)

function isNoticeKind(value: unknown): value is MobileNoticeKind {
  return typeof value === 'string' && NOTICE_KIND_SET.has(value)
}

const NOTICE_PHASE_SET: ReadonlySet<string> = new Set(MOBILE_NOTICE_PHASES)

function isNoticePhase(value: unknown): value is MobileNoticePhase {
  return typeof value === 'string' && NOTICE_PHASE_SET.has(value)
}

const PLAN_ENTRY_STATUS_SET: ReadonlySet<string> = new Set(MOBILE_PLAN_ENTRY_STATUSES)

function isPlanEntryStatus(value: unknown): value is MobilePlanEntryStatus {
  return typeof value === 'string' && PLAN_ENTRY_STATUS_SET.has(value)
}

const CONFIG_OPTION_TYPE_SET: ReadonlySet<string> = new Set(MOBILE_CONFIG_OPTION_TYPES)

function isConfigOptionType(value: unknown): value is MobileConfigOptionType {
  return typeof value === 'string' && CONFIG_OPTION_TYPE_SET.has(value)
}

const RESYNC_SCOPE_SET: ReadonlySet<string> = new Set(MOBILE_RESYNC_SCOPES)

function isResyncScope(value: unknown): value is MobileResyncScope {
  return typeof value === 'string' && RESYNC_SCOPE_SET.has(value)
}

const PAIR_DEVICE_PLATFORM_SET: ReadonlySet<string> = new Set(PAIR_DEVICE_PLATFORMS)

function isPairDevicePlatform(value: unknown): value is PairDevicePlatform {
  return typeof value === 'string' && PAIR_DEVICE_PLATFORM_SET.has(value)
}

const ELICITATION_ACTION_SET: ReadonlySet<string> = new Set(MOBILE_ELICITATION_ACTIONS)

function isElicitationAction(value: unknown): value is MobileElicitationAction {
  return typeof value === 'string' && ELICITATION_ACTION_SET.has(value)
}

const ELICITATION_FIELD_KIND_SET: ReadonlySet<string> = new Set(MOBILE_ELICITATION_FIELD_KINDS)

function isElicitationFieldKind(value: unknown): value is MobileElicitationFieldKind {
  return typeof value === 'string' && ELICITATION_FIELD_KIND_SET.has(value)
}

const PERMISSION_SETTLE_REASON_SET: ReadonlySet<string> = new Set(MOBILE_PERMISSION_SETTLE_REASONS)

function isPermissionSettleReason(value: unknown): value is MobilePermissionSettleReason {
  return typeof value === 'string' && PERMISSION_SETTLE_REASON_SET.has(value)
}

const PERMISSION_SETTLE_SOURCE_SET: ReadonlySet<string> = new Set(MOBILE_PERMISSION_SETTLE_SOURCES)

function isPermissionSettleSource(value: unknown): value is MobilePermissionSettleSource {
  return typeof value === 'string' && PERMISSION_SETTLE_SOURCE_SET.has(value)
}

const ATTENTION_KIND_SET: ReadonlySet<string> = new Set(MOBILE_ATTENTION_KINDS)

function isAttentionKind(value: unknown): value is MobileAttentionKind {
  return typeof value === 'string' && ATTENTION_KIND_SET.has(value)
}
