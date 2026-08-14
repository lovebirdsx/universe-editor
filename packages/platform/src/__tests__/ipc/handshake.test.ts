/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/handshake.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Emitter } from '../../base/event.js'
import type { ISocket, SocketCloseEvent } from '../../ipc/socket.js'
import { readFirstControlFrame, writeControlFrame } from '../../ipc/handshake.js'
import { withLeakCheck } from '../_helpers/leakAssert.js'

/** Loop-back socket: every write is delivered back through onData synchronously. */
class LoopSocket implements ISocket {
  private readonly _onData = new Emitter<Uint8Array>()
  readonly onData = this._onData.event
  private readonly _onClose = new Emitter<SocketCloseEvent>()
  readonly onClose = this._onClose.event
  private readonly _onEnd = new Emitter<void>()
  readonly onEnd = this._onEnd.event
  private _disposed = false

  write(buffer: Uint8Array): void {
    if (this._disposed) return
    this._onData.fire(buffer)
  }

  end(): void {}

  fireClose(): void {
    this._onClose.fire({ hadError: false })
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onData.dispose()
    this._onClose.dispose()
    this._onEnd.dispose()
  }
}

describe('readFirstControlFrame', () => {
  it('resolves the control frame and releases reader/subscriptions', async () => {
    await withLeakCheck(async () => {
      const socket = new LoopSocket()
      const payload = new TextEncoder().encode('{"type":"ok"}')
      const promise = readFirstControlFrame(socket, 1000)
      writeControlFrame(socket, payload)
      const result = await promise
      expect(result.data).toEqual(payload)
      expect(result.residual.byteLength).toBe(0)
      socket.dispose()
    })
  })

  it('releases reader/subscriptions when the socket closes first', async () => {
    await withLeakCheck(async () => {
      const socket = new LoopSocket()
      const promise = readFirstControlFrame(socket, 1000)
      socket.fireClose()
      await expect(promise).rejects.toThrow('socket closed before control frame')
      socket.dispose()
    })
  })
})
