/*---------------------------------------------------------------------------------------------
 *  Tests for the outbound-encode observation seam in ipc.ts.
 *
 *  The seam exists so the sender can attribute a slow/serialized frame — kind, channel,
 *  command, id, size, synchronous encode cost — without a second serialization and
 *  without the body. What is covered: a request and its response are each reported once,
 *  the label comes from the send site, a refused frame is reported by the guard instead,
 *  and an observer that throws cannot drop an already-encoded frame.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChannelServer,
  createChannelFromObject,
  defaultCodec,
  InMemoryMessagePassingProtocol,
  IpcService,
  setIpcEncodeObserver,
  type IpcCodec,
  type IpcEncodeObservation,
} from '../../ipc/ipc.js'
import { IpcFrameTooLargeError, resetIpcFrameDiagnosticsForTests } from '../../ipc/ipcFrameGuard.js'

const flushMicrotasks = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

let seen: IpcEncodeObservation[] = []

beforeEach(() => {
  seen = []
  resetIpcFrameDiagnosticsForTests()
  setIpcEncodeObserver((o) => seen.push(o))
})

afterEach(() => setIpcEncodeObserver(undefined))

describe('outbound encode observation', () => {
  it('reports the request with kind, channel, method, id and size', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const ipc = new IpcService(rendererProto)
    const server = new ChannelServer(mainProto)
    server.registerChannel(
      'fileSearch',
      createChannelFromObject({ findFiles: (arg) => ({ echo: arg }) }),
    )

    await expect(ipc.getChannel('fileSearch').call('findFiles', 'src')).resolves.toEqual({
      echo: 'src',
    })

    const request = seen.find((o) => o.type === 'request')
    expect(request).toMatchObject({
      channel: 'fileSearch',
      name: 'findFiles',
      id: 1,
    })
    expect(request?.bytes).toBeGreaterThan(0)
    expect(request?.durationMs).toBeGreaterThanOrEqual(0)
    expect(request?.startTime).toBeGreaterThan(0)
    // Only the frame shape travels; the argument and payload never enter the observation.
    expect(request).not.toHaveProperty('arg')
    expect(request).not.toHaveProperty('data')

    ipc.dispose()
    server.dispose()
  })

  it('reports each encoded frame exactly once, request and response alike', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    let encodes = 0
    const countingCodec: IpcCodec = {
      encode: (msg) => {
        encodes++
        return defaultCodec.encode(msg)
      },
      decode: (data) => defaultCodec.decode(data),
    }
    const ipc = new IpcService(rendererProto, undefined, countingCodec)
    const server = new ChannelServer(mainProto, true, countingCodec)
    server.registerChannel('math', createChannelFromObject({ add: (x) => (x as number) + 1 }))

    await expect(ipc.getChannel('math').call('add', 1)).resolves.toBe(2)
    await flushMicrotasks()

    expect(encodes).toBe(2)
    expect(seen.map((o) => o.type).sort()).toEqual(['request', 'response'])
    expect(seen.every((o) => o.channel === 'math' && o.name === 'add')).toBe(true)
  })

  it('does not report a frame the codec refused as oversize', async () => {
    const [local, remote] = InMemoryMessagePassingProtocol.createPair()
    void remote
    const refusingCodec: IpcCodec = {
      encode: () => {
        throw new IpcFrameTooLargeError(999)
      },
      decode: defaultCodec.decode,
    }
    const ipc = new IpcService(local, undefined, refusingCodec)
    const pending = ipc.getChannel('math').call('add', 1)
    await expect(pending).rejects.toThrow(/exceeds/)

    expect(seen).toEqual([])
    ipc.dispose()
  })

  it('still sends when the observer throws', async () => {
    setIpcEncodeObserver(() => {
      throw new Error('observer exploded')
    })
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const ipc = new IpcService(rendererProto)
    const server = new ChannelServer(mainProto)
    server.registerChannel('math', createChannelFromObject({ add: (x) => (x as number) + 1 }))

    await expect(ipc.getChannel('math').call('add', 1)).resolves.toBe(2)
    ipc.dispose()
    server.dispose()
  })
})
