import { describe, expect, it } from 'vitest'
import type { ClientFrame, ParseErrorCode, Result, ServerFrame } from '../index.js'
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_INDEX,
  MAX_SERVER_FRAME_BYTES,
  MAX_TOKEN_LENGTH,
  MAX_WEB_BUILD_ID_LENGTH,
  MOBILE_CLOSE_CODES,
  MOBILE_PROTOCOL_VERSION,
  isMobileErrorCode,
  parseClientFrame,
  parsePairRequest,
  parseServerFrame,
  serializeFrame,
} from '../index.js'

function errorCode<T>(result: Result<T>): ParseErrorCode | undefined {
  return result.ok ? undefined : result.error.code
}

function helloJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    token: 'device-token',
    clientVersion: '0.1.0',
    capabilities: [],
    ...overrides,
  })
}

function helloOkJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello_ok',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    serverVersion: '0.1.0',
    deviceId: 'device-1',
    trusted: false,
    serverTime: 1_700_000_000_000,
    capabilities: [],
    ...overrides,
  })
}

const REF = { windowId: 3, localId: 'local-1' }
const DURABLE_REF = { windowId: 3, localId: 'local-1', durableId: 'durable-1' }

function summaryJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: REF,
    agentId: 'claude',
    agentName: 'Claude',
    title: 'Fix the tests',
    status: 'running',
    displayStatus: 'working',
    bucket: 'in_progress',
    workspaceName: 'universe-editor',
    cwd: '/workspace/universe-editor',
    authority: 'local',
    readOnly: false,
    hasPendingPermission: false,
    hasPendingElicitation: false,
    backgroundTaskCount: 0,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function snapshotJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 2,
    summary: summaryJson(),
    timeline: [
      {
        kind: 'message',
        id: 'msg-1',
        role: 'user',
        text: 'hello',
        streaming: false,
      },
      {
        kind: 'toolCall',
        id: 'tool-1',
        title: 'Edit file',
        toolKind: 'edit',
        status: 'completed',
        preview: 'diff --git',
        hasDetail: true,
        diffs: [{ path: '/workspace/a.ts', added: 2, removed: 1 }],
        locations: [{ path: '/workspace/a.ts', line: 4 }],
      },
      {
        kind: 'notice',
        id: 'notice-1',
        noticeKind: 'compaction',
        phase: 'success',
        text: 'compacted',
      },
    ],
    plan: [{ content: 'Write tests', status: 'in_progress', priority: 'high' }],
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'Claude',
        allowedOnMobile: true,
        options: [
          { value: 'sonnet', label: 'Claude', allowedOnMobile: true },
          { value: 'bypassPermissions', label: 'Bypass', allowedOnMobile: false },
        ],
      },
    ],
    availableCommands: [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'instructions' },
      { name: 'mcp:github:review', description: 'Review a PR' },
    ],
    usage: { used: 100, size: 1000, cost: { amount: 0.02, currency: 'USD' }, costEstimated: true },
    pendingPermission: {
      requestId: 'perm-1',
      toolCallId: 'tool-2',
      title: 'Run command',
      kind: 'execute',
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once', allowedOnMobile: true },
        { optionId: 'allow-always', name: 'Always', kind: 'allow_always', allowedOnMobile: false },
      ],
      autoResolve: { optionId: 'allow', deadlineAt: 1_700_000_100_000, paused: false },
    },
    pendingElicitation: {
      requestId: 'elic-1',
      mode: 'form',
      message: 'Pick a value',
      title: 'Configure',
      toolCallId: 'tool-2',
      fields: [
        {
          name: 'choice',
          kind: 'enum',
          required: true,
          options: [{ value: 'a', title: 'A' }],
        },
      ],
    },
    isReplayingHistory: false,
    ...overrides,
  }
}

describe('parseClientFrame', () => {
  it('parses hello', () => {
    const payload = {
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token: 'device-token',
      clientVersion: '0.1.0',
      capabilities: ['inbox', 'push'],
    }
    expect(parseClientFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })
  })

  it('parses ping', () => {
    expect(parseClientFrame('{"type":"ping","t":42}')).toStrictEqual({
      ok: true,
      value: { type: 'ping', t: 42 },
    })
  })

  it('parses inbox subscription frames', () => {
    expect(parseClientFrame('{"type":"subscribe_inbox"}')).toStrictEqual({
      ok: true,
      value: { type: 'subscribe_inbox' },
    })
    expect(parseClientFrame('{"type":"subscribe_inbox","afterSeq":0}')).toStrictEqual({
      ok: true,
      value: { type: 'subscribe_inbox', afterSeq: 0 },
    })
    expect(parseClientFrame('{"type":"unsubscribe_inbox"}')).toStrictEqual({
      ok: true,
      value: { type: 'unsubscribe_inbox' },
    })
  })

  it('parses session subscription frames', () => {
    expect(
      parseClientFrame(
        JSON.stringify({ type: 'subscribe_session', ref: DURABLE_REF, afterSeq: 4 }),
      ),
    ).toStrictEqual({
      ok: true,
      value: { type: 'subscribe_session', ref: DURABLE_REF, afterSeq: 4 },
    })
    expect(parseClientFrame(JSON.stringify({ type: 'subscribe_session', ref: REF }))).toStrictEqual(
      {
        ok: true,
        value: { type: 'subscribe_session', ref: REF },
      },
    )
    expect(
      parseClientFrame(JSON.stringify({ type: 'unsubscribe_session', ref: REF })),
    ).toStrictEqual({
      ok: true,
      value: { type: 'unsubscribe_session', ref: REF },
    })
  })

  it('parses command frames, keeping unknown kinds for not_supported replies', () => {
    const payload = {
      type: 'command',
      requestId: 'req-1',
      kind: 'getToolCallDetail',
      payload: { ref: REF, toolCallId: 'tool-1' },
    }
    expect(parseClientFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })

    const unknown = {
      type: 'command',
      requestId: 'req-2',
      kind: 'futureCommand',
      payload: { anything: true },
    }
    expect(parseClientFrame(JSON.stringify(unknown))).toStrictEqual({ ok: true, value: unknown })
  })

  it('validates M3 command payloads and the idempotency key', () => {
    const commands: Array<Record<string, unknown>> = [
      { kind: 'sendPrompt', payload: { ref: REF, text: 'hello' } },
      {
        kind: 'sendPrompt',
        payload: { ref: REF, text: '', attachmentIds: ['a1', 'a2'] },
      },
      { kind: 'sendPrompt', payload: { ref: REF, text: '', draftImageIds: ['img-1'] } },
      {
        kind: 'sendPrompt',
        payload: { ref: REF, text: '', draftImageIds: ['img-1'], draftFileIds: ['file-1'] },
      },
      { kind: 'cancelTurn', payload: { ref: REF } },
      {
        kind: 'resolvePermission',
        payload: { ref: REF, requestId: 'perm-1', optionId: 'allow-once', feedback: 'go' },
      },
      { kind: 'cancelPermission', payload: { ref: REF, requestId: 'perm-1' } },
      {
        kind: 'resolveElicitation',
        payload: {
          ref: REF,
          requestId: 'elic-1',
          action: 'accept',
          content: { answer: 'yes', count: 2, ok: true, tags: ['a'] },
        },
      },
      { kind: 'setConfigOption', payload: { ref: REF, configId: 'mode', value: 'plan' } },
      { kind: 'setConfigOption', payload: { ref: REF, configId: 'flag', value: true } },
      { kind: 'pauseAutoResolve', payload: { ref: REF, requestId: 'perm-1' } },
      { kind: 'resumeAutoResolve', payload: { ref: REF, requestId: 'perm-1' } },
      {
        kind: 'newSession',
        payload: {
          agentId: 'claude-code',
          workspace: { folder: 'file:///workspace/demo', authority: 'host' },
          initialPrompt: 'start',
        },
      },
      { kind: 'renameSession', payload: { ref: REF, title: 'Renamed' } },
      { kind: 'closeSession', payload: { ref: REF } },
      { kind: 'deleteSession', payload: { ref: REF } },
      { kind: 'deleteHistorySession', payload: { durableId: 'durable-1' } },
      { kind: 'deleteHistorySession', payload: { durableId: 'durable-1', windowId: 2 } },
      { kind: 'forkSession', payload: { ref: REF } },
      { kind: 'forkSession', payload: { ref: REF, messageId: 'msg-user-1' } },
      { kind: 'previewRewind', payload: { ref: REF, messageId: 'msg-user-1' } },
      { kind: 'rewindSession', payload: { ref: REF, messageId: 'msg-user-1' } },
      { kind: 'rewindSession', payload: { ref: REF, messageId: 'msg-user-1', rewindFiles: false } },
      { kind: 'createSideTask', payload: { ref: REF } },
      { kind: 'createSideTask', payload: { ref: REF, quote: 'what changed here?' } },
      { kind: 'listSideTasks', payload: { ref: REF } },
      { kind: 'openSideTask', payload: { ref: REF, sideTaskId: 'durable-side-1' } },
      { kind: 'deleteSideTask', payload: { ref: REF, sideTaskId: 'durable-side-1' } },
      { kind: 'listWorkspaces', payload: {} },
      { kind: 'listAgents', payload: {} },
      { kind: 'listSessionHistory', payload: {} },
      { kind: 'openSession', payload: { durableId: 'durable-1' } },
      { kind: 'openSession', payload: { durableId: 'durable-1', windowId: 2 } },
      {
        kind: 'openSession',
        payload: {
          durableId: 'durable-1',
          folder: 'file:///workspace/demo',
          authority: 'host',
        },
      },
      { kind: 'previewPushBranch', payload: { ref: REF } },
      {
        kind: 'pushBranch',
        payload: {
          ref: REF,
          expectation: {
            branch: 'feature',
            head: 'abc123',
            remote: 'origin',
            remoteBranch: 'feature',
          },
        },
      },
      {
        kind: 'pushBranch',
        payload: {
          ref: REF,
          expectation: {
            branch: 'feature',
            head: 'abc123',
            remote: 'origin',
            remoteBranch: 'tasks/feature',
            remoteHead: 'def456',
          },
        },
      },
    ]
    for (const command of commands) {
      const frame = {
        type: 'command',
        requestId: 'req',
        idempotencyKey: 'idem-1',
        ...command,
      }
      expect(parseClientFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
    }
  })

  it('rejects malformed M3 command payloads', () => {
    const bad: Array<Record<string, unknown>> = [
      { kind: 'sendPrompt', payload: { ref: REF, text: 'x'.repeat(32 * 1024 + 1) } },
      { kind: 'sendPrompt', payload: { ref: REF, text: 3 } },
      { kind: 'sendPrompt', payload: { ref: REF, text: '   ' } },
      { kind: 'sendPrompt', payload: { ref: REF, text: 'hi', attachmentIds: 'a1' } },
      { kind: 'sendPrompt', payload: { ref: REF, text: 'hi', attachmentIds: ['a1', 'a1'] } },
      {
        kind: 'sendPrompt',
        payload: {
          ref: REF,
          text: '',
          attachmentIds: Array.from({ length: 9 }, (_, i) => `a${i}`),
        },
      },
      { kind: 'sendPrompt', payload: { ref: REF, text: '', attachmentIds: [''] } },
      { kind: 'sendPrompt', payload: { ref: REF, text: '', draftImageIds: 'img-1' } },
      { kind: 'sendPrompt', payload: { ref: REF, text: '', draftFileIds: ['file-1', 'file-1'] } },
      { kind: 'sendPrompt', payload: { ref: REF, text: '', draftImageIds: ['img-1', 'img-1'] } },
      { kind: 'resolvePermission', payload: { ref: REF, optionId: 'allow' } },
      {
        kind: 'resolveElicitation',
        payload: { ref: REF, requestId: 'e', action: 'maybe' },
      },
      {
        kind: 'resolveElicitation',
        payload: { ref: REF, requestId: 'e', action: 'accept', content: { a: { nested: true } } },
      },
      { kind: 'setConfigOption', payload: { ref: REF, configId: 'mode', value: {} } },
      { kind: 'newSession', payload: { agentId: '', workspace: { folder: '' } } },
      { kind: 'renameSession', payload: { ref: REF, title: '' } },
      { kind: 'forkSession', payload: { ref: REF, messageId: '' } },
      { kind: 'forkSession', payload: { ref: REF, messageId: 3 } },
      { kind: 'previewRewind', payload: { ref: REF } },
      { kind: 'previewRewind', payload: { ref: REF, messageId: '' } },
      { kind: 'rewindSession', payload: { ref: REF, messageId: 'msg-1', rewindFiles: 'no' } },
      { kind: 'createSideTask', payload: { ref: REF, quote: 'x'.repeat(8001) } },
      { kind: 'createSideTask', payload: { ref: REF, quote: 7 } },
      { kind: 'openSideTask', payload: { ref: REF } },
      { kind: 'openSideTask', payload: { ref: REF, sideTaskId: '' } },
      { kind: 'deleteSideTask', payload: { ref: REF, sideTaskId: 1 } },
      { kind: 'listSideTasks', payload: 'nope' },
      { kind: 'listWorkspaces', payload: 'nope' },
      { kind: 'listSessionHistory', payload: 'nope' },
      { kind: 'openSession', payload: {} },
      { kind: 'openSession', payload: { durableId: '' } },
      { kind: 'openSession', payload: { durableId: 'durable-1', windowId: -1 } },
      { kind: 'openSession', payload: { durableId: 'durable-1', windowId: 1.5 } },
      { kind: 'openSession', payload: { durableId: 'durable-1', folder: '' } },
      { kind: 'openSession', payload: { durableId: 'durable-1', folder: 3 } },
      { kind: 'openSession', payload: { durableId: 'durable-1', authority: 3 } },
      { kind: 'deleteHistorySession', payload: {} },
      { kind: 'deleteHistorySession', payload: { durableId: '' } },
      { kind: 'deleteHistorySession', payload: { durableId: 'durable-1', windowId: -1 } },
      { kind: 'deleteHistorySession', payload: { durableId: 'durable-1', windowId: 1.5 } },
      { kind: 'deleteHistorySession', payload: 'nope' },
      { kind: 'previewPushBranch', payload: {} },
      { kind: 'pushBranch', payload: { ref: REF } },
      {
        kind: 'pushBranch',
        payload: {
          ref: REF,
          expectation: { branch: '', head: 'abc', remote: 'origin', remoteBranch: 'feature' },
        },
      },
      {
        kind: 'pushBranch',
        payload: {
          ref: REF,
          expectation: {
            branch: 'feature',
            head: 'abc',
            remote: 'origin',
            remoteBranch: 'feature',
            remoteHead: '',
          },
        },
      },
    ]
    for (const command of bad) {
      expect(
        errorCode(
          parseClientFrame(JSON.stringify({ type: 'command', requestId: 'r', ...command })),
        ),
      ).toBe('bad_request')
    }
  })

  it('rejects non-JSON and non-object payloads', () => {
    expect(errorCode(parseClientFrame('not json'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('[]'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('null'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('42'))).toBe('bad_request')
  })

  it('rejects missing and unknown frame types', () => {
    expect(errorCode(parseClientFrame('{}'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('{"type":42}'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('{"type":"unknown"}'))).toBe('bad_request')
  })

  it('reports protocol mismatch separately from malformed fields', () => {
    expect(
      errorCode(parseClientFrame(helloJson({ protocolVersion: MOBILE_PROTOCOL_VERSION + 1 }))),
    ).toBe('protocol_mismatch')
    expect(errorCode(parseClientFrame(helloJson({ protocolVersion: '1' })))).toBe('bad_request')
    expect(errorCode(parseClientFrame(helloJson({ protocolVersion: -1 })))).toBe('bad_request')
  })

  it('enforces hello string limits', () => {
    expect(errorCode(parseClientFrame(helloJson({ token: '' })))).toBe('bad_request')
    expect(
      errorCode(parseClientFrame(helloJson({ token: 'x'.repeat(MAX_TOKEN_LENGTH + 1) }))),
    ).toBe('bad_request')
    expect(errorCode(parseClientFrame(helloJson({ clientVersion: 'x'.repeat(65) })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseClientFrame(helloJson({ clientVersion: 1 })))).toBe('bad_request')
  })

  it('enforces hello capabilities', () => {
    expect(errorCode(parseClientFrame(helloJson({ capabilities: 'inbox' })))).toBe('bad_request')
    expect(errorCode(parseClientFrame(helloJson({ capabilities: [1] })))).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(helloJson({ capabilities: Array.from({ length: 33 }, () => 'x') })),
      ),
    ).toBe('bad_request')
  })

  it('validates ping and subscription fields', () => {
    expect(errorCode(parseClientFrame('{"type":"ping","t":"1"}'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('{"type":"subscribe_inbox","afterSeq":-1}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseClientFrame('{"type":"subscribe_inbox","afterSeq":1.5}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseClientFrame('{"type":"subscribe_session","ref":{"windowId":1}}'))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseClientFrame(
          JSON.stringify({ type: 'subscribe_session', ref: { windowId: 1, localId: '' } }),
        ),
      ),
    ).toBe('bad_request')
  })

  it('validates command fields', () => {
    expect(
      errorCode(
        parseClientFrame(
          JSON.stringify({ type: 'command', requestId: '', kind: 'getToolCallDetail' }),
        ),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(
          JSON.stringify({
            type: 'command',
            requestId: 'r',
            kind: 'getToolCallDetail',
            payload: { ref: REF },
          }),
        ),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(
          JSON.stringify({
            type: 'command',
            requestId: 'r',
            kind: 'getToolCallDetail',
            payload: { ref: REF, toolCallId: '' },
          }),
        ),
      ),
    ).toBe('bad_request')
  })

  it('rejects frames larger than the client limit', () => {
    expect(errorCode(parseClientFrame('x'.repeat(MAX_CLIENT_FRAME_BYTES + 1)))).toBe('bad_request')
  })

  it('parses draft_update and rejects phone-authored refs/contexts', () => {
    const frame = {
      type: 'draft_update',
      ref: DURABLE_REF,
      clientUpdateId: 'update-1',
      draft: {
        text: 'hello @src/a.ts',
        images: [{ id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 12, name: 'a.png' }],
        files: [{ id: 'file-1', name: 'notes.txt', byteSize: 4 }],
      },
    }
    expect(parseClientFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
    expect(
      errorCode(
        parseClientFrame(JSON.stringify({ ...frame, draft: { ...frame.draft, refs: [] } })),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(JSON.stringify({ ...frame, draft: { ...frame.draft, contexts: [] } })),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(
          JSON.stringify({
            ...frame,
            draft: {
              ...frame.draft,
              images: [
                { id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 12 },
                { id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 12 },
              ],
            },
          }),
        ),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(
          JSON.stringify({
            ...frame,
            draft: {
              ...frame.draft,
              images: [{ id: 'img-1', source: 'pc', mimeType: 'image/svg+xml', byteSize: 12 }],
            },
          }),
        ),
      ),
    ).toBe('bad_request')
  })
})

describe('parseServerFrame', () => {
  it('parses hello_ok', () => {
    const payload = {
      type: 'hello_ok',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      serverVersion: '0.1.0',
      deviceId: 'device-1',
      trusted: false,
      serverTime: 1_700_000_000_000,
      capabilities: ['inbox'],
    }
    expect(parseServerFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })
  })

  it('parses hello_ok.webBuildId and rejects values that are not bounded strings', () => {
    expect(parseServerFrame(helloOkJson({ webBuildId: 'index-_PQNuEOX.js' }))).toStrictEqual({
      ok: true,
      value: {
        type: 'hello_ok',
        protocolVersion: MOBILE_PROTOCOL_VERSION,
        serverVersion: '0.1.0',
        deviceId: 'device-1',
        trusted: false,
        serverTime: 1_700_000_000_000,
        capabilities: [],
        webBuildId: 'index-_PQNuEOX.js',
      },
    })
    expect(errorCode(parseServerFrame(helloOkJson({ webBuildId: 42 })))).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(helloOkJson({ webBuildId: 'x'.repeat(MAX_WEB_BUILD_ID_LENGTH + 1) })),
      ),
    ).toBe('bad_request')
  })

  it('parses hello_ok.notificationPrefs and rejects malformed values', () => {
    const prefs = { enabled: true, kinds: ['permission', 'question'], alwaysNotify: true }
    expect(parseServerFrame(helloOkJson({ notificationPrefs: prefs }))).toStrictEqual({
      ok: true,
      value: {
        type: 'hello_ok',
        protocolVersion: MOBILE_PROTOCOL_VERSION,
        serverVersion: '0.1.0',
        deviceId: 'device-1',
        trusted: false,
        serverTime: 1_700_000_000_000,
        capabilities: [],
        notificationPrefs: prefs,
      },
    })
    expect(
      parseServerFrame(helloOkJson({ notificationPrefs: { enabled: false, alwaysNotify: false } })),
    ).toMatchObject({
      ok: true,
      value: { notificationPrefs: { enabled: false, alwaysNotify: false } },
    })
    for (const notificationPrefs of [
      null,
      { enabled: 'yes' },
      { enabled: true, alwaysNotify: 'yes' },
      { enabled: true, kinds: ['bogus'] },
      { enabled: true, kinds: ['permission', 'permission', 'question', 'completed', 'errored'] },
    ]) {
      expect(errorCode(parseServerFrame(helloOkJson({ notificationPrefs })))).toBe('bad_request')
    }
  })

  it('rejects hello_ok without a boolean trusted flag', () => {
    expect(errorCode(parseServerFrame(helloOkJson({ trusted: undefined })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(helloOkJson({ trusted: 'yes' })))).toBe('bad_request')
  })

  it('parses device_trust_changed and rejects a non-boolean flag', () => {
    expect(parseServerFrame('{"type":"device_trust_changed","trusted":true}')).toStrictEqual({
      ok: true,
      value: { type: 'device_trust_changed', trusted: true },
    })
    expect(errorCode(parseServerFrame('{"type":"device_trust_changed","trusted":"yes"}'))).toBe(
      'bad_request',
    )
  })

  it('parses pong and device_revoked', () => {
    expect(parseServerFrame('{"type":"pong","t":42}')).toStrictEqual({
      ok: true,
      value: { type: 'pong', t: 42 },
    })
    expect(parseServerFrame('{"type":"device_revoked"}')).toStrictEqual({
      ok: true,
      value: { type: 'device_revoked' },
    })
  })

  it('parses inbox snapshots and deltas', () => {
    const snapshot = {
      type: 'inbox_snapshot',
      seq: 7,
      sessions: [summaryJson(), summaryJson({ ref: DURABLE_REF, bucket: 'completed' })],
    }
    expect(parseServerFrame(JSON.stringify(snapshot))).toStrictEqual({
      ok: true,
      value: snapshot,
    })

    const delta = {
      type: 'inbox_delta',
      seq: 8,
      upserts: [summaryJson({ title: 'Renamed' })],
      removes: [DURABLE_REF],
    }
    expect(parseServerFrame(JSON.stringify(delta))).toStrictEqual({ ok: true, value: delta })
  })

  it('parses a full session snapshot', () => {
    const frame = { type: 'session_snapshot', seq: 2, session: snapshotJson() }
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
  })

  it('parses a session snapshot with a shared draft', () => {
    const draft = {
      text: 'hello',
      images: [{ id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 12 }],
      files: [{ id: 'file-1', name: 'a.txt', byteSize: 2 }],
      refs: [{ id: 'ref-1', kind: 'file', label: 'src/a.ts', start: 0, end: 5 }],
      contexts: [{ relPath: 'src/a.ts', startLine: 1, endLine: 2, languageId: 'typescript' }],
      revision: 4,
      updatedAt: 1_700_000_000_000,
      source: 'pc',
    }
    const frame = { type: 'session_snapshot', seq: 2, session: snapshotJson({ draft }) }
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
    expect(
      errorCode(
        parseServerFrame(
          JSON.stringify({
            ...frame,
            session: snapshotJson({ draft: { ...draft, source: 'phone' } }),
          }),
        ),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(
          JSON.stringify({
            ...frame,
            session: snapshotJson({
              draft: {
                ...draft,
                refs: [{ id: 'ref-1', kind: 'file', label: 'x', start: 4, end: 2 }],
              },
            }),
          }),
        ),
      ),
    ).toBe('bad_request')
  })

  it('parses a draft_update session delta event', () => {
    const draft = {
      text: 'hi',
      images: [],
      revision: 5,
      updatedAt: 1_700_000_000_000,
      source: 'mobile',
    }
    const frame = {
      type: 'session_delta',
      seq: 9,
      ref: DURABLE_REF,
      events: [{ type: 'draft_update', draft, clientUpdateId: 'update-1' }],
    }
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
    expect(
      errorCode(
        parseServerFrame(
          JSON.stringify({
            ...frame,
            events: [{ type: 'draft_update', draft: { ...draft, source: 'phone' } }],
          }),
        ),
      ),
    ).toBe('bad_request')
  })

  it('parses a minimal session snapshot without optional fields', () => {
    const session = snapshotJson({
      timeline: [],
      plan: [],
      configOptions: [],
      availableCommands: [],
      usage: undefined,
      pendingPermission: undefined,
      pendingElicitation: undefined,
      truncated: true,
    })
    const frame = { type: 'session_snapshot', seq: 2, session }
    const expected = JSON.parse(JSON.stringify(frame)) as unknown
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: expected })
  })

  it('parses every session delta event kind', () => {
    const events = [
      {
        type: 'message_upsert',
        id: 'msg-1',
        role: 'agent',
        textAppend: ' world',
        streaming: true,
      },
      {
        type: 'tool_call_upsert',
        item: {
          kind: 'toolCall',
          id: 'tool-1',
          title: 'Edit file',
          toolKind: 'edit',
          status: 'in_progress',
          hasDetail: true,
        },
      },
      {
        type: 'timeline_item_added',
        item: { kind: 'message', id: 'msg-2', role: 'user', text: 'hi', streaming: false },
      },
      { type: 'timeline_item_removed', id: 'msg-2' },
      { type: 'plan_snapshot', plan: [{ content: 'Step', status: 'completed' }] },
      {
        type: 'config_options_snapshot',
        options: [
          {
            id: 'model',
            name: 'Model',
            type: 'boolean',
            currentValue: 'On',
            allowedOnMobile: true,
          },
        ],
      },
      {
        type: 'available_commands_snapshot',
        commands: [
          { name: 'compact', description: 'Compact the conversation', inputHint: 'instructions' },
          { name: 'status', description: 'Show status' },
        ],
      },
      { type: 'summary_changed', summary: summaryJson({ bucket: 'input_needed' }) },
      {
        type: 'permission_upsert',
        permission: {
          requestId: 'perm-1',
          toolCallId: 'tool-1',
          title: 'Run',
          options: [{ optionId: 'yes', name: 'Yes', allowedOnMobile: true }],
        },
      },
      {
        type: 'permission_cleared',
        requestId: 'perm-1',
        reason: 'selected',
        source: 'mobile',
      },
      {
        type: 'elicitation_upsert',
        elicitation: { requestId: 'elic-1', mode: 'url', message: 'Open this', title: 'Auth' },
      },
      { type: 'elicitation_cleared' },
    ]
    const frame = { type: 'session_delta', seq: 9, ref: DURABLE_REF, events }
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
  })

  it('parses only-message flags on tool calls', () => {
    const toolCall = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: 'toolCall',
      id: 'tool-1',
      title: 'Task',
      toolKind: 'think',
      status: 'completed',
      hasDetail: true,
      ...overrides,
    })
    const snapshot = (item: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'session_snapshot',
        seq: 1,
        session: snapshotJson({ timeline: [item] }),
      })

    const parsed = parseServerFrame(
      snapshot(toolCall({ subagent: true, requiresUserDecision: true })),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        type: 'session_snapshot',
        session: {
          timeline: [{ kind: 'toolCall', subagent: true, requiresUserDecision: true }],
        },
      })
    }

    const delta = {
      type: 'session_delta',
      seq: 1,
      ref: REF,
      events: [{ type: 'tool_call_upsert', item: toolCall({ subagent: true }) }],
    }
    expect(parseServerFrame(JSON.stringify(delta))).toStrictEqual({ ok: true, value: delta })

    const plain = parseServerFrame(snapshot(toolCall()))
    expect(plain.ok).toBe(true)
    if (plain.ok) {
      const timeline = (
        plain.value as unknown as {
          session: { timeline: Array<Record<string, unknown>> }
        }
      ).session.timeline
      expect(timeline[0]).not.toHaveProperty('subagent')
      expect(timeline[0]).not.toHaveProperty('requiresUserDecision')
    }

    expect(errorCode(parseServerFrame(snapshot(toolCall({ subagent: 'yes' }))))).toBe('bad_request')
    expect(errorCode(parseServerFrame(snapshot(toolCall({ requiresUserDecision: 1 }))))).toBe(
      'bad_request',
    )
  })

  it('parses tool-call activity timing fields', () => {
    const toolCall = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: 'toolCall',
      id: 'tool-1',
      title: 'Bash',
      toolKind: 'execute',
      status: 'completed',
      hasDetail: true,
      ...overrides,
    })
    const snapshot = (item: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'session_snapshot',
        seq: 1,
        session: snapshotJson({ timeline: [item] }),
      })

    const timing = {
      startedAt: 1_700_000_000_000,
      durationMs: 5_000,
      settleReason: 'cancelled',
      syntheticDenial: true,
    }
    const parsed = parseServerFrame(snapshot(toolCall(timing)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        type: 'session_snapshot',
        session: { timeline: [timing] },
      })
    }

    const delta = {
      type: 'session_delta',
      seq: 1,
      ref: REF,
      events: [
        { type: 'tool_call_upsert', item: toolCall({ ...timing, startedAt: 0, durationMs: 0 }) },
      ],
    }
    expect(parseServerFrame(JSON.stringify(delta))).toStrictEqual({ ok: true, value: delta })

    const plain = parseServerFrame(snapshot(toolCall()))
    expect(plain.ok).toBe(true)
    if (plain.ok) {
      const timeline = (
        plain.value as unknown as {
          session: { timeline: Array<Record<string, unknown>> }
        }
      ).session.timeline
      expect(timeline[0]).not.toHaveProperty('startedAt')
      expect(timeline[0]).not.toHaveProperty('durationMs')
      expect(timeline[0]).not.toHaveProperty('settleReason')
      expect(timeline[0]).not.toHaveProperty('syntheticDenial')
    }

    for (const bad of [
      { startedAt: -1 },
      { startedAt: 1.5 },
      { startedAt: '5' },
      { durationMs: -1 },
      { durationMs: 1.5 },
      { settleReason: '' },
      { settleReason: 'x'.repeat(1025) },
      { syntheticDenial: 'yes' },
    ]) {
      expect(errorCode(parseServerFrame(snapshot(toolCall(bad))))).toBe('bad_request')
    }
  })

  it('parses session_removed, command_result and resync_required', () => {
    expect(
      parseServerFrame(JSON.stringify({ type: 'session_removed', ref: DURABLE_REF })),
    ).toStrictEqual({
      ok: true,
      value: { type: 'session_removed', ref: DURABLE_REF },
    })

    const result = {
      type: 'command_result',
      requestId: 'req-1',
      ok: true,
      result: {
        id: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        status: 'completed',
        text: 'done',
        diffs: [{ path: '/workspace/a.ts', oldText: 'a', newText: 'b' }],
      },
    }
    expect(parseServerFrame(JSON.stringify(result))).toStrictEqual({ ok: true, value: result })

    const resync = {
      type: 'resync_required',
      scope: 'session',
      reason: 'backpressure',
      ref: DURABLE_REF,
    }
    expect(parseServerFrame(JSON.stringify(resync))).toStrictEqual({ ok: true, value: resync })
  })

  it('parses server_error', () => {
    const payload = {
      type: 'server_error',
      code: 'stale_request',
      message: 'request is stale',
      retryable: false,
    }
    expect(parseServerFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })
  })

  it('reports server protocol mismatch', () => {
    expect(
      errorCode(parseServerFrame(helloOkJson({ protocolVersion: MOBILE_PROTOCOL_VERSION + 1 }))),
    ).toBe('protocol_mismatch')
    expect(errorCode(parseServerFrame(helloOkJson({ protocolVersion: '1' })))).toBe('bad_request')
  })

  it('rejects malformed hello_ok fields', () => {
    expect(errorCode(parseServerFrame(helloOkJson({ serverVersion: 'x'.repeat(65) })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(helloOkJson({ deviceId: '' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(helloOkJson({ serverTime: 'now' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(helloOkJson({ capabilities: [1] })))).toBe('bad_request')
  })

  it('rejects malformed pong and inbox frames', () => {
    expect(errorCode(parseServerFrame('{"type":"pong","t":"1"}'))).toBe('bad_request')
    expect(errorCode(parseServerFrame('{"type":"inbox_snapshot","seq":-1,"sessions":[]}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame('{"type":"inbox_snapshot","seq":0}'))).toBe('bad_request')
    expect(errorCode(parseServerFrame('{"type":"inbox_snapshot","seq":0,"sessions":[1]}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame('{"type":"inbox_delta","seq":1,"upserts":[]}'))).toBe(
      'bad_request',
    )
    expect(
      errorCode(parseServerFrame('{"type":"inbox_delta","seq":1,"upserts":[],"removes":[1]}')),
    ).toBe('bad_request')
  })

  it('validates session summary fields', () => {
    const withSummary = (overrides: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'inbox_snapshot',
        seq: 1,
        sessions: [summaryJson(overrides)],
      })

    expect(errorCode(parseServerFrame(withSummary({ bucket: 'unknown' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ updatedAt: 'now' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ agentId: '' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ ref: { windowId: -1, localId: 'x' } })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSummary({ ref: { windowId: 1, localId: '' } })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(withSummary({ ref: { windowId: 1, localId: 'x', durableId: 5 } })),
      ),
    ).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ readOnly: 'no' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ hasPendingPermission: 'no' })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSummary({ backgroundTaskCount: -1 })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSummary({ imageSupported: 'yes' })))).toBe('bad_request')
  })

  it('validates attachment metadata on timeline messages and upserts', () => {
    const attachment = {
      id: 'att-1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 4,
    }
    const withMessage = (overrides: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'session_snapshot',
        seq: 1,
        session: {
          ...snapshotJson(),
          timeline: [
            {
              kind: 'message',
              id: 'msg-1',
              role: 'user',
              text: '',
              streaming: false,
              ...overrides,
            },
          ],
        },
      })
    const parsed = parseServerFrame(withMessage({ attachments: [attachment] }))
    expect(parsed.ok).toBe(true)

    expect(errorCode(parseServerFrame(withMessage({ attachments: [{ id: 'a' }] })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(parseServerFrame(withMessage({ attachments: [{ ...attachment, kind: 'audio' }] }))),
    ).toBe('bad_request')
    expect(
      errorCode(parseServerFrame(withMessage({ attachments: [{ ...attachment, size: -1 }] }))),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(withMessage({ attachments: [{ ...attachment, size: 26 * 1024 * 1024 }] })),
      ),
    ).toBe('bad_request')

    const upsert = (attachments: unknown): string =>
      JSON.stringify({
        type: 'session_delta',
        seq: 2,
        ref: REF,
        events: [
          {
            type: 'message_upsert',
            id: 'msg-1',
            role: 'user',
            streaming: false,
            attachments,
          },
        ],
      })
    expect(parseServerFrame(upsert([attachment])).ok).toBe(true)
    expect(parseServerFrame(upsert([])).ok).toBe(true)
    expect(errorCode(parseServerFrame(upsert([{ ...attachment, name: '' }])))).toBe('bad_request')
  })

  it('validates message image metadata on timeline messages and upserts', () => {
    const image = { index: 0, mimeType: 'image/png', size: 4 }
    const withMessage = (overrides: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'session_snapshot',
        seq: 1,
        session: {
          ...snapshotJson(),
          timeline: [
            {
              kind: 'message',
              id: 'msg-1',
              role: 'agent',
              text: '',
              streaming: false,
              ...overrides,
            },
          ],
        },
      })
    const parsed = parseServerFrame(withMessage({ images: [image] }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.value.type === 'session_snapshot') {
      expect(parsed.value.session.timeline[0]).toMatchObject({ images: [image] })
    }

    expect(
      errorCode(parseServerFrame(withMessage({ images: [{ ...image, truncated: true }] }))),
    ).toBe(undefined)
    expect(errorCode(parseServerFrame(withMessage({ images: 'nope' })))).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(
          withMessage({ images: Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => image) }),
        ),
      ),
    ).toBe('bad_request')
    expect(errorCode(parseServerFrame(withMessage({ images: [{ ...image, index: -1 }] })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(
          withMessage({ images: [{ ...image, index: MAX_MESSAGE_IMAGE_INDEX + 1 }] }),
        ),
      ),
    ).toBe('bad_request')
    expect(errorCode(parseServerFrame(withMessage({ images: [{ ...image, mimeType: '' }] })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withMessage({ images: [{ ...image, size: -1 }] })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(
          withMessage({ images: [{ ...image, size: MAX_MESSAGE_IMAGE_BYTES + 1 }] }),
        ),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(parseServerFrame(withMessage({ images: [{ ...image, truncated: 'yes' }] }))),
    ).toBe('bad_request')

    const upsert = (images: unknown): string =>
      JSON.stringify({
        type: 'session_delta',
        seq: 2,
        ref: REF,
        events: [
          {
            type: 'message_upsert',
            id: 'msg-1',
            role: 'agent',
            streaming: false,
            images,
          },
        ],
      })
    expect(parseServerFrame(upsert([image])).ok).toBe(true)
    expect(parseServerFrame(upsert([])).ok).toBe(true)
    expect(errorCode(parseServerFrame(upsert([{ ...image, mimeType: 1 }])))).toBe('bad_request')
  })

  it('parses fork/rewind capabilities and side-task summary fields', () => {
    const summary = summaryJson({
      forkSupported: true,
      rewindSupported: false,
      sideTaskOf: 'durable-parent',
      sideTaskChildCount: 2,
    })
    const frame = { type: 'inbox_snapshot', seq: 1, sessions: [summary] }
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })

    const withSummary = (overrides: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'inbox_snapshot',
        seq: 1,
        sessions: [summaryJson(overrides)],
      })

    expect(errorCode(parseServerFrame(withSummary({ forkSupported: 'yes' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ rewindSupported: 1 })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ sideTaskOf: '' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ sideTaskOf: 3 })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ sideTaskChildCount: -1 })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ sideTaskChildCount: 1.5 })))).toBe(
      'bad_request',
    )
  })

  it('parses message anchors and fork eligibility', () => {
    const message = {
      kind: 'message',
      id: 'm1',
      role: 'user',
      text: 'hi',
      streaming: false,
      messageId: 'msg-user-1',
      canFork: false,
    }
    const snapshot = (item: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'session_snapshot',
        seq: 1,
        session: snapshotJson({ timeline: [item] }),
      })

    expect(parseServerFrame(snapshot(message))).toStrictEqual({
      ok: true,
      value: {
        type: 'session_snapshot',
        seq: 1,
        session: snapshotJson({ timeline: [message] }),
      },
    })

    const upsert = {
      type: 'message_upsert',
      id: 'm1',
      role: 'user',
      textAppend: ' there',
      streaming: true,
      messageId: 'msg-user-1',
      canFork: true,
    }
    const delta = { type: 'session_delta', seq: 1, ref: REF, events: [upsert] }
    expect(parseServerFrame(JSON.stringify(delta))).toStrictEqual({ ok: true, value: delta })

    expect(errorCode(parseServerFrame(snapshot({ ...message, messageId: '' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(snapshot({ ...message, canFork: 'no' })))).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(
          JSON.stringify({
            type: 'session_delta',
            seq: 1,
            ref: REF,
            events: [{ ...upsert, messageId: '' }],
          }),
        ),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(
          JSON.stringify({
            type: 'session_delta',
            seq: 1,
            ref: REF,
            events: [{ ...upsert, canFork: 1 }],
          }),
        ),
      ),
    ).toBe('bad_request')
  })

  it('rejects malformed snapshots and delta events', () => {
    const withSnapshot = (overrides: Record<string, unknown>): string =>
      JSON.stringify({ type: 'session_snapshot', seq: 1, session: snapshotJson(overrides) })

    expect(errorCode(parseServerFrame(withSnapshot({ timeline: 'nope' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSnapshot({ timeline: [{ kind: 'unknown' }] })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSnapshot({ plan: [{ content: 1 }] })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSnapshot({ configOptions: [{ id: 'x' }] })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSnapshot({ isReplayingHistory: 'no' })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSnapshot({ usage: { used: -1, size: 1 } })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(withSnapshot({ pendingPermission: { toolCallId: 't', title: 'x' } })),
      ),
    ).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSnapshot({ availableCommands: 'nope' })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSnapshot({ availableCommands: [{ name: '' }] })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(withSnapshot({ availableCommands: [{ name: 'a b', description: '' }] })),
      ),
    ).toBe('bad_request')

    const withDelta = (events: unknown[]): string =>
      JSON.stringify({ type: 'session_delta', seq: 1, ref: REF, events })
    expect(errorCode(parseServerFrame(withDelta([{ type: 'unknown' }])))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withDelta([{ type: 'message_upsert', id: '' }])))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withDelta([{ type: 'tool_call_upsert', item: {} }])))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withDelta([{ type: 'permission_upsert' }])))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(withDelta([{ type: 'available_commands_snapshot', commands: [{}] }])),
      ),
    ).toBe('bad_request')
  })

  it('validates resync and command_result fields', () => {
    expect(
      errorCode(parseServerFrame('{"type":"resync_required","scope":"everything","reason":"x"}')),
    ).toBe('bad_request')
    expect(
      errorCode(parseServerFrame('{"type":"command_result","requestId":"r","ok":"yes"}')),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame('{"type":"command_result","requestId":"r","ok":false,"error":"nope"}'),
      ),
    ).toBe('bad_request')
  })

  it('rejects malformed server_error frames and unknown types', () => {
    expect(
      errorCode(
        parseServerFrame('{"type":"server_error","code":"nope","message":"x","retryable":false}'),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(
          '{"type":"server_error","code":"internal","message":"x","retryable":"no"}',
        ),
      ),
    ).toBe('bad_request')
    expect(errorCode(parseServerFrame('{"type":"unknown"}'))).toBe('bad_request')
    expect(errorCode(parseServerFrame('[]'))).toBe('bad_request')
  })

  it('exposes a server frame soft limit above the client limit', () => {
    expect(MAX_SERVER_FRAME_BYTES).toBe(1024 * 1024)
    expect(MAX_SERVER_FRAME_BYTES).toBeGreaterThan(MAX_CLIENT_FRAME_BYTES)
  })
})

describe('serializeFrame', () => {
  it('round-trips client and server frames', () => {
    const clientFrame: ClientFrame = {
      type: 'command',
      requestId: 'r',
      kind: 'getToolCallDetail',
      payload: { ref: REF, toolCallId: 'tool-1' },
    }
    expect(parseClientFrame(serializeFrame(clientFrame))).toStrictEqual({
      ok: true,
      value: clientFrame,
    })
    const serverFrame: ServerFrame = {
      type: 'session_delta',
      seq: 3,
      ref: REF,
      events: [
        { type: 'permission_cleared', requestId: 'perm-1', reason: 'cancelled', source: 'pc' },
      ],
    }
    expect(parseServerFrame(serializeFrame(serverFrame))).toStrictEqual({
      ok: true,
      value: serverFrame,
    })
  })
})

describe('parsePairRequest', () => {
  it('normalizes the code and accepts known platforms', () => {
    expect(
      parsePairRequest({ code: ' abcd-2345 ', deviceName: 'Pixel', platform: 'android' }),
    ).toStrictEqual({
      ok: true,
      value: { code: 'ABCD2345', deviceName: 'Pixel', platform: 'android' },
    })
    expect(
      parsePairRequest({ code: 'ABCD2345', deviceName: 'iPhone', platform: 'ios' }),
    ).toStrictEqual({
      ok: true,
      value: { code: 'ABCD2345', deviceName: 'iPhone', platform: 'ios' },
    })
  })

  it('rejects non-objects and malformed fields', () => {
    expect(errorCode(parsePairRequest(null))).toBe('bad_request')
    expect(errorCode(parsePairRequest([]))).toBe('bad_request')
    expect(errorCode(parsePairRequest('pair'))).toBe('bad_request')
    expect(errorCode(parsePairRequest({}))).toBe('bad_request')
    expect(errorCode(parsePairRequest({ code: 42, deviceName: 'Pixel', platform: 'ios' }))).toBe(
      'bad_request',
    )
    expect(
      errorCode(parsePairRequest({ code: 'ABCD234', deviceName: 'Pixel', platform: 'ios' })),
    ).toBe('bad_request')
    expect(
      errorCode(parsePairRequest({ code: 'ABCD23O5', deviceName: 'Pixel', platform: 'ios' })),
    ).toBe('bad_request')
  })

  it('enforces deviceName and platform limits', () => {
    expect(errorCode(parsePairRequest({ code: 'ABCD2345', deviceName: '', platform: 'ios' }))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parsePairRequest({
          code: 'ABCD2345',
          deviceName: 'x'.repeat(65),
          platform: 'ios',
        }),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(parsePairRequest({ code: 'ABCD2345', deviceName: 'Pixel', platform: 'windows' })),
    ).toBe('bad_request')
    expect(
      errorCode(parsePairRequest({ code: 'ABCD2345', deviceName: 'Pixel', platform: 1 })),
    ).toBe('bad_request')
  })
})

describe('errors and close codes', () => {
  it('recognizes known error codes', () => {
    expect(isMobileErrorCode('unauthorized')).toBe(true)
    expect(isMobileErrorCode('protocol_mismatch')).toBe(true)
    expect(isMobileErrorCode('unsupported_by_agent')).toBe(true)
    expect(isMobileErrorCode('invalid_anchor')).toBe(true)
    expect(isMobileErrorCode('session_busy')).toBe(true)
    expect(isMobileErrorCode('nope')).toBe(false)
    expect(isMobileErrorCode(1)).toBe(false)
  })

  it('uses private WebSocket close codes', () => {
    expect(MOBILE_CLOSE_CODES).toStrictEqual({
      PROTOCOL_MISMATCH: 4400,
      UNAUTHORIZED: 4401,
      REVOKED: 4403,
      HELLO_TIMEOUT: 4408,
    })
  })
})
