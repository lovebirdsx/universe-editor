import { describe, expect, it, vi } from 'vitest'
import { ChannelServer, Emitter, Event, defaultCodec } from '@universe-editor/platform'
import {
  BoundedWriteQueue,
  DEFAULT_HARD_LIMIT_BYTES,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_SOFT_LIMIT_BYTES,
} from '../boundedWriteQueue.js'
import { eventFrameKey } from '../stdioProtocol.js'

/** Sink whose settlements are driven by the test (never resolves unless told to). */
class ManualSink {
  readonly calls: string[] = []
  private readonly _pending: Array<{
    readonly batch: string
    readonly resolve: () => void
    readonly reject: (err: unknown) => void
  }> = []

  readonly call = (batch: string): Promise<void> => {
    this.calls.push(batch)
    return new Promise<void>((resolve, reject) => {
      this._pending.push({ batch, resolve, reject })
    })
  }

  async drainOne(): Promise<void> {
    const next = this._pending.shift()
    if (!next) throw new Error('no pending sink call')
    next.resolve()
    await flushMicrotasks()
  }

  failNext(error: unknown): void {
    const next = this._pending.shift()
    if (!next) throw new Error('no pending sink call')
    next.reject(error)
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const noCoalesce = (): undefined => undefined

describe('BoundedWriteQueue', () => {
  it('has the documented default limits', () => {
    expect(DEFAULT_SOFT_LIMIT_BYTES).toBe(8 * 1024 * 1024)
    expect(DEFAULT_HARD_LIMIT_BYTES).toBe(64 * 1024 * 1024)
    expect(DEFAULT_MAX_BATCH_BYTES).toBe(1024 * 1024)
  })

  it('sends the first frame immediately and keeps one sink call in flight', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({ sink: sink.call, coalesceKey: noCoalesce })

    queue.enqueue('a')
    expect(sink.calls).toEqual(['a'])

    queue.enqueue('b')
    queue.enqueue('c')
    expect(sink.calls).toEqual(['a'])
    expect(queue.stats.depth).toBe(2)
    expect(queue.stats.inFlight).toBe(true)

    await sink.drainOne()
    expect(sink.calls).toEqual(['a', 'bc'])

    await sink.drainOne()
    expect(queue.stats.depth).toBe(0)
    expect(queue.stats.inFlight).toBe(false)
    expect(queue.stats.batches).toBe(2)
    queue.dispose()
  })

  it('caps a batch at maxBatchBytes but still sends an oversized single frame alone', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      maxBatchBytes: 8,
    })

    queue.enqueue('a')
    queue.enqueue('bbbb')
    queue.enqueue('cccc')
    queue.enqueue('dddd')

    await sink.drainOne()
    expect(sink.calls).toEqual(['a', 'bbbbcccc'])

    await sink.drainOne()
    expect(sink.calls).toEqual(['a', 'bbbbcccc', 'dddd'])
    queue.dispose()
  })

  it('sends a single frame larger than maxBatchBytes on its own', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      maxBatchBytes: 4,
    })

    queue.enqueue('a')
    queue.enqueue('0123456789')
    queue.enqueue('bb')

    await sink.drainOne()
    expect(sink.calls).toEqual(['a', '0123456789'])

    await sink.drainOne()
    expect(sink.calls).toEqual(['a', '0123456789', 'bb'])
    queue.dispose()
  })

  it('coalesces latest-wins frames only after crossing the soft limit, keeping the newest at the tail', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: (frame) => (frame.startsWith('E:') ? 'evt' : undefined),
      softLimitBytes: 10,
      hardLimitBytes: 1_000,
    })

    queue.enqueue('START')
    // 3 + 3 = 6 <= 10: no merge yet.
    queue.enqueue('E:a')
    queue.enqueue('E:b')
    expect(queue.stats.depth).toBe(2)
    expect(queue.stats.coalescedFrames).toBe(0)

    // 9 <= 10: still under the limit.
    queue.enqueue('E:c')
    expect(queue.stats.depth).toBe(3)

    // 12 > 10: every older E frame is dropped, the new one is appended at the tail.
    queue.enqueue('E:d')
    expect(queue.stats.depth).toBe(1)
    expect(queue.stats.coalescedFrames).toBe(3)

    // Non-whitelisted frames are never merged, even above the soft limit.
    queue.enqueue('R:x')
    queue.enqueue('R:y')
    expect(queue.stats.depth).toBe(3)

    await sink.drainOne()
    expect(sink.calls).toEqual(['START', 'E:dR:xR:y'])
    queue.dispose()
  })

  it('keeps depth, bytes and FIFO order correct when multiple keys coalesce', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: (frame) => {
        if (frame.startsWith('A:')) return 'a'
        if (frame.startsWith('B:')) return 'b'
        return undefined
      },
      softLimitBytes: 10,
      hardLimitBytes: 10_000,
    })

    queue.enqueue('START')
    queue.enqueue('A:1')
    queue.enqueue('B:1')
    queue.enqueue('R:1')
    expect(queue.stats).toMatchObject({ depth: 3, queuedBytes: 9, coalescedFrames: 0 })

    // 9 + 4 > 10: only A:1 is dropped; the new A frame takes its place at the tail.
    queue.enqueue('A:22')
    expect(queue.stats).toMatchObject({ depth: 3, queuedBytes: 10, coalescedFrames: 1 })

    // Still over the limit: B:1 goes too. R:1 (no key) is never merged.
    queue.enqueue('B:22')
    expect(queue.stats).toMatchObject({ depth: 3, queuedBytes: 11, coalescedFrames: 2 })

    await sink.drainOne()
    expect(sink.calls).toEqual(['START', 'R:1A:22B:22'])
    expect(queue.stats).toMatchObject({ depth: 0, queuedBytes: 0 })
    queue.dispose()
  })

  it('never drops or reorders request frames under the soft limit', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      softLimitBytes: 5,
      hardLimitBytes: 10_000,
    })

    queue.enqueue('START')
    const requests = Array.from({ length: 200 }, (_, i) => `R:${i.toString().padStart(3, '0')};`)
    for (const request of requests) queue.enqueue(request)

    expect(queue.stats.depth).toBe(requests.length)
    while (queue.stats.depth > 0) await sink.drainOne()

    expect(sink.calls[0]).toBe('START')
    expect(sink.calls.slice(1).join('')).toBe(requests.join(''))
    queue.dispose()
  })

  it('drains tens of thousands of queued frames in order and resets the metrics', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      softLimitBytes: 1024 * 1024,
      hardLimitBytes: 16 * 1024 * 1024,
    })

    const frames: string[] = []
    const count = 50_000
    for (let i = 0; i < count; i++) {
      const frame = `f${i.toString().padStart(5, '0')};`
      frames.push(frame)
      queue.enqueue(frame)
    }
    // The first frame dispatches immediately, so a quadratic drain would stall
    // here; the rest queue behind it.
    expect(queue.stats.depth).toBe(count - 1)
    expect(queue.stats.queuedBytes).toBe(
      frames.slice(1).reduce((sum, frame) => sum + frame.length, 0),
    )

    while (queue.stats.depth > 0 || queue.stats.inFlight) await sink.drainOne()

    expect(sink.calls.join('')).toBe(frames.join(''))
    expect(sink.calls).toHaveLength(2) // the immediate first frame + one drained batch
    expect(queue.stats).toMatchObject({ depth: 0, queuedBytes: 0, inFlight: false })
    queue.dispose()
  })

  it('fails once at the hard limit, clears the queue and stops accepting frames', async () => {
    const sink = new ManualSink()
    const onOverflow = vi.fn()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      softLimitBytes: 5,
      hardLimitBytes: 10,
      onOverflow,
    })

    queue.enqueue('START')
    queue.enqueue('12345')
    queue.enqueue('67890')
    expect(onOverflow).not.toHaveBeenCalled()

    queue.enqueue('x')
    expect(onOverflow).toHaveBeenCalledTimes(1)
    const info = onOverflow.mock.calls[0]![0]
    expect(info).toMatchObject({ frameBytes: 1, depth: 3, queuedBytes: 11, failed: true })

    expect(queue.stats).toMatchObject({ depth: 0, queuedBytes: 0, failed: true })

    // Memory must not grow again: later frames are silently discarded.
    for (let i = 0; i < 1_000; i++) queue.enqueue('more')
    expect(queue.stats.depth).toBe(0)
    expect(queue.stats.queuedBytes).toBe(0)

    // The in-flight sink call still settles, but nothing else is dispatched.
    await sink.drainOne()
    expect(sink.calls).toEqual(['START'])
    expect(onOverflow).toHaveBeenCalledTimes(1)
    queue.dispose()
  })

  it('stops on the first sink rejection and reports it exactly once', async () => {
    const sink = new ManualSink()
    const onFailure = vi.fn()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      softLimitBytes: 1_000,
      hardLimitBytes: 10_000,
      onFailure,
    })

    queue.enqueue('a')
    queue.enqueue('b')
    queue.enqueue('c')

    const failure = new Error('EPIPE')
    sink.failNext(failure)
    await flushMicrotasks()

    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0]![0]).toBe(failure)
    expect(onFailure.mock.calls[0]![1]).toMatchObject({ depth: 2, failed: true })
    expect(queue.stats).toMatchObject({ failed: true, depth: 0, queuedBytes: 0 })

    // Later enqueues are silently dropped — no per-frame warning.
    queue.enqueue('d')
    await flushMicrotasks()
    expect(sink.calls).toEqual(['a'])
    expect(onFailure).toHaveBeenCalledTimes(1)
    queue.dispose()
  })

  it('rate-limits the soft-limit warning', async () => {
    const sink = new ManualSink()
    const onSoftLimit = vi.fn()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      softLimitBytes: 5,
      hardLimitBytes: 1_000,
      onSoftLimit,
    })

    queue.enqueue('START')
    queue.enqueue('123456')
    queue.enqueue('123456')
    queue.enqueue('123456')

    expect(onSoftLimit).toHaveBeenCalledTimes(1)
    expect(onSoftLimit.mock.calls[0]![0]).toMatchObject({ coalescedFrames: 0 })
    queue.dispose()
  })

  it('tracks peak depth/bytes and the longest queue wait', async () => {
    const sink = new ManualSink()
    const drained = vi.fn()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      onBatchDrained: drained,
    })

    let clock = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    queue.enqueue('a')
    queue.enqueue('bb')
    queue.enqueue('ccc')
    expect(queue.stats.peakDepth).toBe(2)
    expect(queue.stats.peakQueuedBytes).toBe(5)

    clock += 7
    await sink.drainOne()
    await sink.drainOne()
    nowSpy.mockRestore()

    expect(queue.stats.maxWaitMs).toBe(7)
    expect(drained).toHaveBeenCalledTimes(2)
    expect(drained.mock.calls[1]![0]).toMatchObject({ frames: 2, bytes: 5, depth: 2 })
    queue.dispose()
  })

  it('drops queued frames and ignores later enqueues after dispose', async () => {
    const sink = new ManualSink()
    const queue = new BoundedWriteQueue({ sink: sink.call, coalesceKey: noCoalesce })

    queue.enqueue('a')
    queue.enqueue('b')
    queue.dispose()

    expect(queue.stats).toMatchObject({ depth: 0, disposed: true })
    queue.enqueue('c')
    expect(queue.stats.depth).toBe(0)

    await sink.drainOne()
    await flushMicrotasks()
    expect(sink.calls).toEqual(['a'])
  })
})

describe('eventFrameKey', () => {
  it('swallows an in-flight sink rejection that lands after dispose', async () => {
    const sink = new ManualSink()
    const onFailure = vi.fn()
    const onBatchDrained = vi.fn()
    const queue = new BoundedWriteQueue({
      sink: sink.call,
      coalesceKey: noCoalesce,
      onFailure,
      onBatchDrained,
    })

    queue.enqueue('a')
    queue.enqueue('b')
    queue.dispose()
    sink.failNext(new Error('host gone'))
    await flushMicrotasks()

    expect(onFailure).not.toHaveBeenCalled()
    expect(onBatchDrained).not.toHaveBeenCalled()
    expect(sink.calls).toEqual(['a'])
    expect(queue.stats).toMatchObject({ depth: 0, disposed: true, failed: false })
  })

  it('recognizes frames produced by a real ChannelServer', () => {
    const frames: string[] = []
    const protocol = {
      send: (data: Uint8Array) => frames.push(new TextDecoder().decode(data)),
      onMessage: Event.None,
    }
    const server = new ChannelServer(protocol)
    const onEvent = new Emitter<{ value: number }>()
    server.registerChannel('mainThreadAi', {
      call: (() => Promise.resolve(undefined)) as never,
      listen: (() => onEvent.event) as never,
    })

    server.handleMessage({ type: 'subscribe', channel: 'mainThreadAi', event: 'onDidEmitChunk' })
    onEvent.fire({ value: 1 })

    expect(frames).toHaveLength(1)
    // Guards the EventMessage key order the prefix depends on.
    expect(eventFrameKey(frames[0]!)).toBe('mainThreadAi:onDidEmitChunk')

    onEvent.dispose()
    server.dispose()
  })

  it('rejects requests, malformed frames and non-event payloads', () => {
    const request = new TextDecoder().decode(
      defaultCodec.encode({
        type: 'request',
        id: 1,
        channel: 'mainThreadAi',
        command: 'startRequest',
        arg: [],
      }),
    )
    expect(eventFrameKey(request)).toBeUndefined()
    expect(eventFrameKey('not json')).toBeUndefined()
    expect(eventFrameKey('{"type":"event"')).toBeUndefined()
    expect(eventFrameKey('')).toBeUndefined()
  })
})
