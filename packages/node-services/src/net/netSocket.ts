/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  net.Socket adapter for the transport-level ISocket contract
 *  (packages/platform/src/ipc/socket.ts). Node-only: it depends on node:net,
 *  which is why it lives here in @universe-editor/node-services instead of the
 *  process-agnostic platform package.
 *--------------------------------------------------------------------------------------------*/

import { connect, type Socket as NetSocket } from 'node:net'
import { Disposable, Emitter, type ISocket, type SocketCloseEvent } from '@universe-editor/platform'

export class NodeSocket extends Disposable implements ISocket {
  private readonly _onData = this._register(new Emitter<Uint8Array>())
  readonly onData = this._onData.event

  private readonly _onClose = this._register(new Emitter<SocketCloseEvent>())
  readonly onClose = this._onClose.event

  private readonly _onEnd = this._register(new Emitter<void>())
  readonly onEnd = this._onEnd.event

  private lastError: Error | undefined

  constructor(private readonly socket: NetSocket) {
    super()
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this._onData.fire(chunk))
    socket.on('error', (err) => {
      this.lastError = err
    })
    socket.on('close', (hadError) => {
      const error = this.lastError
      this._onClose.fire(error ? { hadError, error } : { hadError })
    })
    socket.on('end', () => this._onEnd.fire())
  }

  write(buffer: Uint8Array): void {
    if (this.socket.destroyed) {
      return
    }
    this.socket.write(buffer, (err) => {
      if (err) {
        this.lastError = err
      }
    })
  }

  end(): void {
    this.socket.end()
  }

  override dispose(): void {
    this.socket.removeAllListeners()
    this.socket.destroy()
    super.dispose()
  }
}

export function connectNodeSocket(port: number, host = '127.0.0.1'): Promise<NodeSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host })
    socket.once('connect', () => resolve(new NodeSocket(socket)))
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
  })
}
