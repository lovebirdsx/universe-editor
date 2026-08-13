/*---------------------------------------------------------------------------------------------
 *  Tests for packages/node-services/src/watcher/watcherProcessClient.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  type WatcherHostRequest,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import { WatcherProcessClient, type IWatcherTransport } from '../watcherProcessClient.js'

class FakeTransport implements IWatcherTransport {
  readonly posted: WatcherHostRequest[] = []
  killed = false
  /** Auto-ack every request on a microtask unless a test flips this off. */
  autoAck = true
  private readonly _onMessage = new Emitter<WatcherHostResponse>()
  readonly onMessage = this._onMessage.event
  private readonly _onExit = new Emitter<number | undefined>()
  readonly onExit = this._onExit.event

  post(msg: WatcherHostRequest): void {
    this.posted.push(msg)
    if (this.autoAck) {
      queueMicrotask(() => this._onMessage.fire({ kind: 'ack', seq: msg.seq }))
    }
  }

  kill(): void {
    this.killed = true
  }

  emitMessage(msg: WatcherHostResponse): void {
    this._onMessage.fire(msg)
  }

  emitExit(code?: number): void {
    this._onExit.fire(code)
  }
}

describe('WatcherProcessClient', () => {
  let transports: FakeTransport[]
  let client: WatcherProcessClient

  const newClient = () =>
    new WatcherProcessClient(() => {
      const t = new FakeTransport()
      transports.push(t)
      return t
    })

  beforeEach(() => {
    vi.useFakeTimers()
    transports = []
    client = newClient()
  })

  afterEach(() => {
    client.dispose()
    vi.useRealTimers()
  })

  it('sends subscribe and resolves on ack', async () => {
    await client.watch(1, '/ws', ['**/node_modules'])
    expect(transports.length).toBe(1)
    expect(transports[0]!.posted).toEqual([
      { kind: 'subscribe', seq: 0, id: 1, dir: '/ws', ignore: ['**/node_modules'] },
    ])
  })

  it('rejects the watch when the host acks with an error', async () => {
    // First watch creates the transport, so autoAck can be flipped off for the next one.
    await client.watch(1, '/ok', [])
    transports[0]!.autoAck = false
    const p = client.watch(2, '/missing', [])
    const seq = (transports[0]!.posted.at(-1) as { seq: number }).seq
    transports[0]!.emitMessage({ kind: 'ack', seq, error: 'ENOENT' })
    await expect(p).rejects.toThrow('ENOENT')
  })

  it('routes events and watch errors by id', async () => {
    await client.watch(1, '/ws', [])
    const events: number[] = []
    const errors: number[] = []
    client.onFileEvents((m) => events.push(m.id))
    client.onWatchError((m) => errors.push(m.id))
    transports[0]!.emitMessage({
      kind: 'events',
      id: 1,
      events: [{ path: '/ws/a', type: 'create' }],
    })
    transports[0]!.emitMessage({ kind: 'watch-error', id: 7, error: 'boom' })
    expect(events).toEqual([1])
    expect(errors).toEqual([7])
  })

  it('restarts after a crash and replays desired subscriptions', async () => {
    await client.watch(1, '/ws-a', ['x'])
    await client.watch(2, '/ws-b', [])
    let restarted = 0
    client.onDidRestart(() => restarted++)

    transports[0]!.emitExit(1)
    await vi.advanceTimersByTimeAsync(400)

    expect(transports.length).toBe(2)
    const replayed = transports[1]!.posted.filter((m) => m.kind === 'subscribe')
    expect(replayed.map((m) => (m as { dir: string }).dir).sort()).toEqual(['/ws-a', '/ws-b'])
    expect(restarted).toBe(1)
  })

  it('replay uses the latest desired dir when a watch raced the restart delay', async () => {
    await client.watch(1, '/old', [])
    transports[0]!.emitExit(1)
    // Before the restart timer fires, the window switches folders.
    await client.watch(1, '/new', [])
    await vi.advanceTimersByTimeAsync(400)

    const subs = transports
      .slice(1)
      .flatMap((t) => t.posted)
      .filter((m) => m.kind === 'subscribe') as { dir: string }[]
    expect(subs.length).toBeGreaterThan(0)
    expect(subs.every((m) => m.dir === '/new')).toBe(true)
  })

  it('does not restart when nothing is desired anymore', async () => {
    await client.watch(1, '/ws', [])
    await client.unwatch(1)
    transports[0]!.emitExit(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transports.length).toBe(1)
  })

  it('fuses after too many crashes inside the window and rejects further watches', async () => {
    await client.watch(1, '/ws', [])
    for (let i = 0; i < 4; i++) {
      transports[transports.length - 1]!.emitExit(1)
      await vi.advanceTimersByTimeAsync(400)
    }
    // 3 restarts allowed; the 4th exit trips the fuse without a new transport.
    expect(transports.length).toBe(4)
    await expect(client.watch(2, '/other', [])).rejects.toThrow(/broken/)
    expect(transports.length).toBe(4)
  })

  it('recovers restart budget once crashes fall outside the window', async () => {
    await client.watch(1, '/ws', [])
    for (let i = 0; i < 3; i++) {
      transports[transports.length - 1]!.emitExit(1)
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(transports.length).toBe(4)
    // Advance past the rolling window: the next crash is the only one counted.
    await vi.advanceTimersByTimeAsync(61_000)
    transports[transports.length - 1]!.emitExit(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(transports.length).toBe(5)
  })

  it('dispose kills the transport and suppresses restarts', async () => {
    await client.watch(1, '/ws', [])
    client.dispose()
    expect(transports[0]!.killed).toBe(true)
    transports[0]!.emitExit(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transports.length).toBe(1)
  })

  it('rejects in-flight requests when the host exits', async () => {
    transports.length = 0
    const t = new FakeTransport()
    t.autoAck = false
    const localClient = new WatcherProcessClient(() => {
      transports.push(t)
      return t
    })
    const p = localClient.watch(1, '/ws', [])
    t.emitExit(1)
    await expect(p).rejects.toThrow(/exited/)
    localClient.dispose()
  })

  it('ignores a stale exit from an already-replaced transport', async () => {
    await client.watch(1, '/ws', [])
    transports[0]!.emitExit(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(transports.length).toBe(2)
    // The dead transport fires exit again (e.g. duplicated close signals).
    transports[0]!.emitExit(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transports.length).toBe(2)
  })
})
