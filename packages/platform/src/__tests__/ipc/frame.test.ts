/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/frame.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ChunkStream,
  ProtocolConstants,
  ProtocolMessage,
  ProtocolMessageType,
  ProtocolReader,
  ProtocolWriter,
} from '../../ipc/frame.js'
import { Emitter } from '../../base/event.js'
import type { ISocket, SocketCloseEvent } from '../../ipc/socket.js'

class MemorySocket implements ISocket {
  private readonly _onData = new Emitter<Uint8Array>()
  readonly onData = this._onData.event
  private readonly _onClose = new Emitter<SocketCloseEvent>()
  readonly onClose = this._onClose.event
  private readonly _onEnd = new Emitter<void>()
  readonly onEnd = this._onEnd.event

  private _peer: MemorySocket | null = null
  private _disposed = false
  readonly writes: Uint8Array[] = []

  write(buffer: Uint8Array): void {
    if (this._disposed) return
    const copy = buffer.slice()
    this.writes.push(copy)
    const peer = this._peer
    if (peer) {
      queueMicrotask(() => {
        if (!peer._disposed) peer._onData.fire(copy)
      })
    }
  }

  end(): void {}

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onData.dispose()
    this._onClose.dispose()
    this._onEnd.dispose()
  }

  connect(peer: MemorySocket): void {
    this._peer = peer
  }
}

function createSocketPair(): [MemorySocket, MemorySocket] {
  const a = new MemorySocket()
  const b = new MemorySocket()
  a.connect(b)
  b.connect(a)
  return [a, b]
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

function encodeHeader(type: number, id: number, ack: number, dataLength: number): Uint8Array {
  const header = new Uint8Array(ProtocolConstants.HeaderLength)
  const view = new DataView(header.buffer)
  view.setUint8(0, type)
  view.setUint32(1, id)
  view.setUint32(5, ack)
  view.setUint32(9, dataLength)
  return header
}

function encodeFrame(type: number, id: number, ack: number, data: Uint8Array): Uint8Array {
  const header = encodeHeader(type, id, ack, data.byteLength)
  const frame = new Uint8Array(header.byteLength + data.byteLength)
  frame.set(header, 0)
  frame.set(data, header.byteLength)
  return frame
}

describe('ChunkStream', () => {
  it('concatenates chunks across reads', () => {
    const stream = new ChunkStream()
    stream.acceptChunk(new Uint8Array([1, 2, 3]))
    stream.acceptChunk(new Uint8Array([4, 5]))
    expect(stream.byteLength).toBe(5)
    expect(Array.from(stream.read(2))).toEqual([1, 2])
    expect(Array.from(stream.read(3))).toEqual([3, 4, 5])
    expect(stream.byteLength).toBe(0)
  })

  it('returns a view of the first chunk on the fast path', () => {
    const stream = new ChunkStream()
    const chunk = new Uint8Array([10, 20, 30, 40])
    stream.acceptChunk(chunk)
    const head = stream.read(2)
    expect(Array.from(head)).toEqual([10, 20])
    expect(head.buffer).toBe(chunk.buffer)
    expect(Array.from(stream.read(2))).toEqual([30, 40])
  })
})

describe('ProtocolReader / ProtocolWriter', () => {
  it('round-trips a single frame', async () => {
    const [a, b] = createSocketPair()
    const writer = new ProtocolWriter(a)
    const reader = new ProtocolReader(b)
    const received: ProtocolMessage[] = []
    reader.onMessage((m) => received.push(m))

    const data = new Uint8Array([1, 2, 3, 4, 5])
    writer.write(new ProtocolMessage(ProtocolMessageType.Regular, 7, 3, data))
    await flush()

    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe(ProtocolMessageType.Regular)
    expect(received[0]!.id).toBe(7)
    expect(received[0]!.ack).toBe(3)
    expect(Array.from(received[0]!.data)).toEqual([1, 2, 3, 4, 5])

    reader.dispose()
    writer.dispose()
    a.dispose()
    b.dispose()
  })

  it('parses a frame fed one byte at a time', () => {
    const reader = new ProtocolReader(new MemorySocket())
    const messages: ProtocolMessage[] = []
    reader.onMessage((m) => messages.push(m))

    const data = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    const frame = encodeFrame(ProtocolMessageType.Regular, 42, 3, data)
    for (const byte of frame) {
      reader.acceptChunk(new Uint8Array([byte]))
    }

    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe(42)
    expect(messages[0]!.ack).toBe(3)
    expect(Array.from(messages[0]!.data)).toEqual(Array.from(data))
    reader.dispose()
  })

  it('parses a frame fed in 7-byte chunks', () => {
    const reader = new ProtocolReader(new MemorySocket())
    const messages: ProtocolMessage[] = []
    reader.onMessage((m) => messages.push(m))

    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const frame = encodeFrame(ProtocolMessageType.Regular, 5, 0, data)
    for (let i = 0; i < frame.length; i += 7) {
      reader.acceptChunk(frame.subarray(i, i + 7))
    }

    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe(5)
    expect(Array.from(messages[0]!.data)).toEqual(Array.from(data))
    reader.dispose()
  })

  it('parses multiple frames arriving in one chunk', () => {
    const reader = new ProtocolReader(new MemorySocket())
    const messages: ProtocolMessage[] = []
    reader.onMessage((m) => messages.push(m))

    const f1 = encodeFrame(ProtocolMessageType.Regular, 1, 0, new Uint8Array([1, 1, 1]))
    const f2 = encodeFrame(ProtocolMessageType.Regular, 2, 0, new Uint8Array([2, 2]))
    const f3 = encodeFrame(ProtocolMessageType.Control, 0, 0, new Uint8Array([3]))

    const combined = new Uint8Array(f1.length + f2.length + f3.length)
    combined.set(f1, 0)
    combined.set(f2, f1.length)
    combined.set(f3, f1.length + f2.length)
    reader.acceptChunk(combined)

    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.type)).toEqual([
      ProtocolMessageType.Regular,
      ProtocolMessageType.Regular,
      ProtocolMessageType.Control,
    ])
    expect(messages.map((m) => m.id)).toEqual([1, 2, 0])
    expect(messages.map((m) => Array.from(m.data))).toEqual([[1, 1, 1], [2, 2], [3]])
    reader.dispose()
  })

  it('slices large frames into MaxSocketWriteChunk-sized writes', () => {
    const socket = new MemorySocket()
    const writer = new ProtocolWriter(socket)
    const data = new Uint8Array(300000)
    for (let i = 0; i < data.length; i++) data[i] = i % 251

    writer.write(new ProtocolMessage(ProtocolMessageType.Regular, 1, 0, data))

    const writes = socket.writes
    expect(writes.length).toBe(3)

    let total = 0
    for (const w of writes) total += w.byteLength
    expect(total).toBe(ProtocolConstants.HeaderLength + data.length)

    const reconstructed = new Uint8Array(total)
    let offset = 0
    for (const w of writes) {
      reconstructed.set(w, offset)
      offset += w.byteLength
    }
    const view = new DataView(reconstructed.buffer)
    expect(view.getUint8(0)).toBe(ProtocolMessageType.Regular)
    expect(view.getUint32(1)).toBe(1)
    expect(view.getUint32(9)).toBe(data.length)
    expect(Array.from(reconstructed.subarray(ProtocolConstants.HeaderLength))).toEqual(
      Array.from(data),
    )

    writer.dispose()
    socket.dispose()
  })

  it('drops writes after dispose', () => {
    const socket = new MemorySocket()
    const writer = new ProtocolWriter(socket)
    writer.dispose()
    writer.write(new ProtocolMessage(ProtocolMessageType.Regular, 1, 0, new Uint8Array([1])))
    expect(socket.writes).toHaveLength(0)
    socket.dispose()
  })

  it('returns residual unconsumed bytes from readEntireBuffer', () => {
    const reader = new ProtocolReader(new MemorySocket())
    const messages: ProtocolMessage[] = []
    reader.onMessage((m) => messages.push(m))

    const header = encodeHeader(ProtocolMessageType.Regular, 1, 0, 5)
    const partial = new Uint8Array(header.length + 3)
    partial.set(header, 0)
    partial.set([10, 20, 30], header.length)
    reader.acceptChunk(partial)

    expect(messages).toHaveLength(0)
    expect(Array.from(reader.readEntireBuffer())).toEqual([10, 20, 30])
    reader.dispose()
  })
})
