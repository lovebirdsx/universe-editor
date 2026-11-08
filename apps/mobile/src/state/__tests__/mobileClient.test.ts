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

  it('rejects commands while the gateway is not connected', async () => {
    const { client, sockets } = createHarness()
    client.openSession('1:s1')
    sockets[0]!.serverClose(1006)
    await expect(client.sendPrompt('hello')).rejects.toMatchObject({ code: 'network' })
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
