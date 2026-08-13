/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reliable framing protocol with acks / replay / keep-alive, adapted from
 *  VSCode's PersistentProtocol (base/parts/ipc/common/ipc.net.ts). Unlike the
 *  bare Protocol it keeps an unacknowledged send queue and re-drives it across
 *  socket swaps, so the channel layer above stays unaware of reconnects.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../base/event.js'
import type { Event } from '../base/event.js'
import { DisposableStore } from '../base/lifecycle.js'
import type { IMessagePassingProtocol } from './ipc.js'
import type { ISocket, SocketCloseEvent } from './socket.js'
import {
  ProtocolConstants,
  ProtocolMessage,
  ProtocolMessageType,
  ProtocolReader,
  ProtocolWriter,
} from './frame.js'

const EMPTY = new Uint8Array(0)

/**
 * Emitter that buffers events fired before the first listener registers and
 * replays them (in order) once one does. Needed because the handshake control
 * frame can be decoded before the connection owner has subscribed.
 */
export class BufferedEmitter<T> {
  private readonly _emitter: Emitter<T>
  public readonly event: Event<T>

  private _hasListeners = false
  private _isDeliveringMessages = false
  private _bufferedMessages: T[] = []

  constructor() {
    this._emitter = new Emitter<T>({
      onWillAddFirstListener: () => {
        this._hasListeners = true
        // Deliver after this call but before later messages arrive, preserving order.
        queueMicrotask(() => this._deliverMessages())
      },
      onDidRemoveLastListener: () => {
        this._hasListeners = false
      },
    })
    this.event = this._emitter.event
  }

  private _deliverMessages(): void {
    if (this._isDeliveringMessages) {
      return
    }
    this._isDeliveringMessages = true
    while (this._hasListeners && this._bufferedMessages.length > 0) {
      this._emitter.fire(this._bufferedMessages.shift()!)
    }
    this._isDeliveringMessages = false
  }

  public fire(event: T): void {
    if (this._hasListeners) {
      if (this._bufferedMessages.length > 0) {
        this._bufferedMessages.push(event)
      } else {
        this._emitter.fire(event)
      }
    } else {
      this._bufferedMessages.push(event)
    }
  }

  public flushBuffer(): void {
    this._bufferedMessages = []
  }

  public dispose(): void {
    this._emitter.dispose()
    this._bufferedMessages = []
  }
}

export class PersistentProtocol implements IMessagePassingProtocol {
  private _isReconnecting = false
  private _isDisposed = false
  private _didSendDisconnect = false

  private _outgoingUnackMsg: ProtocolMessage[] = []
  private _outgoingMsgId = 0

  private _incomingMsgId = 0
  private _incomingAckId = 0
  private _incomingMsgLastTime = 0
  private _incomingAckTimeout: ReturnType<typeof setTimeout> | null = null

  private _keepAliveInterval: ReturnType<typeof setInterval> | null = null
  private _lastSocketTimeoutTime = Date.now()

  private _socket: ISocket
  private _socketWriter: ProtocolWriter
  private _socketReader: ProtocolReader
  private _socketDisposables = new DisposableStore()

  private readonly _onControlMessage = new BufferedEmitter<Uint8Array>()
  readonly onControlMessage: Event<Uint8Array> = this._onControlMessage.event

  private readonly _onMessage = new BufferedEmitter<Uint8Array>()
  readonly onMessage: Event<Uint8Array> = this._onMessage.event

  private readonly _onDidDispose = new BufferedEmitter<void>()
  readonly onDidClose: Event<void> = this._onDidDispose.event

  private readonly _onSocketClose = new BufferedEmitter<SocketCloseEvent>()
  readonly onSocketClose: Event<SocketCloseEvent> = this._onSocketClose.event

  private readonly _onSocketTimeout = new BufferedEmitter<void>()
  readonly onSocketTimeout: Event<void> = this._onSocketTimeout.event

  constructor(opts: { socket: ISocket; initialChunk?: Uint8Array | null }) {
    this._socket = opts.socket
    this._socketWriter = this._socketDisposables.add(new ProtocolWriter(this._socket))
    this._socketReader = this._socketDisposables.add(new ProtocolReader(this._socket))
    this._socketDisposables.add(this._socketReader.onMessage((msg) => this._receiveMessage(msg)))
    this._socketDisposables.add(this._socket.onClose((e) => this._onSocketClose.fire(e)))

    if (opts.initialChunk) {
      this._socketReader.acceptChunk(opts.initialChunk)
    }

    this._keepAliveInterval = setInterval(() => {
      this._sendKeepAlive()
    }, ProtocolConstants.KeepAliveSendTime)
  }

  public getSocket(): ISocket {
    return this._socket
  }

  public getUnacknowledgedCount(): number {
    return this._outgoingUnackMsg.length
  }

  public getUnacknowledgedBytes(): number {
    let total = 0
    for (const msg of this._outgoingUnackMsg) {
      total += msg.data.byteLength
    }
    return total
  }

  public send(data: Uint8Array): void {
    const myId = ++this._outgoingMsgId
    this._incomingAckId = this._incomingMsgId
    const msg = new ProtocolMessage(ProtocolMessageType.Regular, myId, this._incomingAckId, data)
    this._outgoingUnackMsg.push(msg)
    if (!this._isReconnecting) {
      this._socketWriter.write(msg)
    }
  }

  public sendControl(data: Uint8Array): void {
    this._socketWriter.write(new ProtocolMessage(ProtocolMessageType.Control, 0, 0, data))
  }

  public sendDisconnect(): void {
    if (!this._didSendDisconnect) {
      this._didSendDisconnect = true
      this._socketWriter.write(new ProtocolMessage(ProtocolMessageType.Disconnect, 0, 0, EMPTY))
    }
  }

  public beginAcceptReconnection(socket: ISocket, initialDataChunk: Uint8Array | null): void {
    this._isReconnecting = true

    this._socketDisposables.dispose()
    this._socketDisposables = new DisposableStore()
    this._onControlMessage.flushBuffer()
    this._onSocketClose.flushBuffer()
    this._onSocketTimeout.flushBuffer()

    this._lastSocketTimeoutTime = Date.now()

    this._socket = socket
    this._socketWriter = this._socketDisposables.add(new ProtocolWriter(this._socket))
    this._socketReader = this._socketDisposables.add(new ProtocolReader(this._socket))
    this._socketDisposables.add(this._socketReader.onMessage((msg) => this._receiveMessage(msg)))
    this._socketDisposables.add(this._socket.onClose((e) => this._onSocketClose.fire(e)))

    this._socketReader.acceptChunk(initialDataChunk)
  }

  public endAcceptReconnection(): void {
    this._isReconnecting = false

    // Re-ack the highest seq we've seen so the peer can release its queue, then
    // re-send everything still unacknowledged on our side (ids unchanged).
    this._incomingAckId = this._incomingMsgId
    this._socketWriter.write(
      new ProtocolMessage(ProtocolMessageType.Ack, 0, this._incomingAckId, EMPTY),
    )

    for (const msg of this._outgoingUnackMsg) {
      this._socketWriter.write(msg)
    }
  }

  public dispose(): void {
    if (this._isDisposed) {
      return
    }
    this._isDisposed = true

    if (this._incomingAckTimeout) {
      clearTimeout(this._incomingAckTimeout)
      this._incomingAckTimeout = null
    }
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval)
      this._keepAliveInterval = null
    }

    this._onDidDispose.fire()
    this._socketDisposables.dispose()
    this._onControlMessage.dispose()
    this._onMessage.dispose()
    this._onDidDispose.dispose()
    this._onSocketClose.dispose()
    this._onSocketTimeout.dispose()
  }

  private _receiveMessage(msg: ProtocolMessage): void {
    if (msg.ack > 0) {
      this._ackNow(msg.ack)
    }

    switch (msg.type) {
      case ProtocolMessageType.None:
        break
      case ProtocolMessageType.Regular:
        if (msg.id === this._incomingMsgId + 1) {
          this._incomingMsgId = msg.id
          this._incomingMsgLastTime = Date.now()
          this._sendAckCheck()
          this._onMessage.fire(msg.data)
        } else if (msg.id <= this._incomingMsgId) {
          // Replay of an already-delivered message: swallow, but still re-arm
          // the ack so the peer can release its queue.
          this._sendAckCheck()
        }
        break
      case ProtocolMessageType.Control:
        this._onControlMessage.fire(msg.data)
        break
      case ProtocolMessageType.Ack:
        break
      case ProtocolMessageType.Disconnect:
        this._onDidDispose.fire()
        break
      case ProtocolMessageType.ReplayRequest:
        break
      case ProtocolMessageType.Pause:
        break
      case ProtocolMessageType.Resume:
        break
      case ProtocolMessageType.KeepAlive:
        break
    }
  }

  private _ackNow(ack: number): void {
    while (this._outgoingUnackMsg.length > 0) {
      const first = this._outgoingUnackMsg[0]
      if (first && first.id <= ack) {
        this._outgoingUnackMsg.shift()
      } else {
        break
      }
    }
  }

  private _sendAckCheck(): void {
    if (this._incomingMsgId <= this._incomingAckId) {
      return
    }
    if (this._incomingAckTimeout) {
      return
    }
    const timeSinceLastIncomingMsg = Date.now() - this._incomingMsgLastTime
    if (timeSinceLastIncomingMsg >= ProtocolConstants.AcknowledgeTime) {
      this._sendAck()
      return
    }
    this._incomingAckTimeout = setTimeout(
      () => {
        this._incomingAckTimeout = null
        this._sendAckCheck()
      },
      ProtocolConstants.AcknowledgeTime - timeSinceLastIncomingMsg + 5,
    )
  }

  private _sendAck(): void {
    if (this._incomingMsgId <= this._incomingAckId) {
      return
    }
    this._incomingAckId = this._incomingMsgId
    this._socketWriter.write(
      new ProtocolMessage(ProtocolMessageType.Ack, 0, this._incomingAckId, EMPTY),
    )
  }

  private _sendKeepAlive(): void {
    this._incomingAckId = this._incomingMsgId
    this._socketWriter.write(
      new ProtocolMessage(ProtocolMessageType.KeepAlive, 0, this._incomingAckId, EMPTY),
    )
    this._keepAliveTimeoutCheck()
  }

  private _keepAliveTimeoutCheck(): void {
    if (this._isReconnecting) {
      return
    }
    const now = Date.now()
    const timeSinceLastReceived = now - this._socketReader.lastReadTime
    const timeSinceLastTimeout = now - this._lastSocketTimeoutTime
    if (
      timeSinceLastReceived >= ProtocolConstants.TimeoutTime &&
      timeSinceLastTimeout >= ProtocolConstants.TimeoutTime
    ) {
      this._lastSocketTimeoutTime = now
      this._onSocketTimeout.fire()
    }
  }
}
