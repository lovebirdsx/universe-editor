/*---------------------------------------------------------------------------------------------
 *  RPC write backpressure (the transport half of HostConnection).
 *
 *  HostConnection itself is too heavy to construct in a unit test: MainThreadEditor
 *  builds a FileBulkEditService through the DI container and wires autorun mirrors,
 *  and MainThreadWindow needs a DOM. The transport wiring lives in RpcWritePipeline,
 *  so these tests exercise the real write path (queue → writeStdin, failure →
 *  warn once + recovery hook) without the workbench graph.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter, Event, type ILogger } from '@universe-editor/platform'
import { RpcWritePipeline } from '../rpcWritePipeline.js'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

class DeferredWriteHost {
  readonly writes: string[] = []
  private readonly _pending: Array<{
    readonly data: string
    readonly resolve: () => void
    readonly reject: (err: unknown) => void
  }> = []

  writeStdin(_handle: string, data: string): Promise<void> {
    this.writes.push(data)
    return new Promise<void>((resolve, reject) => {
      this._pending.push({ data, resolve, reject })
    })
  }

  resolveNext(): void {
    const next = this._pending.shift()
    if (!next) throw new Error('no pending write')
    next.resolve()
  }

  rejectNext(error: unknown): void {
    const next = this._pending.shift()
    if (!next) throw new Error('no pending write')
    next.reject(error)
  }
}

function fakeLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as ILogger
}

function createPipeline(
  host: DeferredWriteHost,
  logger: ILogger,
  options: { onData?: Event<string>; maxPendingFrameBytes?: number } = {},
) {
  const onFatal = vi.fn()
  const pipeline = new RpcWritePipeline({
    kind: 'local',
    handle: 'handle-1',
    onData: options.onData ?? Event.None,
    writeStdin: (handle, data) => host.writeStdin(handle, data),
    logger,
    onFatal,
    ...(options.maxPendingFrameBytes !== undefined
      ? { maxPendingFrameBytes: options.maxPendingFrameBytes }
      : {}),
  })
  return { pipeline, onFatal }
}

describe('RpcWritePipeline', () => {
  it('keeps at most one writeStdin in flight and batches queued frames', async () => {
    const host = new DeferredWriteHost()
    const { pipeline } = createPipeline(host, fakeLogger())

    pipeline.protocol.send(encode('{"a":1}'))
    expect(host.writes).toEqual(['{"a":1}\n'])

    pipeline.protocol.send(encode('{"b":2}'))
    pipeline.protocol.send(encode('{"c":3}'))
    expect(host.writes).toEqual(['{"a":1}\n'])

    host.resolveNext()
    await flushMicrotasks()
    expect(host.writes).toEqual(['{"a":1}\n', '{"b":2}\n{"c":3}\n'])

    host.resolveNext()
    await flushMicrotasks()
    expect(host.writes).toHaveLength(2)
    pipeline.dispose()
  })

  it('warns once and triggers recovery on the first write failure, then drops silently', async () => {
    const host = new DeferredWriteHost()
    const logger = fakeLogger()
    const { pipeline, onFatal } = createPipeline(host, logger)

    pipeline.protocol.send(encode('a'))
    pipeline.protocol.send(encode('b'))

    host.rejectNext(new Error('EPIPE'))
    await flushMicrotasks()

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EPIPE'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('local'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('handle-1'))
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledWith('write failure')

    // The queue is stopped: later frames are discarded without another warning
    // or another write attempt.
    pipeline.protocol.send(encode('c'))
    await flushMicrotasks()
    expect(host.writes).toEqual(['a\n'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledTimes(1)
    pipeline.dispose()
  })

  it('reports an inbound framing overflow through the recovery hook exactly once', () => {
    const host = new DeferredWriteHost()
    const logger = fakeLogger()
    const onData = new Emitter<string>()
    const { pipeline, onFatal } = createPipeline(host, logger, {
      onData: onData.event,
      maxPendingFrameBytes: 8,
    })

    onData.fire('1234')
    onData.fire('5678')
    expect(onFatal).not.toHaveBeenCalled()

    onData.fire('9')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('inbound frame'))
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledWith('inbound frame overflow')

    // The desynchronized remainder is not parsed into messages.
    const received: Uint8Array[] = []
    pipeline.protocol.onMessage((message) => received.push(message))
    onData.fire('tail\ncomplete\n')
    expect(received).toEqual([])

    onData.dispose()
    pipeline.dispose()
  })
})
