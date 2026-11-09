import { MOBILE_PROTOCOL_VERSION, type HelloOkFrame } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
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

function helloOkFrame(): HelloOkFrame {
  return {
    type: 'hello_ok',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    serverVersion: '0.0.0-test',
    deviceId: 'device-1',
    serverTime: 1,
    capabilities: ['inbox', 'session'],
  }
}

function createHarness(): {
  readonly client: MobileClient
  readonly sockets: FakeWebSocket[]
  readonly timers: FakeTimers
} {
  const timers = new FakeTimers()
  const sockets: FakeWebSocket[] = []
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
  })
  client.start()
  const first = sockets[0]!
  first.serverOpen()
  first.serverSend(helloOkFrame())
  return { client, sockets, timers }
}

function frameTypes(socket: FakeWebSocket): string[] {
  return sentFrames(socket).map((frame) =>
    typeof frame === 'object' && frame !== null
      ? String((frame as Record<string, unknown>)['type'])
      : '',
  )
}

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

    client.unsubscribePush()
    expect(sentFrames(socket)).toContainEqual({ type: 'push_unsubscribe' })
  })
})
