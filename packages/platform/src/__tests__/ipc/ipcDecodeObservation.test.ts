/*---------------------------------------------------------------------------------------------
 *  Tests for the inbound-decode observation seam in ipc.ts.
 *
 *  The seam exists so the embedder can attribute a decoded frame — kind, channel,
 *  command, id, size, synchronous decode cost — without a second parse and without
 *  mounting another listener. What is covered here: the attribution a response can only
 *  get from the peer that issued the request, exact-once delivery (one decode, one
 *  report), and that refused or malformed frames deliver nothing at all.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChannelPair,
  ChannelServer,
  createChannelFromObject,
  defaultCodec,
  InMemoryMessagePassingProtocol,
  IpcService,
  type IChannel,
  type IpcCodec,
  type IpcDecodeObservation,
} from '../../ipc/ipc.js'
import { Emitter, type Event } from '../../base/event.js'
import {
  IPC_FRAME_MAX_BYTES,
  ipcFrameStats,
  resetIpcFrameDiagnosticsForTests,
  snapshotIpcFrames,
} from '../../ipc/ipcFrameGuard.js'

const flushMicrotasks = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** An over-limit frame without materialising 128MiB: only `byteLength` is read. */
const oversizedFrame = (): Uint8Array =>
  ({ byteLength: IPC_FRAME_MAX_BYTES + 1 }) as unknown as Uint8Array

/** Collects the observations delivered for one IpcService / ChannelPair. */
const observeInto = (): {
  seen: IpcDecodeObservation[]
  onDecoded: (o: IpcDecodeObservation) => void
} => {
  const seen: IpcDecodeObservation[] = []
  return { seen, onDecoded: (o) => seen.push(o) }
}

beforeEach(() => resetIpcFrameDiagnosticsForTests())

describe('inbound decode observation', () => {
  it('names a real response after the pending request it answers', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const { seen, onDecoded } = observeInto()
    const ipc = new IpcService(rendererProto, { onDecoded })
    const server = new ChannelServer(mainProto)
    server.registerChannel(
      'fileSearch',
      createChannelFromObject({ findFiles: (arg) => ({ echo: arg }) }),
    )

    await expect(ipc.getChannel('fileSearch').call('findFiles', 'src')).resolves.toEqual({
      echo: 'src',
    })

    // A response carries no channel on the wire; the client's pending-request map is the
    // only place that can name it, and the observation must be delivered after that
    // lookup rather than before it.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      type: 'response',
      channel: 'fileSearch',
      name: 'findFiles',
      id: 1,
    })
    expect(seen[0]?.bytes).toBeGreaterThan(0)
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(seen[0]?.startTime).toBeGreaterThan(0)

    ipc.dispose()
    server.dispose()
  })

  it('decodes each frame once and reports it once, instrument and all', async () => {
    const [local, remote] = InMemoryMessagePassingProtocol.createPair()
    let decodes = 0
    let instrumented = 0
    const countingCodec: IpcCodec = {
      encode: (msg) => defaultCodec.encode(msg),
      decode: (data) => {
        decodes++
        return defaultCodec.decode(data)
      },
    }
    const { seen, onDecoded } = observeInto()
    const pair = new ChannelPair(
      local,
      {
        instrument: (run) => {
          instrumented++
          return run()
        },
        onDecoded,
      },
      countingCodec,
    )
    pair.server.registerChannel('math', createChannelFromObject({ add: (x) => (x as number) + 1 }))

    remote.send(
      countingCodec.encode({ type: 'request', id: 7, channel: 'math', command: 'add', arg: 1 }),
    )
    await flushMicrotasks()

    expect(decodes).toBe(1)
    expect(instrumented).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'request', channel: 'math', name: 'add', id: 7 })

    pair.dispose()
  })

  it('attributes an event to the channel and name it was subscribed under', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const { seen, onDecoded } = observeInto()
    const ipc = new IpcService(rendererProto, { onDecoded })
    const emitter = new Emitter<string>()
    const feed: IChannel = {
      call: async <T>() => undefined as T,
      listen: <T>() => emitter.event as Event<T>,
    }
    const server = new ChannelServer(mainProto)
    server.registerChannel('feed', feed)

    const received: string[] = []
    ipc.getChannel('feed').listen<string>('update')((v) => received.push(v))
    await flushMicrotasks()
    emitter.fire('tick')
    await flushMicrotasks()

    expect(received).toEqual(['tick'])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'event', channel: 'feed', name: 'update', id: 0 })

    ipc.dispose()
    server.dispose()
  })

  it('degrades a response this peer never asked for to the bare id', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const { seen, onDecoded } = observeInto()
    const ipc = new IpcService(rendererProto, { onDecoded })

    mainProto.send(defaultCodec.encode({ type: 'response', id: 999, data: 'stray' }))
    await flushMicrotasks()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'response', channel: '', name: '', id: 999 })

    ipc.dispose()
  })

  it('delivers nothing for a frame the guard refused', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const { seen, onDecoded } = observeInto()
    const ipc = new IpcService(rendererProto, { onDecoded })

    mainProto.send(oversizedFrame())
    await flushMicrotasks()

    // Nothing was decoded, so there is nothing to attribute — the refusal itself is the
    // frame guard's report, not an observation.
    expect(seen).toHaveLength(0)
    expect(ipcFrameStats()).toMatchObject({ oversized: 1 })
    expect(snapshotIpcFrames().at(-1)).toMatchObject({ direction: 'in', type: 'unparsed' })

    ipc.dispose()
  })

  it('delivers nothing when the decode throws, and the failure stays loud', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
      const { seen, onDecoded } = observeInto()
      const ipc = new IpcService(rendererProto, { onDecoded })

      mainProto.send(new TextEncoder().encode('{"type":"response"'))
      await flushMicrotasks()

      expect(seen).toHaveLength(0)
      // Malformed JSON is a protocol bug; it must not be swallowed into a silent
      // "no observation" the way a size refusal legitimately is.
      expect(consoleError).toHaveBeenCalled()

      ipc.dispose()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps working with no instrumentation at all', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const ipc = new IpcService(rendererProto)
    const server = new ChannelServer(mainProto)
    server.registerChannel('math', createChannelFromObject({ add: (x) => (x as number) + 1 }))

    await expect(ipc.getChannel('math').call('add', 1)).resolves.toBe(2)

    ipc.dispose()
    server.dispose()
  })

  it('settles a real response even when the observer throws on it', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const ipc = new IpcService(rendererProto, {
      onDecoded: () => {
        throw new Error('observer boom')
      },
    })
    const server = new ChannelServer(mainProto)
    server.registerChannel('math', createChannelFromObject({ add: (x) => (x as number) + 1 }))

    // The observer is diagnostics: its throw must not drop the decoded frame or hang the
    // RPC the frame answers. The resolution here is the assertion that the isolation held.
    await expect(ipc.getChannel('math').call('add', 1)).resolves.toBe(2)

    ipc.dispose()
    server.dispose()
  })

  it('times the codec alone, never the instrument wrapper around it', async () => {
    const [rendererProto, mainProto] = InMemoryMessagePassingProtocol.createPair()
    const { seen, onDecoded } = observeInto()
    const ipc = new IpcService(rendererProto, {
      instrument: (run) => {
        const end = performance.now() + 25
        while (performance.now() < end) {
          // burn the wrapper's own time: it must not land in the observation
        }
        return run()
      },
      onDecoded,
    })
    const server = new ChannelServer(mainProto)
    server.registerChannel('math', createChannelFromObject({ add: (x) => (x as number) + 1 }))

    await expect(ipc.getChannel('math').call('add', 1)).resolves.toBe(2)

    expect(seen).toHaveLength(1)
    // The timed run starts inside the wrapper's callback, so 25ms of wrapper overhead
    // stays out; only the small frame's own decode — far below that — is reported.
    expect(seen[0]?.durationMs).toBeLessThan(20)

    ipc.dispose()
    server.dispose()
  })
})
