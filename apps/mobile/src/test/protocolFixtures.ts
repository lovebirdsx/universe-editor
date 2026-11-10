import type {
  MobileSessionRef,
  MobileSessionSnapshot,
  MobileSessionSummary,
  MobileTimelineMessageItem,
  MobileTimelineToolCallItem,
  SessionDeltaFrame,
  SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'

export function sessionRef(localId = 's1', windowId = 1, durableId?: string): MobileSessionRef {
  return { windowId, localId, ...(durableId !== undefined ? { durableId } : {}) }
}

export function sessionSummary(
  localId = 's1',
  overrides: Partial<MobileSessionSummary> = {},
): MobileSessionSummary {
  return {
    ref: sessionRef(localId),
    agentId: 'echo',
    title: `Session ${localId}`,
    status: 'running',
    displayStatus: 'working',
    bucket: 'in_progress',
    workspaceName: 'demo-workspace',
    readOnly: false,
    hasPendingPermission: false,
    hasPendingElicitation: false,
    backgroundTaskCount: 0,
    updatedAt: 1_000,
    ...overrides,
  }
}

export function sessionSnapshot(
  seq: number,
  overrides: Partial<MobileSessionSnapshot> = {},
): MobileSessionSnapshot {
  return {
    seq,
    summary: sessionSummary(),
    timeline: [],
    plan: [],
    configOptions: [],
    availableCommands: [],
    isReplayingHistory: false,
    ...overrides,
  }
}

export function sessionSnapshotFrame(
  seq: number,
  overrides: Partial<MobileSessionSnapshot> = {},
): SessionSnapshotFrame {
  return { type: 'session_snapshot', seq, session: sessionSnapshot(seq, overrides) }
}

export function sessionDeltaFrame(
  seq: number,
  events: SessionDeltaFrame['events'],
  ref: MobileSessionRef = sessionRef(),
): SessionDeltaFrame {
  return { type: 'session_delta', seq, ref, events }
}

export function userMessage(id: string, text: string): MobileTimelineMessageItem {
  return { kind: 'message', id, role: 'user', text, streaming: false }
}

export function agentMessage(
  id: string,
  text: string,
  streaming = false,
): MobileTimelineMessageItem {
  return { kind: 'message', id, role: 'agent', text, streaming }
}

export function toolCall(
  id: string,
  overrides: Partial<MobileTimelineToolCallItem> = {},
): MobileTimelineToolCallItem {
  return {
    kind: 'toolCall',
    id,
    title: `Tool ${id}`,
    toolKind: 'execute',
    status: 'completed',
    hasDetail: true,
    ...overrides,
  }
}
