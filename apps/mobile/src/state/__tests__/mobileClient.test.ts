import { MOBILE_PROTOCOL_VERSION, type HelloOkFrame } from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { StoredCredentials } from '../../credentials.js'
import { RECONNECT_BASE_MS } from '../../socket/mobileSocket.js'
import { FakeTimers, FakeWebSocket, sentFrames } from '../../test/fakes.js'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'
import { MobileClient } from '../mobileClient.js'

const credentials: StoredCredentials = {
  deviceId: 'device-1',
  token: 'token-1',
  pcName: 'PC-A',
  deviceName: 'Phone',
  platform: 'other',
  protocolVersion: MOBILE_PROTOCOL_VERSION,
}

function helloOkFrame(webBuildId?: string): HelloOkFrame {
  return {
    type: 'hello_ok',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    serverVersion: '0.0.0-test',
    deviceId: 'device-1',
    serverTime: 1,
    capabilities: ['inbox', 'session'],
    ...(webBuildId !== undefined ? { webBuildId } : {}),
  }
}

function createHarness(
  options: {
    readonly fetchImpl?: typeof fetch
    readonly clientWebBuildId?: string
    readonly serverWebBuildId?: string
  } = {},
): {
  readonly client: MobileClient
  readonly sockets: FakeWebSocket[]
  readonly timers: FakeTimers
  readonly fetchImpl: ReturnType<typeof vi.fn>
} {
  const timers = new FakeTimers()
  const sockets: FakeWebSocket[] = []
  const fetchImpl = vi.fn(
    options.fetchImpl ??
      (async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            serverVersion: '0.0.0-test',
            protocolVersion: MOBILE_PROTOCOL_VERSION,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )),
  )
  const client = new MobileClient({
    credentials,
    url: 'ws://pc.example.com/ws',
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url)
      sockets.push(socket)
      return socket
    },
    timers,
    random: () => 0.5,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(options.clientWebBuildId !== undefined
      ? { clientWebBuildId: options.clientWebBuildId }
      : {}),
  })
  client.start()
  const first = sockets[0]!
  first.serverOpen()
  first.serverSend(helloOkFrame(options.serverWebBuildId))
  return { client, sockets, timers, fetchImpl }
}

function frameTypes(socket: FakeWebSocket): string[] {
  return sentFrames(socket).map((frame) =>
    typeof frame === 'object' && frame !== null
      ? String((frame as Record<string, unknown>)['type'])
      : '',
  )
}

describe('MobileClient web build id', () => {
  it('reports a mismatch when the PC serves a different entry script', () => {
    const { client } = createHarness({
      clientWebBuildId: 'index-old.js',
      serverWebBuildId: 'index-new.js',
    })
    expect(client.getWebBuildMismatchStore().getState()).toEqual({
      serverBuildId: 'index-new.js',
      clientBuildId: 'index-old.js',
    })
  })

  it('clears the mismatch when a reconnect sees the loaded build', () => {
    const { client, sockets, timers } = createHarness({
      clientWebBuildId: 'index-old.js',
      serverWebBuildId: 'index-new.js',
    })
    sockets[0]!.serverClose(1006)
    timers.advance(RECONNECT_BASE_MS)

    const second = sockets[1]
    expect(second).toBeDefined()
    second!.serverOpen()
    second!.serverSend(helloOkFrame('index-old.js'))

    expect(client.getWebBuildMismatchStore().getState()).toBeUndefined()
  })

  it('does not report a mismatch when either side omits the build id', () => {
    expect(
      createHarness({ clientWebBuildId: 'index-old.js' })
        .client.getWebBuildMismatchStore()
        .getState(),
    ).toBeUndefined()
    expect(
      createHarness({ serverWebBuildId: 'index-new.js' })
        .client.getWebBuildMismatchStore()
        .getState(),
    ).toBeUndefined()
  })
})

describe('MobileClient session subscription', () => {
  it('resolves a durable route key from the inbox and subscribes once', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('durable-1')
    expect(frameTypes(socket)).not.toContain('subscribe_session')

    socket.serverSend({
      type: 'inbox_delta',
      seq: 2,
      upserts: [sessionSummary('s1', { ref: sessionRef('s1', 1, 'durable-1') })],
      removes: [],
    })
    // No snapshot yet: the delta is rejected and a resubscribe is requested.
    expect(frameTypes(socket)).toContain('subscribe_inbox')

    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 3,
      sessions: [sessionSummary('s1', { ref: sessionRef('s1', 1, 'durable-1') })],
    })
    const subscribe = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'subscribe_session',
    )
    expect(subscribe).toMatchObject({
      type: 'subscribe_session',
      ref: sessionRef('s1', 1, 'durable-1'),
    })
  })

  it('marks an unknown durable route as removed once the inbox snapshot arrives', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('closed-session')
    socket.serverSend({ type: 'inbox_snapshot', seq: 1, sessions: [] })
    expect(client.getSessionStore().getState().removed).toBe(true)
  })

  it('re-subscribes the inbox and the open session after a reconnect', () => {
    const { client, sockets, timers } = createHarness()
    const first = sockets[0]!
    first.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1')],
    })
    client.openSession('1:s1')
    expect(frameTypes(first).filter((type) => type === 'subscribe_session')).toHaveLength(1)

    first.serverClose(1006)
    timers.advance(RECONNECT_BASE_MS)
    const second = sockets[1]
    expect(second).toBeDefined()
    second!.serverOpen()
    second!.serverSend(helloOkFrame())

    const types = frameTypes(second!)
    expect(types).toContain('subscribe_inbox')
    expect(types.filter((type) => type === 'subscribe_session')).toHaveLength(1)
  })

  it('corrects the PC clock from hello_ok', () => {
    const { client } = createHarness()
    expect(Math.abs(client.serverNow() - 1)).toBeLessThan(1_000)
  })

  it('sends a high-frequency draft frame without the command wrapper', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const clientUpdateId = client.sendDraft('hi')

    const frame = sentFrames(socket).find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as Record<string, unknown>)['type'] === 'draft_update',
    ) as { type: string; clientUpdateId: string; draft: unknown }
    expect(frame).toMatchObject({
      type: 'draft_update',
      ref: { windowId: 1, localId: 's1' },
      draft: { text: 'hi', images: [] },
    })
    expect(frame.clientUpdateId).toBeTruthy()
    expect(frame.clientUpdateId).toBe(clientUpdateId)
    expect(frameTypes(socket)).not.toContain('command')
  })

  it('sends session commands with the open ref and resolves stale as success', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const resolved = client.resolvePermission('req-1', 'allow-once')
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { requestId: string; kind: string; payload: unknown; idempotencyKey?: string }
    expect(command).toMatchObject({
      kind: 'resolvePermission',
      payload: { ref: { windowId: 1, localId: 's1' }, requestId: 'req-1', optionId: 'allow-once' },
    })
    expect(command.idempotencyKey).toBeTruthy()

    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: false,
      error: 'stale_request',
    })
    await expect(resolved).resolves.toBeUndefined()
  })

  it('sends attachment ids only when the prompt carries them', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    void client.sendPrompt('hello', ['att-1', 'att-2']).catch(() => undefined)
    void client.sendPrompt('plain').catch(() => undefined)
    void client.sendPrompt('with draft', [], ['img-1'], ['file-1']).catch(() => undefined)
    const commands = sentFrames(socket).filter(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as Array<{ kind: string; payload: Record<string, unknown> }>
    expect(commands[0]).toMatchObject({
      kind: 'sendPrompt',
      payload: {
        ref: { windowId: 1, localId: 's1' },
        text: 'hello',
        attachmentIds: ['att-1', 'att-2'],
      },
    })
    expect(commands[1]?.payload).toEqual({
      ref: { windowId: 1, localId: 's1' },
      text: 'plain',
    })
    expect(commands[2]?.payload).toEqual({
      ref: { windowId: 1, localId: 's1' },
      text: 'with draft',
      draftImageIds: ['img-1'],
      draftFileIds: ['file-1'],
    })
  })

  it('sends prompt refs and resolves completion entries', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    void client
      .sendPrompt(
        'see @src/a.ts',
        [],
        [],
        [],
        [{ kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts', start: 4, end: 13 }],
      )
      .catch(() => undefined)
    const search = client.searchPromptRefs('@', 'src', 5)
    const commands = sentFrames(socket).filter(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as Array<{
      requestId: string
      kind: string
      payload: Record<string, unknown>
      idempotencyKey?: string
    }>
    expect(commands[0]).toMatchObject({
      kind: 'sendPrompt',
      payload: {
        ref: { windowId: 1, localId: 's1' },
        text: 'see @src/a.ts',
        refs: [{ kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts', start: 4, end: 13 }],
      },
    })
    expect(commands[1]).toMatchObject({
      kind: 'searchPromptRefs',
      payload: { ref: { windowId: 1, localId: 's1' }, trigger: '@', query: 'src', limit: 5 },
    })
    // Read-only completion must not carry an idempotency key.
    expect(commands[1]?.idempotencyKey).toBeUndefined()

    socket.serverSend({
      type: 'command_result',
      requestId: commands[1]!.requestId,
      ok: true,
      result: { entries: [{ kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts' }] },
    })
    await expect(search).resolves.toEqual([
      { kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts' },
    ])
  })

  it('rejects malformed prompt-ref completion results', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const search = client.searchPromptRefs('#', '', 20)
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { requestId: string }
    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: { entries: [{ kind: 'folder', label: 'src' }] },
    })
    await expect(search).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('truncates overlong completion queries to the protocol limit', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    void client.searchPromptRefs('@', 'x'.repeat(300)).catch(() => undefined)
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command' &&
        (frame as Record<string, unknown>)['kind'] === 'searchPromptRefs',
    ) as Record<string, unknown> | undefined
    expect((command?.['payload'] as { query?: string } | undefined)?.query).toHaveLength(256)
  })

  it('sends resolvePromptRef and validates commit results', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')
    const hash = 'a'.repeat(40)
    const pending = client.resolvePromptRef('commit', 'fix', { limit: 50 })
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['kind'] === 'resolvePromptRef',
    ) as { requestId: string; payload: Record<string, unknown>; idempotencyKey?: string }

    expect(command.payload).toEqual({
      ref: { windowId: 1, localId: 's1' },
      kind: 'commit',
      query: 'fix',
      limit: 50,
    })
    // It can open a picker on the PC, so a resend must reuse the same key.
    expect(command.idempotencyKey).toBeTruthy()

    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: {
        kind: 'commit',
        entries: [
          {
            kind: 'commit',
            label: 'a1b2c3d fix',
            uri: 'file:///repo',
            commitHash: hash,
            text: 'fix',
          },
        ],
      },
    })

    await expect(pending).resolves.toEqual({
      kind: 'commit',
      entries: [
        {
          kind: 'commit',
          label: 'a1b2c3d fix',
          uri: 'file:///repo',
          commitHash: hash,
          text: 'fix',
        },
      ],
    })
  })

  it('sends chatContext handles and accepts a cancelled resolution', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')
    const pending = client.resolvePromptRef('chatContext', '', {
      handle: 4,
      label: 'Perforce CL',
    })
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['kind'] === 'resolvePromptRef',
    ) as { requestId: string; payload: Record<string, unknown> }

    expect(command.payload).toEqual({
      ref: { windowId: 1, localId: 's1' },
      kind: 'chatContext',
      query: '',
      handle: 4,
      label: 'Perforce CL',
    })

    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: { kind: 'chatContext' },
    })

    await expect(pending).resolves.toEqual({ kind: 'chatContext' })
  })

  it('rejects resolve results missing final commit fields', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')
    const pending = client.resolvePromptRef('commit', '')
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['kind'] === 'resolvePromptRef',
    ) as { requestId: string }

    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: {
        kind: 'commit',
        entries: [{ kind: 'commit', label: 'a1b2c3d fix', uri: 'file:///repo', text: 'fix' }],
      },
    })

    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('truncates overlong resolve queries to the protocol limit', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    void client.resolvePromptRef('commit', 'x'.repeat(300)).catch(() => undefined)
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['kind'] === 'resolvePromptRef',
    ) as { payload: { query?: string } }
    expect(command.payload.query).toHaveLength(256)
  })

  it('rejects commands while the gateway is not connected', async () => {
    const { client, sockets } = createHarness()
    client.openSession('1:s1')
    sockets[0]!.serverClose(1006)
    await expect(client.sendPrompt('hello')).rejects.toMatchObject({ code: 'network' })
  })

  it('targets an explicit inbox ref and drops the row after close/remove', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1'), sessionSummary('s2')],
    })

    const closed = client.closeSession(sessionRef('s1'))
    const closeCommand = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { requestId: string; kind: string; payload: unknown }
    expect(closeCommand.kind).toBe('closeSession')
    expect(closeCommand.payload).toStrictEqual({ ref: sessionRef('s1') })
    socket.serverSend({ type: 'command_result', requestId: closeCommand.requestId, ok: true })
    await closed
    expect(
      client
        .getInboxStore()
        .getState()
        .sessions.map((s) => s.ref.localId),
    ).toEqual(['s2'])

    const removed = client.deleteSession(sessionRef('s2'))
    const deleteCommand = sentFrames(socket)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['type'] === 'command',
      )
      .at(-1) as { requestId: string; kind: string; payload: unknown }
    expect(deleteCommand.kind).toBe('deleteSession')
    expect(deleteCommand.payload).toStrictEqual({ ref: sessionRef('s2') })
    socket.serverSend({ type: 'command_result', requestId: deleteCommand.requestId, ok: true })
    await removed
    expect(client.getInboxStore().getState().sessions).toEqual([])
  })

  it('deletes a history row by durable id and drops the matching inbox row', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1', { ref: sessionRef('s1', 1, 'durable-1') })],
    })

    const removed = client.deleteHistorySession('durable-1', 2)
    const command = sentFrames(socket).at(-1) as {
      requestId: string
      kind: string
      payload: unknown
    }
    expect(command.kind).toBe('deleteHistorySession')
    expect(command.payload).toStrictEqual({ durableId: 'durable-1', windowId: 2 })
    socket.serverSend({ type: 'command_result', requestId: command.requestId, ok: true })
    await removed
    expect(client.getInboxStore().getState().sessions).toEqual([])
  })

  it('keeps the inbox row when deleting a history row fails', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1', { ref: sessionRef('s1', 1, 'durable-1') })],
    })

    const removed = client.deleteHistorySession('durable-1')
    const command = sentFrames(socket).at(-1) as { requestId: string }
    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: false,
      error: 'internal',
    })

    await expect(removed).rejects.toMatchObject({ code: 'internal' })
    expect(client.getInboxStore().getState().sessions).toHaveLength(1)
  })

  it('marks a session removed even when the removal arrives before its snapshot', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    socket.serverSend({ type: 'session_removed', ref: sessionRef('s1') })

    expect(client.getSessionStore().getState().removed).toBe(true)
  })

  it('treats a missing session as an already-finished close and drops the row', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1')],
    })

    const closed = client.closeSession(sessionRef('s1'))
    const command = sentFrames(socket).at(-1) as { requestId: string }
    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: false,
      error: 'session_not_found',
    })

    await expect(closed).resolves.toBeUndefined()
    expect(client.getInboxStore().getState().sessions).toEqual([])
  })

  it('keeps the inbox row when closing fails', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1')],
    })

    const closed = client.closeSession(sessionRef('s1'))
    const command = sentFrames(socket).at(-1) as { requestId: string }
    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: false,
      error: 'internal',
    })

    await expect(closed).rejects.toMatchObject({ code: 'internal' })
    expect(client.getInboxStore().getState().sessions).toHaveLength(1)
  })

  it('auto-generates an idempotency key for newSession', () => {
    const { client, sockets } = createHarness()
    void client.newSession('echo', { folder: 'file:///work' }).catch(() => undefined)
    const command = sentFrames(sockets[0]!).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { kind: string; idempotencyKey?: string }
    expect(command.kind).toBe('newSession')
    expect(command.idempotencyKey).toBeTruthy()
  })

  it('forwards the selected workspace subdirectory when creating a session', () => {
    const { client, sockets } = createHarness()
    void client
      .newSession('echo', { folder: 'file:///work', relativePath: 'packages/demo' }, 'go')
      .catch(() => undefined)
    const command = sentFrames(sockets[0]!).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { payload: unknown }
    expect(command.payload).toEqual({
      agentId: 'echo',
      workspace: { folder: 'file:///work', relativePath: 'packages/demo' },
      initialPrompt: 'go',
    })
  })

  it('lists a workspace directory as a read-only command and guards the result', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    const listed = client.listDirectory(
      { folder: 'file:///work', authority: 'ssh-remote+host' },
      'packages',
    )
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { requestId: string; kind: string; payload: unknown; idempotencyKey?: string }
    expect(command.kind).toBe('listDirectory')
    expect(command.idempotencyKey).toBeUndefined()
    expect(command.payload).toEqual({
      folder: 'file:///work',
      authority: 'ssh-remote+host',
      relativePath: 'packages',
    })
    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: {
        relativePath: 'packages',
        parentRelativePath: '',
        entries: [{ name: 'demo', relativePath: 'packages/demo' }],
      },
    })
    await expect(listed).resolves.toMatchObject({
      relativePath: 'packages',
      entries: [{ name: 'demo', relativePath: 'packages/demo' }],
    })

    const malformed = client.listDirectory({ folder: 'file:///work' })
    const next = sentFrames(socket)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['type'] === 'command',
      )
      .at(-1) as { requestId: string }
    socket.serverSend({
      type: 'command_result',
      requestId: next.requestId,
      ok: true,
      result: { relativePath: '../escape', entries: [] },
    })
    await expect(malformed).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('omits the authority and relativePath for a root directory listing', () => {
    const { client, sockets } = createHarness()
    void client.listDirectory({ folder: 'file:///work' }).catch(() => undefined)
    const command = sentFrames(sockets[0]!).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { payload: unknown }
    expect(command.payload).toEqual({ folder: 'file:///work' })
  })

  it('reads new-session options as a read-only command and guards the result', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    const options = client.getNewSessionOptions({
      folder: 'file:///work',
      authority: 'ssh-remote+host',
    })
    const command = sentFrames(socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === 'command',
    ) as { requestId: string; kind: string; payload: unknown; idempotencyKey?: string }
    expect(command.kind).toBe('getNewSessionOptions')
    expect(command.idempotencyKey).toBeUndefined()
    expect(command.payload).toEqual({
      folder: 'file:///work',
      authority: 'ssh-remote+host',
    })
    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: { lastRelativePath: 'packages/demo', projectRoots: ['packages/demo'] },
    })
    await expect(options).resolves.toStrictEqual({
      lastRelativePath: 'packages/demo',
      projectRoots: ['packages/demo'],
    })

    const malformed = client.getNewSessionOptions({ folder: 'file:///work' })
    const next = sentFrames(socket)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['type'] === 'command',
      )
      .at(-1) as { requestId: string }
    socket.serverSend({
      type: 'command_result',
      requestId: next.requestId,
      ok: true,
      result: { projectRoots: ['../escape'] },
    })
    await expect(malformed).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('MobileClient fork / rewind / side-task commands', () => {
  function lastCommand(socket: FakeWebSocket): {
    requestId: string
    kind: string
    payload: unknown
    idempotencyKey?: string
  } {
    return sentFrames(socket)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['type'] === 'command',
      )
      .at(-1) as {
      requestId: string
      kind: string
      payload: unknown
      idempotencyKey?: string
    }
  }

  it('subscribes directly to a command-returned ref', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSessionRef({ windowId: 2, localId: 'side-local', durableId: 'side-durable' })

    expect(client.getOpenRouteKey()).toBe('side-durable')
    expect(
      sentFrames(socket).find(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['type'] === 'subscribe_session',
      ),
    ).toMatchObject({
      type: 'subscribe_session',
      ref: { windowId: 2, localId: 'side-local', durableId: 'side-durable' },
    })
  })

  it('binds fork/rewind/side-task payloads to the open ref', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    void client.forkSession('msg-1')
    expect(lastCommand(socket)).toMatchObject({
      kind: 'forkSession',
      payload: { ref: { windowId: 1, localId: 's1' }, messageId: 'msg-1' },
    })
    expect(lastCommand(socket).idempotencyKey).toBeTruthy()

    void client.previewRewind('msg-1')
    expect(lastCommand(socket)).toMatchObject({
      kind: 'previewRewind',
      payload: { ref: { windowId: 1, localId: 's1' }, messageId: 'msg-1' },
    })
    expect(lastCommand(socket).idempotencyKey).toBeUndefined()

    void client.rewindSession('msg-1', false)
    expect(lastCommand(socket)).toMatchObject({
      kind: 'rewindSession',
      payload: { ref: { windowId: 1, localId: 's1' }, messageId: 'msg-1', rewindFiles: false },
    })

    void client.createSideTask('why?')
    expect(lastCommand(socket)).toMatchObject({
      kind: 'createSideTask',
      payload: { ref: { windowId: 1, localId: 's1' }, quote: 'why?' },
    })

    void client.listSideTasks()
    expect(lastCommand(socket)).toMatchObject({
      kind: 'listSideTasks',
      payload: { ref: { windowId: 1, localId: 's1' } },
    })

    void client.openSideTask('side-durable')
    expect(lastCommand(socket)).toMatchObject({
      kind: 'openSideTask',
      payload: { ref: { windowId: 1, localId: 's1' }, sideTaskId: 'side-durable' },
    })

    void client.deleteSideTask('side-durable')
    expect(lastCommand(socket)).toMatchObject({
      kind: 'deleteSideTask',
      payload: { ref: { windowId: 1, localId: 's1' }, sideTaskId: 'side-durable' },
    })
  })

  it('validates command results and rejects malformed values', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const fork = client.forkSession()
    const forkCommand = lastCommand(socket)
    socket.serverSend({
      type: 'command_result',
      requestId: forkCommand.requestId,
      ok: true,
      result: { ref: { windowId: 1, localId: 'fork-local', durableId: 'fork-durable' } },
    })
    await expect(fork).resolves.toEqual({
      ref: { windowId: 1, localId: 'fork-local', durableId: 'fork-durable' },
    })

    const badPreview = client.previewRewind('msg-1')
    const previewCommand = lastCommand(socket)
    socket.serverSend({
      type: 'command_result',
      requestId: previewCommand.requestId,
      ok: true,
      result: { canRewind: 'yes', filesChanged: 1 },
    })
    await expect(badPreview).rejects.toMatchObject({ code: 'invalid_response' })

    const rewind = client.rewindSession('msg-1')
    const rewindCommand = lastCommand(socket)
    socket.serverSend({
      type: 'command_result',
      requestId: rewindCommand.requestId,
      ok: true,
      result: { canRewind: true, text: 'original' },
    })
    await expect(rewind).resolves.toEqual({ canRewind: true, text: 'original' })

    const list = client.listSideTasks()
    const listCommand = lastCommand(socket)
    socket.serverSend({
      type: 'command_result',
      requestId: listCommand.requestId,
      ok: true,
      result: 'nope',
    })
    await expect(list).rejects.toMatchObject({ code: 'invalid_response' })

    const listOk = client.listSideTasks()
    socket.serverSend({
      type: 'command_result',
      requestId: lastCommand(socket).requestId,
      ok: true,
      result: [{ id: 'side-1', title: 'Side', lastUsedAt: 1, live: true }],
    })
    await expect(listOk).resolves.toEqual([
      { id: 'side-1', title: 'Side', lastUsedAt: 1, live: true },
    ])
  })

  it('rejects when no session is open', async () => {
    const { client } = createHarness()
    await expect(client.listSideTasks()).rejects.toMatchObject({ code: 'session_not_found' })
    await expect(client.rewindSession('msg-1')).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })
})

describe('MobileClient session settings commands', () => {
  function lastCommand(socket: FakeWebSocket): {
    requestId: string
    kind: string
    payload: unknown
    idempotencyKey?: string
  } {
    return sentFrames(socket)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['type'] === 'command',
      )
      .at(-1) as {
      requestId: string
      kind: string
      payload: unknown
      idempotencyKey?: string
    }
  }

  const settingsPayload = {
    canEdit: true,
    subagentModel: { supported: true, current: 'opus', candidates: ['sonnet', 'opus'] },
    mcp: {
      pool: [{ name: 'shared', transport: 'stdio', defaultDisabled: false }],
      selection: null,
      enabled: ['shared'],
      live: [{ name: 'shared', status: 'connected', transport: 'stdio' }],
    },
  }

  it('queries session settings without an idempotency key', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const pending = client.getSessionSettings()
    const command = lastCommand(socket)
    expect(command).toMatchObject({
      kind: 'getSessionSettings',
      payload: { ref: { windowId: 1, localId: 's1' } },
    })
    expect(command.idempotencyKey).toBeUndefined()

    socket.serverSend({
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: settingsPayload,
    })
    await expect(pending).resolves.toEqual(settingsPayload)
  })

  it('rejects a malformed session settings result', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const pending = client.getSessionSettings()
    socket.serverSend({
      type: 'command_result',
      requestId: lastCommand(socket).requestId,
      ok: true,
      result: { ...settingsPayload, canEdit: 'yes' },
    })
    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('sends the subagent model and restart commands with idempotency keys', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const save = client.setSubagentModel('opus')
    const saveCommand = lastCommand(socket)
    expect(saveCommand).toMatchObject({
      kind: 'setSubagentModel',
      payload: { ref: { windowId: 1, localId: 's1' }, model: 'opus' },
    })
    expect(saveCommand.idempotencyKey).toBeTruthy()
    socket.serverSend({
      type: 'command_result',
      requestId: saveCommand.requestId,
      ok: true,
    })
    await expect(save).resolves.toBeUndefined()

    const inherit = client.setSubagentModel(null)
    expect(lastCommand(socket)).toMatchObject({
      kind: 'setSubagentModel',
      payload: { model: null },
    })
    socket.serverSend({
      type: 'command_result',
      requestId: lastCommand(socket).requestId,
      ok: true,
    })
    await expect(inherit).resolves.toBeUndefined()

    const restart = client.restartAgentProcess()
    const restartCommand = lastCommand(socket)
    expect(restartCommand).toMatchObject({
      kind: 'restartAgentProcess',
      payload: { ref: { windowId: 1, localId: 's1' } },
    })
    expect(restartCommand.idempotencyKey).toBeTruthy()
    socket.serverSend({
      type: 'command_result',
      requestId: restartCommand.requestId,
      ok: true,
    })
    await expect(restart).resolves.toBeUndefined()
  })

  it('sends the session MCP whitelist and the reset sentinel', async () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    client.openSession('1:s1')

    const pin = client.setSessionMcpServers(['shared', 'docs'])
    const pinCommand = lastCommand(socket)
    expect(pinCommand).toMatchObject({
      kind: 'setSessionMcpServers',
      payload: { ref: { windowId: 1, localId: 's1' }, servers: ['shared', 'docs'] },
    })
    expect(pinCommand.idempotencyKey).toBeTruthy()
    socket.serverSend({
      type: 'command_result',
      requestId: pinCommand.requestId,
      ok: true,
    })
    await expect(pin).resolves.toBeUndefined()

    const reset = client.setSessionMcpServers(null)
    expect(lastCommand(socket)).toMatchObject({
      kind: 'setSessionMcpServers',
      payload: { servers: null },
    })
    socket.serverSend({
      type: 'command_result',
      requestId: lastCommand(socket).requestId,
      ok: true,
    })
    await expect(reset).resolves.toBeUndefined()
  })

  it('rejects session settings commands when no session is open', async () => {
    const { client } = createHarness()
    await expect(client.getSessionSettings()).rejects.toMatchObject({ code: 'session_not_found' })
    await expect(client.setSubagentModel('opus')).rejects.toMatchObject({
      code: 'session_not_found',
    })
    await expect(client.restartAgentProcess()).rejects.toMatchObject({ code: 'session_not_found' })
    await expect(client.setSessionMcpServers(null)).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })
})

describe('MobileClient notifications', () => {
  it('captures the VAPID key and re-registers push after a reconnect', () => {
    const { client, sockets, timers } = createHarness()
    const first = sockets[0]!
    first.serverSend({ ...helloOkFrame(), vapidPublicKey: 'vapid-public-key' })
    expect(client.getVapidPublicKey()).toBe('vapid-public-key')

    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/token',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    }
    client.subscribePush(subscription, {
      enabled: true,
      kinds: ['permission'],
      alwaysNotify: true,
    })
    expect(sentFrames(first)).toContainEqual({
      type: 'push_subscribe',
      subscription,
      prefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })

    first.serverClose(1006)
    timers.advance(RECONNECT_BASE_MS)
    const second = sockets[1]!
    second.serverOpen()
    second.serverSend(helloOkFrame())

    expect(sentFrames(second)).toContainEqual({
      type: 'push_subscribe',
      subscription,
      prefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })
  })

  it('hydrates notification preferences from hello_ok', () => {
    const { client, sockets } = createHarness()
    sockets[0]!.serverSend({
      ...helloOkFrame(),
      notificationPrefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })
    expect(client.getNotificationPrefsStore().getState()).toEqual({
      enabled: true,
      kinds: ['permission'],
      alwaysNotify: true,
    })
  })

  it('mirrors preferences sent with subscribePush into the store', () => {
    const { client } = createHarness()
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/token',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    }
    client.subscribePush(subscription, {
      enabled: true,
      kinds: ['permission'],
      alwaysNotify: true,
    })
    expect(client.getNotificationPrefsStore().getState()).toEqual({
      enabled: true,
      kinds: ['permission'],
      alwaysNotify: true,
    })
  })

  it('keeps a locally edited snapshot over a later hello and replays it', () => {
    const { client, sockets, timers } = createHarness()
    const first = sockets[0]!
    first.serverSend({
      ...helloOkFrame(),
      notificationPrefs: { enabled: true, kinds: ['permission'], alwaysNotify: false },
    })
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/token',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    }
    client.subscribePush(subscription)
    client.setNotificationPrefs(true, ['question'], true)

    first.serverClose(1006)
    timers.advance(RECONNECT_BASE_MS)
    const second = sockets[1]!
    second.serverOpen()
    second.serverSend({
      ...helloOkFrame(),
      notificationPrefs: { enabled: true, kinds: ['permission'], alwaysNotify: false },
    })

    expect(client.getNotificationPrefsStore().getState()).toEqual({
      enabled: true,
      kinds: ['question'],
      alwaysNotify: true,
    })
    expect(sentFrames(second)).toContainEqual({
      type: 'push_subscribe',
      subscription,
      prefs: { enabled: true, kinds: ['question'], alwaysNotify: true },
    })
  })

  it('refreshes hydrated prefs from a later hello when nothing was edited locally', () => {
    const { client, sockets, timers } = createHarness()
    sockets[0]!.serverSend({
      ...helloOkFrame(),
      notificationPrefs: { enabled: true, kinds: ['permission'], alwaysNotify: false },
    })

    sockets[0]!.serverClose(1006)
    timers.advance(RECONNECT_BASE_MS)
    const second = sockets[1]!
    second.serverOpen()
    second.serverSend({
      ...helloOkFrame(),
      notificationPrefs: { enabled: true, kinds: ['question'], alwaysNotify: true },
    })

    expect(client.getNotificationPrefsStore().getState()).toEqual({
      enabled: true,
      kinds: ['question'],
      alwaysNotify: true,
    })
  })

  it('stores a notification only when its session is not open', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!
    const frame = {
      type: 'notification' as const,
      id: 'n1',
      kind: 'permission' as const,
      ref: sessionRef('s1', 1, 'durable-1'),
      title: 'Fix the parser',
      body: '等待审批：Run shell command',
      at: 1,
    }

    socket.serverSend(frame)
    expect(client.getNotificationStore().getState()).toEqual(frame)
    client.dismissNotification()
    expect(client.getNotificationStore().getState()).toBeUndefined()

    socket.serverSend({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('s1', { ref: sessionRef('s1', 1, 'durable-1') })],
    })
    client.openSession('durable-1')
    socket.serverSend({ ...frame, id: 'n2' })
    expect(client.getNotificationStore().getState()).toBeUndefined()
  })

  it('sends preference updates and unsubscribes', () => {
    const { client, sockets } = createHarness()
    const socket = sockets[0]!

    client.setNotificationPrefs(true, ['question', 'completed'], true)
    expect(sentFrames(socket)).toContainEqual({
      type: 'set_notification_prefs',
      enabled: true,
      kinds: ['question', 'completed'],
      alwaysNotify: true,
    })
    expect(client.getNotificationPrefsStore().getState()).toEqual({
      enabled: true,
      kinds: ['question', 'completed'],
      alwaysNotify: true,
    })

    client.unsubscribePush()
    expect(sentFrames(socket)).toContainEqual({ type: 'push_unsubscribe' })
  })
})

describe('MobileClient connection diagnosis', () => {
  function failThreeTimes(harness: ReturnType<typeof createHarness>): void {
    harness.sockets[0]!.serverClose(1006)
    harness.timers.advance(RECONNECT_BASE_MS)
    harness.sockets[1]!.serverClose(1006)
    harness.timers.advance(RECONNECT_BASE_MS * 2)
    harness.sockets[2]!.serverClose(1006)
  }

  it('probes the gateway after three failed reconnects', async () => {
    const harness = createHarness()
    failThreeTimes(harness)

    expect(harness.client.getReconnectAttemptStore().getState()).toBe(3)
    await vi.waitFor(() => {
      expect(harness.fetchImpl).toHaveBeenCalledTimes(1)
      expect(harness.client.getConnectionDiagnosisStore().getState()).toMatchObject({
        kind: 'ok',
        origin: 'http://pc.example.com',
      })
    })
    expect(harness.fetchImpl.mock.calls[0]?.[0]).toBe('http://pc.example.com/api/health')
  })

  it('clears the diagnosis and attempt count once hello_ok lands', async () => {
    const harness = createHarness()
    failThreeTimes(harness)
    await vi.waitFor(() => {
      expect(harness.client.getConnectionDiagnosisStore().getState()).toBeDefined()
    })

    harness.timers.advance(RECONNECT_BASE_MS * 4)
    const socket = harness.sockets[3]!
    socket.serverOpen()
    socket.serverSend(helloOkFrame())

    expect(harness.client.getReconnectAttemptStore().getState()).toBe(0)
    expect(harness.client.getConnectionDiagnosisStore().getState()).toBeUndefined()
  })

  it('drops a probe that resolves after the socket reconnected', async () => {
    let release: ((response: Response) => void) | undefined
    const harness = createHarness({
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    failThreeTimes(harness)
    await vi.waitFor(() => {
      expect(harness.fetchImpl).toHaveBeenCalledTimes(1)
    })

    harness.timers.advance(RECONNECT_BASE_MS * 4)
    const socket = harness.sockets[3]!
    socket.serverOpen()
    socket.serverSend(helloOkFrame())
    release!(
      new Response(JSON.stringify({ status: 'ok', protocolVersion: MOBILE_PROTOCOL_VERSION }), {
        status: 200,
      }),
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.client.getConnectionDiagnosisStore().getState()).toBeUndefined()
  })

  it('retryDiagnosis probes immediately and retryConnection skips the backoff', async () => {
    const harness = createHarness()
    harness.client.retryDiagnosis()
    await vi.waitFor(() => {
      expect(harness.client.getConnectionDiagnosisStore().getState()).toBeDefined()
    })

    harness.sockets[0]!.serverClose(1006)
    expect(harness.sockets).toHaveLength(1)
    harness.client.retryConnection()
    expect(harness.sockets).toHaveLength(2)
    expect(harness.timers.pendingTimeoutDelays()).toEqual([])
  })
})

describe('MobileClient session images', () => {
  it('rejects when no session is open', async () => {
    const { client } = createHarness()
    await expect(client.fetchMessageImageBlob('m1', 0)).rejects.toMatchObject({
      code: 'session_not_found',
    })
    await expect(client.fetchWorkspaceImageBlob('img/a.png')).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })

  it('fetches message and workspace images with the open ref', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )
    const { client } = createHarness({ fetchImpl: fetchImpl as unknown as typeof fetch })
    client.openSessionRef(sessionRef('local-1', 2, 'durable-1'))

    const messageBlob = await client.fetchMessageImageBlob('m1', 3)
    expect(messageBlob.size).toBe(2)
    const messageUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]))
    expect(messageUrl.pathname).toBe('/api/sessions/image')
    expect(Object.fromEntries(messageUrl.searchParams)).toEqual({
      windowId: '2',
      localId: 'local-1',
      durableId: 'durable-1',
      message: 'm1',
      index: '3',
    })

    await client.fetchWorkspaceImageBlob('img/a.png')
    const workspaceUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]))
    expect(workspaceUrl.pathname).toBe('/api/sessions/file')
    expect(workspaceUrl.searchParams.get('path')).toBe('img/a.png')
    expect(workspaceUrl.searchParams.get('durableId')).toBe('durable-1')
  })
})
