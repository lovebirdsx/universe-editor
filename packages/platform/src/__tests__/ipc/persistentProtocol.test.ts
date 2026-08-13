/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/persistentProtocol.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersistentProtocol } from '../../ipc/persistentProtocol.js'
import { ProtocolConstants, ProtocolMessageType } from '../../ipc/frame.js'
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

  emitClose(event: SocketCloseEvent): void {
    this._onClose.fire(event)
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

function createPair(): {
  a: PersistentProtocol
  b: PersistentProtocol
  socketA: MemorySocket
  socketB: MemorySocket
} {
  const [socketA, socketB] = createSocketPair()
  const a = new PersistentProtocol({ socket: socketA })
  const b = new PersistentProtocol({ socket: socketB })
  return { a, b, socketA, socketB }
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('PersistentProtocol', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delivers regular messages in order and counts the unacknowledged queue', async () => {
    const { a, b } = createPair()
    const received: Uint8Array[] = []
    b.onMessage((d) => received.push(d))

    a.send(bytes(1, 2, 3))
    a.send(bytes(4, 5))
    await flush()

    expect(received.map((d) => Array.from(d))).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
    expect(a.getUnacknowledgedCount()).toBe(2)
    expect(a.getUnacknowledgedBytes()).toBe(5)

    a.dispose()
    b.dispose()
  })

  it('shrinks the unacknowledged queue after a standalone ack', async () => {
    const { a, b } = createPair()
    const received: Uint8Array[] = []
    b.onMessage((d) => received.push(d))

    a.send(bytes(1, 2, 3))
    await flush()
    expect(received).toHaveLength(1)
    expect(a.getUnacknowledgedCount()).toBe(1)

    vi.advanceTimersByTime(ProtocolConstants.AcknowledgeTime + 100)
    await flush()
    expect(a.getUnacknowledgedCount()).toBe(0)

    a.dispose()
    b.dispose()
  })

  it('replays unacknowledged messages after reconnection and the peer dedups them', async () => {
    const { a, b } = createPair()
    const received: Uint8Array[] = []
    b.onMessage((d) => received.push(d))

    a.send(bytes(1))
    a.send(bytes(2))
    await flush()
    expect(received).toHaveLength(2)
    expect(a.getUnacknowledgedCount()).toBe(2)

    const [socketA2, socketB2] = createSocketPair()
    a.beginAcceptReconnection(socketA2, null)
    b.beginAcceptReconnection(socketB2, null)
    a.endAcceptReconnection()
    b.endAcceptReconnection()
    await flush()

    expect(received).toHaveLength(2)
    expect(a.getUnacknowledgedCount()).toBe(0)

    a.dispose()
    b.dispose()
    socketA2.dispose()
    socketB2.dispose()
  })

  it('buffers control messages until a listener registers', async () => {
    const { a, b } = createPair()
    a.sendControl(bytes(9, 9, 9))
    await flush()

    const received: Uint8Array[] = []
    b.onControlMessage((d) => received.push(d))
    await flush()

    expect(received.map((d) => Array.from(d))).toEqual([[9, 9, 9]])

    a.dispose()
    b.dispose()
  })

  it('sends a keep-alive frame after KeepAliveSendTime', () => {
    const { a, socketA } = createPair()
    expect(socketA.writes).toHaveLength(0)

    vi.advanceTimersByTime(ProtocolConstants.KeepAliveSendTime)

    expect(socketA.writes).toHaveLength(1)
    const frame = socketA.writes[0]!
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(view.getUint8(0)).toBe(ProtocolMessageType.KeepAlive)

    a.dispose()
  })

  it('fires onSocketTimeout after TimeoutTime without inbound data', () => {
    const { a, b } = createPair()
    let timeouts = 0
    a.onSocketTimeout(() => timeouts++)

    vi.advanceTimersByTime(ProtocolConstants.TimeoutTime)
    expect(timeouts).toBe(1)

    a.dispose()
    b.dispose()
  })

  it('counts unacknowledged bytes across the queue', () => {
    const { a, b } = createPair()
    a.send(bytes(1, 2, 3))
    a.send(bytes(4, 5, 6, 7, 8))
    expect(a.getUnacknowledgedCount()).toBe(2)
    expect(a.getUnacknowledgedBytes()).toBe(8)

    a.dispose()
    b.dispose()
  })

  it('fires onDidClose on a Disconnect frame but not on socket close', async () => {
    const { a, b, socketA } = createPair()
    let closed = 0
    let socketClosed = 0
    a.onDidClose(() => closed++)
    a.onSocketClose(() => socketClosed++)

    socketA.emitClose({ hadError: false })
    await flush()
    expect(closed).toBe(0)
    expect(socketClosed).toBe(1)

    b.sendDisconnect()
    await flush()
    expect(closed).toBe(1)

    a.dispose()
    b.dispose()
  })

  it('fires onDidClose on explicit dispose', () => {
    const { a, b } = createPair()
    let closed = 0
    a.onDidClose(() => closed++)

    a.dispose()
    expect(closed).toBe(1)

    b.dispose()
  })
})
