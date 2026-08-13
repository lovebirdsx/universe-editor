/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Binary wire codec for the remote tunnel: carries Uint8Array payloads as raw
 *  attachment segments (no base64) and hooks per-connection URI transformation
 *  into the same JSON pass. Framing lives in a lower layer; the codec only
 *  produces/consumes the payload bytes below.
 *
 *  Wire layout (big-endian):
 *    [u32 jsonByteLength][u32 attachmentCount][json utf8 bytes][per attachment: u32 len + raw]
 *--------------------------------------------------------------------------------------------*/

import { URI, type UriComponents } from '../base/uri.js'
import type { IpcCodec, IpcMessage } from './ipc.js'
import type { IURITransformer } from './uriIpc.js'

const U8_REF = '$u8ref'
const URI_MID = 1

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff
  out[offset + 1] = (value >>> 16) & 0xff
  out[offset + 2] = (value >>> 8) & 0xff
  out[offset + 3] = value & 0xff
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  )
}

export function createBinaryCodec(transformer?: IURITransformer): IpcCodec {
  function encode(msg: IpcMessage): Uint8Array {
    const attachments: Uint8Array[] = []

    const replacer = function (this: unknown, key: string, value: unknown): unknown {
      // Read the holder's original value: Buffer.toJSON() runs before the replacer,
      // so `value` would already be `{ type: 'Buffer', data: [...] }` and the real
      // bytes would slip into JSON. `this[key]` still holds the raw typed array.
      const raw = (this as Record<string, unknown>)[key]
      if (raw instanceof Uint8Array) {
        const idx = attachments.length
        attachments.push(raw)
        return { [U8_REF]: idx }
      }
      if (transformer && value !== null && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        // `value` here is post-toJSON, so a URI instance is already `{ $mid: 1, ... }`.
        if (obj['$mid'] === URI_MID && typeof obj['scheme'] === 'string') {
          return transformer.transformOutgoing(obj as unknown as UriComponents)
        }
      }
      return value
    }

    const jsonText = JSON.stringify(msg, replacer)
    const jsonBytes = new TextEncoder().encode(jsonText)

    let attachmentBytes = 0
    for (const a of attachments) attachmentBytes += a.length

    const out = new Uint8Array(8 + jsonBytes.length + attachmentBytes + attachments.length * 4)
    writeU32(out, 0, jsonBytes.length)
    writeU32(out, 4, attachments.length)
    out.set(jsonBytes, 8)
    let offset = 8 + jsonBytes.length
    for (const a of attachments) {
      writeU32(out, offset, a.length)
      offset += 4
      out.set(a, offset)
      offset += a.length
    }
    return out
  }

  function decode(data: Uint8Array): IpcMessage {
    const jsonByteLength = readU32(data, 0)
    const attachmentCount = readU32(data, 4)

    const attachments: Uint8Array[] = []
    let offset = 8 + jsonByteLength
    for (let i = 0; i < attachmentCount; i++) {
      const len = readU32(data, offset)
      offset += 4
      attachments.push(data.subarray(offset, offset + len))
      offset += len
    }

    const jsonText = new TextDecoder().decode(data.subarray(8, 8 + jsonByteLength))

    const reviver = (_key: string, value: unknown): unknown => {
      if (value !== null && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        if (typeof obj[U8_REF] === 'number') {
          const idx = obj[U8_REF] as number
          const bytes = attachments[idx]
          if (!bytes) {
            throw new Error(`[codec] attachment index ${idx} out of range`)
          }
          return bytes
        }
        if (obj['$mid'] === URI_MID && typeof obj['scheme'] === 'string') {
          const components = transformer
            ? transformer.transformIncoming(obj as unknown as UriComponents)
            : (obj as unknown as UriComponents)
          return URI.revive(components)
        }
      }
      return value
    }

    return JSON.parse(jsonText, reviver) as IpcMessage
  }

  return { encode, decode }
}

export const binaryCodec: IpcCodec = createBinaryCodec()
