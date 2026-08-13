/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/codec.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import { binaryCodec, createBinaryCodec } from '../../ipc/codec.js'
import { defaultCodec, type IpcMessage } from '../../ipc/ipc.js'
import { createRemoteURITransformer } from '../../ipc/uriIpc.js'

function requestArg(msg: IpcMessage): unknown {
  if (msg.type !== 'request') throw new Error('expected request')
  return msg.arg
}

function responseData(msg: IpcMessage): unknown {
  if (msg.type !== 'response') throw new Error('expected response')
  return msg.data
}

function bytesOf(u8: Uint8Array): number[] {
  return Array.from(u8)
}

describe('binaryCodec', () => {
  it('round-trips nested Uint8Array payloads as raw attachments', () => {
    const empty = new Uint8Array(0)
    const one = new Uint8Array([0xff])
    const big = new Uint8Array(64 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff

    const msg: IpcMessage = {
      type: 'request',
      id: 1,
      channel: 'fs',
      command: 'read',
      arg: { a: empty, b: one, nested: { c: big } },
    }

    const wire = binaryCodec.encode(msg)
    const arg = requestArg(binaryCodec.decode(wire)) as {
      a: Uint8Array
      b: Uint8Array
      nested: { c: Uint8Array }
    }

    expect(arg.a).toBeInstanceOf(Uint8Array)
    expect(bytesOf(arg.a)).toEqual([])
    expect(bytesOf(arg.b)).toEqual([0xff])
    expect(arg.nested.c).toHaveLength(64 * 1024)
    expect(bytesOf(arg.nested.c)).toEqual(bytesOf(big))

    // Framing + small JSON + raw attachment bytes, not a base64-expanded JSON blob.
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    const jsonByteLength = view.getUint32(0)
    const attachmentCount = view.getUint32(4)
    expect(attachmentCount).toBe(3)
    expect(wire.length - 8 - jsonByteLength - 3 * 4).toBe(0 + 1 + 64 * 1024)
    expect(jsonByteLength).toBeLessThan(1024)
  })

  it('extracts Buffer values as raw attachments', () => {
    const buf = Buffer.from([0, 1, 2, 0xfe, 0xff])
    const msg: IpcMessage = { type: 'response', id: 2, data: { content: buf } }

    const data = responseData(binaryCodec.decode(binaryCodec.encode(msg))) as {
      content: Uint8Array
    }
    expect(data.content).toBeInstanceOf(Uint8Array)
    expect(bytesOf(data.content)).toEqual([0, 1, 2, 0xfe, 0xff])
  })

  it('extracts Uint8Array at a top-level field and inside arrays', () => {
    const directMsg: IpcMessage = {
      type: 'request',
      id: 3,
      channel: 'c',
      command: 'x',
      arg: new Uint8Array([9, 8, 7]),
    }
    const directArg = requestArg(binaryCodec.decode(binaryCodec.encode(directMsg)))
    expect(directArg).toBeInstanceOf(Uint8Array)
    expect(bytesOf(directArg as Uint8Array)).toEqual([9, 8, 7])

    const arrMsg: IpcMessage = {
      type: 'request',
      id: 4,
      channel: 'c',
      command: 'y',
      arg: [new Uint8Array([1]), new Uint8Array([2, 3])],
    }
    const arrArg = requestArg(binaryCodec.decode(binaryCodec.encode(arrMsg))) as Uint8Array[]
    expect(arrArg).toHaveLength(2)
    expect(bytesOf(arrArg[0]!)).toEqual([1])
    expect(bytesOf(arrArg[1]!)).toEqual([2, 3])
  })

  it('revives URI instances without a transformer', () => {
    const uri = URI.from({
      scheme: 'https',
      authority: 'example.com',
      path: '/a/b',
      query: 'x=1',
      fragment: 'f',
    })
    const msg: IpcMessage = { type: 'response', id: 5, data: { uri } }

    const data = responseData(binaryCodec.decode(binaryCodec.encode(msg))) as { uri: URI }
    expect(data.uri).toBeInstanceOf(URI)
    expect(data.uri.scheme).toBe('https')
    expect(data.uri.authority).toBe('example.com')
    expect(data.uri.path).toBe('/a/b')
    expect(data.uri.query).toBe('x=1')
    expect(data.uri.fragment).toBe('f')
    expect(data.uri.toString()).toBe(uri.toString())
  })

  it('translates remote-ssh <-> file across the tunnel', () => {
    const client = createBinaryCodec()
    const server = createBinaryCodec(createRemoteURITransformer('wsl'))

    const req: IpcMessage = {
      type: 'request',
      id: 6,
      channel: 'fs',
      command: 'read',
      arg: { uri: URI.parse('remote-ssh://wsl/home/x') },
    }
    const serverArg = requestArg(server.decode(client.encode(req))) as { uri: URI }
    expect(serverArg.uri).toBeInstanceOf(URI)
    expect(serverArg.uri.toString()).toBe('file:///home/x')

    const res: IpcMessage = { type: 'response', id: 7, data: { uri: URI.parse('file:///home/y') } }
    const clientData = responseData(client.decode(server.encode(res))) as { uri: URI }
    expect(clientData.uri).toBeInstanceOf(URI)
    expect(clientData.uri.toString()).toBe('remote-ssh://wsl/home/y')
  })

  it('leaves $mid garbage objects untouched', () => {
    const garbage = { $mid: 1, foo: 'bar' }
    const msg: IpcMessage = { type: 'response', id: 8, data: { garbage } }

    const data = responseData(binaryCodec.decode(binaryCodec.encode(msg))) as { garbage: unknown }
    expect(data.garbage).toEqual({ $mid: 1, foo: 'bar' })
    expect(data.garbage).not.toBeInstanceOf(URI)
  })

  it('matches defaultCodec for plain JSON shapes', () => {
    const shapes: IpcMessage[] = [
      { type: 'request', id: 1, channel: 'c', command: 'x', arg: { a: 1, b: null, c: undefined } },
      { type: 'response', id: 2, data: { nested: [1, null, undefined], empty: null } },
      { type: 'event', channel: 'c', event: 'e', data: { x: [undefined, null, { y: 2 }] } },
    ]
    for (const shape of shapes) {
      expect(binaryCodec.decode(binaryCodec.encode(shape))).toEqual(
        defaultCodec.decode(defaultCodec.encode(shape)),
      )
    }
  })
})
