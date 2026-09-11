/*---------------------------------------------------------------------------------------------
 *  Tests for the frame-size gate in the channel layer.
 *
 *  The pure decision function is covered in ipcFrameGuard.test.ts. What is covered here
 *  is the part that actually prevents an OOM: that a refused frame degrades instead of
 *  being handed to `JSON.parse`, on both the send and the receive side, and that the
 *  caller still learns about it. Refusals are induced through a codec that refuses on a
 *  marker rather than by materialising a real 128MiB payload — the degradation paths are
 *  codec-independent by construction, so a stub exercises them exactly.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach } from 'vitest'
import {
  ChannelClient,
  ChannelPair,
  ChannelServer,
  createChannelFromObject,
  defaultCodec,
  InMemoryMessagePassingProtocol,
  type IChannel,
  type IpcCodec,
  type IpcMessage,
} from '../../ipc/ipc.js'
import { Emitter, type Event } from '../../base/event.js'
import {
  IPC_FRAME_MAX_BYTES,
  IPC_FRAME_TOO_LARGE_CODE,
  IPC_FRAME_WARN_BYTES,
  IpcFrameTooLargeError,
  assertIpcFrameWithinLimit,
  ipcFrameStats,
  resetIpcFrameDiagnosticsForTests,
  snapshotIpcFrames,
} from '../../ipc/ipcFrameGuard.js'

const OVERSIZED = '__force_oversized__'

/** Refuses any message whose JSON carries the marker; passes everything else through. */
const refusingCodec: IpcCodec = {
  encode(msg: IpcMessage): Uint8Array {
    assertIpcFrameWithinLimit(
      JSON.stringify(msg).includes(OVERSIZED) ? IPC_FRAME_MAX_BYTES + 1 : 1024,
    )
    return defaultCodec.encode(msg)
  },
  decode: (data) => defaultCodec.decode(data),
}

const flushMicrotasks = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/**
 * A warn-sized frame without materialising 32MiB. Every guard reads `byteLength` before
 * touching the payload and the transport forwards the object untouched, so shadowing the
 * accessor with an own property is enough to make a real, decodable frame look large.
 */
const withByteLength = (frame: Uint8Array, byteLength: number): Uint8Array => {
  Object.defineProperty(frame, 'byteLength', { value: byteLength })
  return frame
}

const LARGE = '__force_large__'

/** Inflates the reported size of any frame whose JSON carries the marker. */
const inflatingCodec: IpcCodec = {
  encode(msg: IpcMessage): Uint8Array {
    const frame = defaultCodec.encode(msg)
    return JSON.stringify(msg).includes(LARGE) ? withByteLength(frame, IPC_FRAME_WARN_BYTES) : frame
  },
  decode: (data) => defaultCodec.decode(data),
}

/**
 * An over-limit frame without materialising 128MiB. Both guards read `byteLength` before
 * touching the payload, and the transport forwards the object untouched — so the size is
 * all a receive-side test needs. The real-size allocation is kept for the one test whose
 * subject *is* `defaultCodec.decode`.
 */
const oversizedFrame = (): Uint8Array =>
  ({ byteLength: IPC_FRAME_MAX_BYTES + 1 }) as unknown as Uint8Array

beforeEach(() => resetIpcFrameDiagnosticsForTests())

describe('send-side degradation', () => {
  it('rejects the caller when the reply is too large instead of leaving it hanging', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto, true, refusingCodec)
    const client = new ChannelClient(clientProto, true, refusingCodec)
    server.registerChannel('big', createChannelFromObject({ get: () => ({ blob: OVERSIZED }) }))

    await expect(client.getChannel('big').call('get')).rejects.toMatchObject({
      name: 'IpcFrameTooLargeError',
      code: IPC_FRAME_TOO_LARGE_CODE,
    })
    expect(ipcFrameStats().oversized).toBe(1)

    client.dispose()
    server.dispose()
  })

  it('rejects the caller when the request itself is too large, without sending it', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const received: IpcMessage[] = []
    const server = new ChannelServer(serverProto, true, refusingCodec)
    const original = server.handleMessage.bind(server)
    server.handleMessage = (msg) => {
      received.push(msg)
      original(msg)
    }
    const client = new ChannelClient(clientProto, true, refusingCodec)

    await expect(client.getChannel('big').call('set', { blob: OVERSIZED })).rejects.toBeInstanceOf(
      IpcFrameTooLargeError,
    )
    await flushMicrotasks()
    expect(received).toHaveLength(0)

    client.dispose()
    server.dispose()
  })

  it('names the offending target in the degraded error the caller receives', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto, true, refusingCodec)
    const client = new ChannelClient(clientProto, true, refusingCodec)
    server.registerChannel('big', createChannelFromObject({ get: () => OVERSIZED }))

    await expect(client.getChannel('big').call('get')).rejects.toThrow(/big\.get/)

    client.dispose()
    server.dispose()
  })
})

describe('receive-side refusal', () => {
  it('drops an over-limit frame and keeps serving the channel', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)
    server.registerChannel('math', createChannelFromObject({ add: (a) => (a as number) + 1 }))

    clientProto.send(oversizedFrame())
    await flushMicrotasks()
    expect(ipcFrameStats()).toMatchObject({ oversized: 1 })
    expect(snapshotIpcFrames().at(-1)).toMatchObject({ direction: 'in', type: 'unparsed' })

    await expect(client.getChannel('math').call('add', 1)).resolves.toBe(2)

    client.dispose()
    server.dispose()
  })

  it('refuses the frame before JSON.parse ever sees it', () => {
    // The crash being defended against happened *inside* parse, where no try/catch can
    // help. Reaching parse at all with this frame is the failure, so assert on the call
    // itself rather than on the resulting error.
    expect(() => defaultCodec.decode(new Uint8Array(IPC_FRAME_MAX_BYTES + 1))).toThrow(
      IpcFrameTooLargeError,
    )
  })

  it('drops an over-limit event but keeps the subscription alive', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto, true, refusingCodec)
    const client = new ChannelClient(clientProto, true, refusingCodec)
    const onUpdate = new Emitter<unknown>()
    const feed: IChannel = {
      call: <T>() => Promise.resolve(undefined as T),
      listen: <T>() => onUpdate.event as Event<T>,
    }
    server.registerChannel('feed', feed)

    const seen: unknown[] = []
    client.getChannel('feed').listen('update')((v) => seen.push(v))
    await flushMicrotasks()

    onUpdate.fire({ blob: OVERSIZED })
    onUpdate.fire('small')
    await flushMicrotasks()

    expect(seen).toEqual(['small'])
    expect(ipcFrameStats().oversized).toBe(1)

    client.dispose()
    server.dispose()
  })

  it('applies the same refusal on the ChannelPair path', async () => {
    const [a, b] = InMemoryMessagePassingProtocol.createPair()
    const pair = new ChannelPair(a)
    pair.server.registerChannel('math', createChannelFromObject({ add: (x) => x }))

    b.send(oversizedFrame())
    await flushMicrotasks()
    expect(ipcFrameStats()).toMatchObject({ oversized: 1, seen: 1 })

    pair.dispose()
  })
})

describe('large-frame recording', () => {
  it('records a large reply the server actually sent, not only the ones it refused', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto, true, inflatingCodec)
    const client = new ChannelClient(clientProto, true, inflatingCodec)
    server.registerChannel('big', createChannelFromObject({ get: () => LARGE }))

    await expect(client.getChannel('big').call('get')).resolves.toBe(LARGE)

    // Without this the headline says `warned=0 largest=4MiB` while the receiver's log
    // carries `large inbound ipc frame 47.6MB` for the very same frame.
    const sent = snapshotIpcFrames().filter((f) => f.direction === 'out')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'response', channel: 'big', name: 'get', id: 1 })
    expect(ipcFrameStats().largestBytes).toBe(IPC_FRAME_WARN_BYTES)
    expect(ipcFrameStats().largestLabel).toBe('out response big.get #1')

    client.dispose()
    server.dispose()
  })

  it('names the request a large reply answers, using the pending request', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto, true, inflatingCodec)
    const client = new ChannelClient(clientProto, true, inflatingCodec)
    server.registerChannel('big', createChannelFromObject({ get: () => LARGE }))

    await expect(client.getChannel('big').call('get')).resolves.toBe(LARGE)

    // A response carries no channel on the wire; the caller that issued the request is
    // the only party that can name the payload, and it does so before settling.
    const received = snapshotIpcFrames().filter((f) => f.direction === 'in')
    expect(received.at(-1)).toMatchObject({ type: 'response', channel: 'big', name: 'get' })

    client.dispose()
    server.dispose()
  })

  it('falls back to the bare id when the reply answers a request this peer never made', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const client = new ChannelClient(clientProto, true, inflatingCodec)
    const server = new ChannelServer(serverProto, true, inflatingCodec)

    clientProto.send(inflatingCodec.encode({ type: 'response', id: 999, data: LARGE }))
    await flushMicrotasks()

    expect(snapshotIpcFrames().at(-1)).toMatchObject({
      direction: 'in',
      type: 'response',
      channel: '',
      name: '',
      id: 999,
    })

    client.dispose()
    server.dispose()
  })

  it('leaves sends under the warn line off the ring entirely', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)
    server.registerChannel('math', createChannelFromObject({ add: (a) => (a as number) + 1 }))

    await expect(client.getChannel('math').call('add', 1)).resolves.toBe(2)

    // The send path pays one integer compare per frame and nothing else.
    expect(snapshotIpcFrames().filter((f) => f.direction === 'out')).toHaveLength(0)

    client.dispose()
    server.dispose()
  })
})
