import type {
  MobileAvailableCommand,
  MobileConfigOption,
  MobileDraftState,
  MobileMessageUpsertEvent,
  MobilePendingElicitation,
  MobilePendingPermission,
  MobilePermissionSettleReason,
  MobilePermissionSettleSource,
  MobilePlanEntry,
  MobileSessionEvent,
  MobileSessionRef,
  MobileSessionSnapshot,
  MobileSessionSummary,
  MobileTimelineItem,
  MobileTimelineMessageItem,
  MobileUsage,
  SessionDeltaFrame,
  SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'
import { refMatches } from './refs.js'
import { Store } from './store.js'

/** Metadata carried by the most recent `permission_cleared` event. */
export interface PermissionClearedInfo {
  readonly requestId: string
  readonly reason: MobilePermissionSettleReason
  readonly source: MobilePermissionSettleSource
}

export interface SessionState {
  readonly ref: MobileSessionRef | undefined
  readonly summary: MobileSessionSummary | undefined
  readonly timeline: readonly MobileTimelineItem[]
  readonly plan: readonly MobilePlanEntry[]
  readonly configOptions: readonly MobileConfigOption[]
  readonly availableCommands: readonly MobileAvailableCommand[]
  readonly usage: MobileUsage | undefined
  readonly pendingPermission: MobilePendingPermission | undefined
  readonly pendingElicitation: MobilePendingElicitation | undefined
  readonly permissionCleared: PermissionClearedInfo | undefined
  /** Latest draft published by the PC or another phone (hub registry). */
  readonly draft: MobileDraftState | undefined
  /** Highest gateway draft revision this client has incorporated. */
  readonly draftRevision: number
  /** Gateway ack for this client's latest accepted draft; identity drives effects. */
  readonly lastDraftAck: { readonly clientUpdateId: string; readonly revision: number } | undefined
  readonly isReplayingHistory: boolean
  readonly truncated: boolean
  readonly seq: number | undefined
  readonly removed: boolean
}

export type SessionApplyResult =
  | { readonly status: 'applied' }
  | { readonly status: 'ignored' }
  | {
      readonly status: 'resubscribe'
      readonly reason: 'missing_snapshot' | 'seq_regression' | 'seq_gap'
    }

const EMPTY: SessionState = {
  ref: undefined,
  summary: undefined,
  timeline: [],
  plan: [],
  configOptions: [],
  availableCommands: [],
  usage: undefined,
  pendingPermission: undefined,
  pendingElicitation: undefined,
  permissionCleared: undefined,
  draft: undefined,
  draftRevision: 0,
  lastDraftAck: undefined,
  isReplayingHistory: false,
  truncated: false,
  seq: undefined,
  removed: false,
}

export class SessionStore extends Store<SessionState> {
  constructor() {
    super(EMPTY)
  }

  reset(): void {
    this.setState(EMPTY)
  }

  /** The route names a session the PC no longer mirrors. */
  markRemoved(): void {
    const state = this.getState()
    if (state.removed) return
    this.setState({ ...state, removed: true })
  }

  applySnapshot(frame: SessionSnapshotFrame): SessionApplyResult {
    const snapshot: MobileSessionSnapshot = frame.session
    this.setState({
      ref: snapshot.summary.ref,
      summary: snapshot.summary,
      timeline: snapshot.timeline,
      plan: snapshot.plan,
      configOptions: snapshot.configOptions,
      availableCommands: snapshot.availableCommands,
      usage: snapshot.usage,
      pendingPermission: snapshot.pendingPermission,
      pendingElicitation: snapshot.pendingElicitation,
      permissionCleared: undefined,
      draft: snapshot.draft,
      draftRevision: snapshot.draft?.revision ?? 0,
      lastDraftAck: undefined,
      isReplayingHistory: snapshot.isReplayingHistory,
      truncated: snapshot.truncated === true,
      seq: frame.seq,
      removed: false,
    })
    return { status: 'applied' }
  }

  applyDelta(
    frame: SessionDeltaFrame,
    logger: Pick<Console, 'warn'> = console,
  ): SessionApplyResult {
    const state = this.getState()
    if (state.removed) return { status: 'ignored' }
    if (state.seq === undefined) {
      return { status: 'resubscribe', reason: 'missing_snapshot' }
    }
    if (state.ref !== undefined && !refMatches(state.ref, frame.ref)) {
      return { status: 'ignored' }
    }
    const expected = state.seq + 1
    if (frame.seq < expected) return { status: 'resubscribe', reason: 'seq_regression' }
    if (frame.seq > expected) return { status: 'resubscribe', reason: 'seq_gap' }

    let next: SessionState = state
    for (const event of frame.events) {
      next = applyEvent(next, event, logger)
    }
    const summary = next.summary
    this.setState({ ...next, seq: frame.seq, ref: summary?.ref ?? frame.ref })
    return { status: 'applied' }
  }

  applyRemoved(ref: MobileSessionRef): boolean {
    const state = this.getState()
    if (state.ref === undefined || !refMatches(state.ref, ref)) return false
    if (state.removed) return true
    this.setState({
      ...state,
      removed: true,
      pendingPermission: undefined,
      pendingElicitation: undefined,
    })
    return true
  }
}

function applyEvent(
  state: SessionState,
  event: MobileSessionEvent,
  logger: Pick<Console, 'warn'>,
): SessionState {
  switch (event.type) {
    case 'message_upsert':
      return { ...state, timeline: upsertMessage(state.timeline, event) }
    case 'tool_call_upsert':
      return { ...state, timeline: upsertTimelineItem(state.timeline, event.item) }
    case 'timeline_item_added':
      return { ...state, timeline: upsertTimelineItem(state.timeline, event.item) }
    case 'timeline_item_removed':
      return { ...state, timeline: state.timeline.filter((item) => item.id !== event.id) }
    case 'plan_snapshot':
      return { ...state, plan: event.plan }
    case 'config_options_snapshot':
      return { ...state, configOptions: event.options }
    case 'available_commands_snapshot':
      return { ...state, availableCommands: event.commands }
    case 'usage_changed':
      return { ...state, usage: event.usage }
    case 'summary_changed':
      return { ...state, summary: event.summary, ref: event.summary.ref }
    case 'permission_upsert':
      return { ...state, pendingPermission: event.permission, permissionCleared: undefined }
    case 'permission_cleared':
      return {
        ...state,
        pendingPermission: undefined,
        permissionCleared: {
          requestId: event.requestId,
          reason: event.reason,
          source: event.source,
        },
      }
    case 'elicitation_upsert':
      return { ...state, pendingElicitation: event.elicitation }
    case 'elicitation_cleared':
      return { ...state, pendingElicitation: undefined }
    case 'draft_update': {
      // The gateway only attaches `clientUpdateId` to the connection that sent
      // the update: this is our own echo, an ack, and must never rewrite the
      // composer. It still advances the revision watermark.
      if (event.clientUpdateId !== undefined) {
        return {
          ...state,
          draft: event.draft.revision >= state.draftRevision ? event.draft : state.draft,
          draftRevision: Math.max(state.draftRevision, event.draft.revision),
          lastDraftAck: {
            clientUpdateId: event.clientUpdateId,
            revision: event.draft.revision,
          },
        }
      }
      // The gateway owns the revision order; an out-of-order or stale update
      // must not roll the composer back to older text.
      if (event.draft.revision <= state.draftRevision) return state
      return { ...state, draft: event.draft, draftRevision: event.draft.revision }
    }
    default: {
      const unknown = event as { readonly type?: unknown }
      logger.warn(`mobile session: ignoring unknown event ${String(unknown.type)}`)
      return state
    }
  }
}

function upsertMessage(
  timeline: readonly MobileTimelineItem[],
  event: MobileMessageUpsertEvent,
): readonly MobileTimelineItem[] {
  const index = timeline.findIndex((item) => item.kind === 'message' && item.id === event.id)
  if (index === -1) {
    const text = event.textReplace ?? event.textAppend ?? ''
    return [...timeline, buildMessage(event, text)]
  }
  const existing = timeline[index] as MobileTimelineMessageItem
  const text =
    event.textReplace !== undefined ? event.textReplace : existing.text + (event.textAppend ?? '')
  const next = [...timeline]
  next[index] = buildMessage(event, text, existing)
  return next
}

function buildMessage(
  event: MobileMessageUpsertEvent,
  text: string,
  existing?: MobileTimelineMessageItem,
): MobileTimelineMessageItem {
  const attachments = event.attachments ?? existing?.attachments ?? []
  const images = event.images ?? existing?.images ?? []
  // A suffix append carries no anchor fields; preserve them from the existing
  // row. An explicit `canFork: false` must win over the previous `true`.
  const messageId = event.messageId ?? existing?.messageId
  const canFork = event.canFork ?? existing?.canFork
  return {
    kind: 'message',
    id: event.id,
    role: event.role,
    text,
    streaming: event.streaming,
    ...(event.memoryTrimmed === true ? { memoryTrimmed: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(event.hasNonText === true ? { hasNonText: true } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(canFork !== undefined ? { canFork } : {}),
  }
}

function upsertTimelineItem(
  timeline: readonly MobileTimelineItem[],
  item: MobileTimelineItem,
): readonly MobileTimelineItem[] {
  const index = timeline.findIndex((candidate) => candidate.id === item.id)
  if (index === -1) return [...timeline, item]
  if (timeline[index] === item) return timeline
  const next = [...timeline]
  next[index] = item
  return next
}
