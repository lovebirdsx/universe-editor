export const FRAME_HEADER_SIZE = 4
export const MAX_FRAME_PAYLOAD_SIZE = 16 * 1024 * 1024

export class FrameProtocolError extends Error {
  constructor(
    message: string,
    readonly code: 'FRAME_TOO_LARGE',
  ) {
    super(message)
    this.name = 'FrameProtocolError'
  }
}

export function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  if (payload.byteLength > MAX_FRAME_PAYLOAD_SIZE) {
    throw new FrameProtocolError(
      `Frame length ${payload.byteLength} exceeds limit ${MAX_FRAME_PAYLOAD_SIZE}`,
      'FRAME_TOO_LARGE',
    )
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  payload.copy(frame, FRAME_HEADER_SIZE)
  return frame
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: string[] = []

    for (;;) {
      if (this.buffer.byteLength < FRAME_HEADER_SIZE) return messages

      const payloadLength = this.buffer.readUInt32BE(0)
      if (payloadLength > MAX_FRAME_PAYLOAD_SIZE) {
        this.reset()
        throw new FrameProtocolError(
          `Received frame length ${payloadLength} exceeds limit ${MAX_FRAME_PAYLOAD_SIZE}`,
          'FRAME_TOO_LARGE',
        )
      }

      const frameLength = FRAME_HEADER_SIZE + payloadLength
      if (this.buffer.byteLength < frameLength) return messages

      messages.push(this.buffer.toString('utf8', FRAME_HEADER_SIZE, frameLength))
      this.buffer = this.buffer.subarray(frameLength)
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}
