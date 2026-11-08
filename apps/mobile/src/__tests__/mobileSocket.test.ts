import {
  MOBILE_CLOSE_CODES,
  MOBILE_PROTOCOL_VERSION,
  type HelloOkFrame,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MOBILE_CLIENT_VERSION,
  MobileSocket,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type SocketState,
} from '../socket/mobileSocket.js'
import { FakeTimers, FakeWebSocket, sentFrames } from '../test/fakes.js'

interface SocketHarness {
  readonly socket: MobileSocket
  readonly timers: FakeTimers
  readonly sockets: FakeWebSocket[]
  readonly states: SocketState[]
  readonly frames: ServerFrame[]
  readonly onCredentialsInvalid: ReturnType<typeof vi.fn>
  readonly onProtocolMismatch: ReturnType<typeof vi.fn>
  readonly logger: { warn: ReturnType<typeof vi.fn> }
}

function createHarness(): SocketHarness {
  const timers = new FakeTimers()
  const sockets: FakeWebSocket[] = []
  const states: SocketState[] = []
  const frames: ServerFrame[] = []
  const onCredentialsInvalid = vi.fn()
  const onProtocolMismatch = vi.fn()
  const logger = { warn: vi.fn() }
  const socket = new MobileSocket({
    url: 'ws://pc.example.com/ws',
    token: 'secret-token',
    createWebSocket: (url) => {
      const fake = new FakeWebSocket(url)
      sockets.push(fake)
      return fake
    },
    timers,
    random: () => 0.5,
    onStateChange: (state) => states.push(state),
    onFrame: (frame) => frames.push(frame),
    onCredentialsInvalid,
    onProtocolMismatch,
    logger,
  })
  return {
    socket,
    timers,
    sockets,
    states,
    frames,
    onCredentialsInvalid,
    onProtocolMismatch,
    logger,
  }
}

function helloOk(): HelloOkFrame {
  return {
    type: 'hello_ok',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    serverVersion: '0.0.0-test',
    deviceId: 'device-1',
    serverTime: 1,
    capabilities: ['inbox'],
  }
}

function currentSocket(harness: SocketHarness): FakeWebSocket {
  const socket = harness.sockets.at(-1)
  if (socket === undefined) throw new Error('no WebSocket created')
  return socket
}

function connect(harness: SocketHarness): FakeWebSocket {
  harness.socket.start()
  const socket = currentSocket(harness)
  socket.serverOpen()
  socket.serverSend(helloOk())
  return socket
}

describe('MobileSocket handshake', () => {
  it('sends hello with the token in the first frame, never the URL', () => {
    const harness = createHarness()
    harness.socket.start()
    const socket = currentSocket(harness)
    expect(socket.url).toBe('ws://pc.example.com/ws')
    expect(socket.url).not.toContain('secret-token')

    socket.serverOpen()
    expect(sentFrames(socket)[0]).toEqual({
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token: 'secret-token',
      clientVersion: MOBILE_CLIENT_VERSION,
      capabilities: ['inbox'],
    })

    socket.serverSend(helloOk())
    expect(harness.socket.state).toBe('connected')
    expect(sentFrames(socket)[1]).toEqual({ type: 'subscribe_inbox' })
  })

  it('forwards inbox snapshots after subscribe', () => {
    const harness = createHarness()
    const socket = connect(harness)
    socket.serverSend({ type: 'inbox_snapshot', seq: 0, sessions: [] })
    expect(harness.frames).toEqual([{ type: 'inbox_snapshot', seq: 0, sessions: [] }])
  })

  it('warns and ignores malformed or non-text frames', () => {
    const harness = createHarness()
    const socket = connect(harness)
    socket.serverSend('{not json')
    socket.serverSendRaw(new ArrayBuffer(2))
    expect(harness.logger.warn).toHaveBeenCalledTimes(2)
    expect(harness.socket.state).toBe('connected')
    expect(harness.frames).toEqual([])
  })
})

describe('MobileSocket heartbeats', () => {
  it('pings every 20s and treats 45s without pong as a dead connection', () => {
    const harness = createHarness()
    const socket = connect(harness)

    harness.timers.advance(HEARTBEAT_INTERVAL_MS)
    expect(sentFrames(socket).filter((frame) => frameType(frame) === 'ping')).toHaveLength(1)

    harness.timers.advance(HEARTBEAT_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS)
    expect(harness.socket.state).toBe('reconnecting')
    expect(socket.readyState).toBe(3)
    expect(harness.timers.pendingTimeoutDelays()).toEqual([RECONNECT_BASE_MS])

    harness.timers.advance(RECONNECT_BASE_MS)
    expect(harness.sockets).toHaveLength(2)
  })

  it('a pong pushes the deadline back', () => {
    const harness = createHarness()
    const socket = connect(harness)

    harness.timers.advance(HEARTBEAT_INTERVAL_MS)
    socket.serverSend({ type: 'pong', t: HEARTBEAT_INTERVAL_MS })
    harness.timers.advance(HEARTBEAT_TIMEOUT_MS - 1)
    expect(harness.socket.state).toBe('connected')

    harness.timers.advance(2)
    expect(harness.socket.state).toBe('reconnecting')
  })
})

describe('MobileSocket reconnect backoff', () => {
  it('backs off 1s, 2s, 4s, 8s, 16s, then caps at 30s', () => {
    const harness = createHarness()
    connect(harness)
    const delays: number[] = []

    for (let attempt = 0; attempt < 7; attempt += 1) {
      currentSocket(harness).serverClose(1006)
      const [delay] = harness.timers.pendingTimeoutDelays()
      if (delay === undefined) throw new Error('no reconnect scheduled')
      delays.push(delay)
      harness.timers.advance(delay)
    }

    expect(delays).toEqual([
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS * 2,
      RECONNECT_BASE_MS * 4,
      RECONNECT_BASE_MS * 8,
      RECONNECT_BASE_MS * 16,
      RECONNECT_MAX_MS,
      RECONNECT_MAX_MS,
    ])
  })

  it.each([
    [MOBILE_CLOSE_CODES.UNAUTHORIZED, 'invalid'],
    [MOBILE_CLOSE_CODES.REVOKED, 'invalid'],
    [MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH, 'protocol_mismatch'],
    [MOBILE_CLOSE_CODES.HELLO_TIMEOUT, 'reconnecting'],
    [1006, 'reconnecting'],
  ] as const)('handles close code %s as %s', (code, expected) => {
    const harness = createHarness()
    const socket = connect(harness)
    socket.serverClose(code)

    expect(harness.socket.state).toBe(expected)
    if (expected === 'invalid') {
      expect(harness.onCredentialsInvalid).toHaveBeenCalledTimes(1)
      expect(harness.timers.pendingTimeoutDelays()).toEqual([])
    } else if (expected === 'protocol_mismatch') {
      expect(harness.onProtocolMismatch).toHaveBeenCalledTimes(1)
      expect(harness.timers.pendingTimeoutDelays()).toEqual([])
    } else {
      expect(harness.timers.pendingTimeoutDelays()).toEqual([RECONNECT_BASE_MS])
    }
  })

  it('device_revoked stops reconnecting and invalidates credentials', () => {
    const harness = createHarness()
    const socket = connect(harness)
    socket.serverSend({ type: 'device_revoked' })

    expect(harness.socket.state).toBe('invalid')
    expect(harness.onCredentialsInvalid).toHaveBeenCalledTimes(1)
    expect(socket.readyState).toBe(3)
    expect(harness.timers.pendingTimeoutDelays()).toEqual([])
  })

  it.each([
    ['visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['online', () => window.dispatchEvent(new Event('online'))],
  ] as const)('reconnects immediately on %s', (_name, trigger) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    const harness = createHarness()
    connect(harness)
    currentSocket(harness).serverClose(1006)
    expect(harness.socket.state).toBe('reconnecting')
    expect(harness.timers.pendingTimeoutDelays()).toEqual([RECONNECT_BASE_MS])

    trigger()
    expect(harness.sockets).toHaveLength(2)
    expect(harness.timers.pendingTimeoutDelays()).toEqual([])
  })

  it('stop closes the socket and clears timers', () => {
    const harness = createHarness()
    const socket = connect(harness)
    harness.socket.stop()
    expect(socket.readyState).toBe(3)
    expect(harness.timers.pendingTimeoutDelays()).toEqual([])
    expect(harness.socket.state).toBe('connected')
  })
})

function frameType(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const type = (frame as Record<string, unknown>)['type']
  return typeof type === 'string' ? type : undefined
}
