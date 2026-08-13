/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Binary framing for the remote tunnel, adapted from VSCode's
 *  base/parts/ipc/common/ipc.net.ts. A frame is a 13-byte big-endian header
 *  (type u8 | id u32 | ack u32 | dataLength u32) followed by dataLength bytes.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../base/event.js'
import type { Event } from '../base/event.js'
import { Disposable } from '../base/lifecycle.js'
import type { ISocket } from './socket.js'

// Regular enums (not const): consumers outside project-references territory
// (apps/editor with isolatedModules) must be able to read the values from dist.
export enum ProtocolMessageType {
  None = 0,
  Regular = 1,
  Control = 2,
  Ack = 3,
  Disconnect = 5,
  ReplayRequest = 6,
  Pause = 7,
  Resume = 8,
  KeepAlive = 9,
}

export enum ProtocolConstants {
  HeaderLength = 13,
  AcknowledgeTime = 2000,
  TimeoutTime = 20000,
  ReconnectionGraceTime = 10800000,
  ReconnectionShortGraceTime = 300000,
  KeepAliveSendTime = 5000,
  MaxSocketWriteChunk = 262144,
  UnacknowledgedBytesBudget = 67108864,
}

export class ProtocolMessage {
  /** Epoch the frame was written; drives replay/ack timing. */
  public writtenTime = 0

  constructor(
    public readonly type: ProtocolMessageType,
    public readonly id: number,
    public readonly ack: number,
    public readonly data: Uint8Array,
  ) {}
}

export class ChunkStream {
  private _chunks: Uint8Array[] = []
  private _totalLength = 0

  get byteLength(): number {
    return this._totalLength
  }

  acceptChunk(buff: Uint8Array): void {
    this._chunks.push(buff)
    this._totalLength += buff.byteLength
  }

  read(byteCount: number): Uint8Array {
    if (byteCount === 0) {
      return new Uint8Array(0)
    }
    if (byteCount > this._totalLength) {
      throw new Error('Cannot read so many bytes!')
    }

    const first = this._chunks[0]!
    if (first.byteLength === byteCount) {
      this._chunks.shift()
      this._totalLength -= byteCount
      return first
    }

    if (first.byteLength > byteCount) {
      // Fast path: the read stays within the first chunk, so hand back a view
      // instead of copying.
      this._chunks[0] = first.subarray(byteCount)
      this._totalLength -= byteCount
      return first.subarray(0, byteCount)
    }

    const result = new Uint8Array(byteCount)
    let resultOffset = 0
    while (byteCount > 0) {
      const chunk = this._chunks[0]!
      if (chunk.byteLength > byteCount) {
        result.set(chunk.subarray(0, byteCount), resultOffset)
        resultOffset += byteCount
        this._chunks[0] = chunk.subarray(byteCount)
        this._totalLength -= byteCount
        byteCount = 0
      } else {
        result.set(chunk, resultOffset)
        resultOffset += chunk.byteLength
        this._chunks.shift()
        this._totalLength -= chunk.byteLength
        byteCount -= chunk.byteLength
      }
    }
    return result
  }
}

export class ProtocolReader extends Disposable {
  private _isDisposed = false
  private readonly _incomingData = new ChunkStream()
  public lastReadTime: number

  private readonly _onMessage = this._register(new Emitter<ProtocolMessage>())
  public readonly onMessage: Event<ProtocolMessage> = this._onMessage.event

  private readonly _state = {
    readHead: true,
    readLen: ProtocolConstants.HeaderLength,
    messageType: ProtocolMessageType.None,
    id: 0,
    ack: 0,
  }

  constructor(socket: ISocket) {
    super()
    this.lastReadTime = Date.now()
    this._register(socket.onData((data) => this.acceptChunk(data)))
  }

  public acceptChunk(data: Uint8Array | null): void {
    if (!data || data.byteLength === 0) {
      return
    }

    this.lastReadTime = Date.now()
    this._incomingData.acceptChunk(data)

    while (this._incomingData.byteLength >= this._state.readLen) {
      const buff = this._incomingData.read(this._state.readLen)

      if (this._state.readHead) {
        const view = new DataView(buff.buffer, buff.byteOffset, buff.byteLength)
        this._state.readHead = false
        this._state.readLen = view.getUint32(9)
        this._state.messageType = view.getUint8(0) as ProtocolMessageType
        this._state.id = view.getUint32(1)
        this._state.ack = view.getUint32(5)
      } else {
        const messageType = this._state.messageType
        const id = this._state.id
        const ack = this._state.ack

        this._state.readHead = true
        this._state.readLen = ProtocolConstants.HeaderLength
        this._state.messageType = ProtocolMessageType.None
        this._state.id = 0
        this._state.ack = 0

        this._onMessage.fire(new ProtocolMessage(messageType, id, ack, buff))

        if (this._isDisposed) {
          break
        }
      }
    }
  }

  public readEntireBuffer(): Uint8Array {
    return this._incomingData.read(this._incomingData.byteLength)
  }

  public override dispose(): void {
    this._isDisposed = true
    super.dispose()
  }
}

export class ProtocolWriter {
  private _isDisposed = false
  private readonly _socket: ISocket
  public lastWriteTime = 0

  constructor(socket: ISocket) {
    this._socket = socket
  }

  public write(msg: ProtocolMessage): void {
    if (this._isDisposed) {
      return
    }
    msg.writtenTime = Date.now()
    this.lastWriteTime = Date.now()

    const header = new Uint8Array(ProtocolConstants.HeaderLength)
    const view = new DataView(header.buffer)
    view.setUint8(0, msg.type)
    view.setUint32(1, msg.id)
    view.setUint32(5, msg.ack)
    view.setUint32(9, msg.data.byteLength)

    const data = msg.data
    if (data.byteLength <= ProtocolConstants.MaxSocketWriteChunk - ProtocolConstants.HeaderLength) {
      const combined = new Uint8Array(header.byteLength + data.byteLength)
      combined.set(header, 0)
      combined.set(data, header.byteLength)
      this._socket.write(combined)
      return
    }

    // Slice large frames so a single multi-MB payload never balloons the
    // socket's write buffer in one allocation.
    this._socket.write(header)
    for (
      let offset = 0;
      offset < data.byteLength;
      offset += ProtocolConstants.MaxSocketWriteChunk
    ) {
      this._socket.write(data.subarray(offset, offset + ProtocolConstants.MaxSocketWriteChunk))
    }
  }

  public dispose(): void {
    this._isDisposed = true
  }
}
