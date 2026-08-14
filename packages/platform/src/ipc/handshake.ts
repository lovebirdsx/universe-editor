/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared handshake primitives for the remote tunnel. Both ends exchange one
 *  JSON Control frame on a fresh socket before a PersistentProtocol owns it;
 *  these helpers read/write that frame and hand back the residual bytes so the
 *  successor protocol can be seeded without losing data.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../base/lifecycle.js'
import { ProtocolMessage, ProtocolMessageType, ProtocolReader, ProtocolWriter } from './frame.js'
import type { ISocket } from './socket.js'

export interface IControlFrameResult {
  readonly data: Uint8Array
  /** Bytes received after the control frame. MUST be fed synchronously (same
   *  microtask chain, no awaited I/O in between) into the successor protocol —
   *  `new PersistentProtocol({ socket, initialChunk })` or
   *  `beginAcceptReconnection(socket, initialChunk)` — or they are lost. */
  readonly residual: Uint8Array
}

/**
 * Wait for the first Control frame on a raw socket. Resolves with the frame
 * payload plus residual bytes; the internal reader is disposed before resolution
 * so the caller can attach the successor protocol. Rejects on timeout, socket
 * close, or a first frame that is not Control.
 */
export function readFirstControlFrame(
  socket: ISocket,
  timeoutMs: number,
): Promise<IControlFrameResult> {
  return new Promise<IControlFrameResult>((resolve, reject) => {
    const reader = new ProtocolReader(socket)
    // The reader/socket subscriptions are independent toDisposables — collect them
    // so they are released together on every settle path (success or failure).
    const subs = new DisposableStore()
    let settled = false

    const timer = setTimeout(() => {
      fail(new Error(`handshake: no control frame within ${timeoutMs}ms`))
    }, timeoutMs)
    // The timeout is only a backstop for a wedged peer; it must never be the last
    // ref'd handle holding the process open. On the app-quit path the in-flight
    // reconnect socket is destroyed synchronously, and without this the 10s
    // timeout would keep Node's event loop alive for the full window, blocking quit.
    timer.unref?.()

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      subs.dispose()
      reader.dispose()
      reject(err)
    }

    subs.add(
      socket.onClose(() => {
        fail(new Error('handshake: socket closed before control frame'))
      }),
    )

    subs.add(
      reader.onMessage((msg) => {
        if (settled) return
        if (msg.type !== ProtocolMessageType.Control) {
          fail(new Error(`handshake: expected control frame, got type ${msg.type}`))
          return
        }
        settled = true
        clearTimeout(timer)
        subs.dispose()
        // Grab leftovers and detach from the socket synchronously, inside this
        // data-event handler: the caller's `.then` continuation (a microtask) runs
        // before the next I/O event can deliver more bytes, so nothing slips by.
        const residual = reader.readEntireBuffer()
        reader.dispose()
        resolve({ data: msg.data, residual })
      }),
    )
  })
}

export function writeControlFrame(socket: ISocket, data: Uint8Array): void {
  const writer = new ProtocolWriter(socket)
  writer.write(new ProtocolMessage(ProtocolMessageType.Control, 0, 0, data))
  writer.dispose()
}

export function encodeControlJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

export function decodeControlJson<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T
}
