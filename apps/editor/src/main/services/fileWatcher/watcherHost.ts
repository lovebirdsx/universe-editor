/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WatcherHost — the only code that touches `@parcel/watcher`. Runs inside the
 *  watcher utility process (see watcherHostMain.ts) so a native crash in the
 *  win32 backend (observed: use-after-free on unsubscribe, watcher.node
 *  ACCESS_VIOLATION taking down every window) kills that process instead of the
 *  main process; WatcherProcessClient restarts it and replays subscriptions.
 *
 *  Transport-agnostic on purpose: production wires it to `process.parentPort`,
 *  integration tests wire it to an in-memory port so the real parcel behaviour
 *  and the real message protocol are both exercised in-process.
 *--------------------------------------------------------------------------------------------*/

import { platform } from 'node:process'
import watcher from '@parcel/watcher'
import type { AsyncSubscription, BackendType } from '@parcel/watcher'
import type { WatcherHostRequest, WatcherHostResponse } from './watcherProtocol.js'

// Pin the parcel backend per platform. Parcel's "default" backend on Windows
// first probes for watchman — shelling out to a `watchman` subprocess on every
// (re)subscribe and printing "'watchman' is not recognized" — before falling
// back to the windows backend. Naming the backend skips that probe entirely.
const PARCEL_BACKEND: BackendType | undefined =
  platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'fs-events'
      : platform === 'linux'
        ? 'inotify'
        : undefined

export class WatcherHost {
  private readonly _subs = new Map<number, AsyncSubscription>()
  // Requests are processed strictly in arrival order: a subscribe replacing an
  // id must not interleave with another request for the same id.
  private _queue: Promise<void> = Promise.resolve()

  constructor(private readonly _post: (msg: WatcherHostResponse) => void) {}

  handle(msg: WatcherHostRequest): Promise<void> {
    this._queue = this._queue.then(() => this._process(msg))
    return this._queue
  }

  private async _process(msg: WatcherHostRequest): Promise<void> {
    try {
      switch (msg.kind) {
        case 'subscribe': {
          await this._dropSubscription(msg.id)
          const opts = PARCEL_BACKEND
            ? { ignore: [...msg.ignore], backend: PARCEL_BACKEND }
            : { ignore: [...msg.ignore] }
          const sub = await watcher.subscribe(
            msg.dir,
            (err, events) => {
              if (err) {
                this._post({ kind: 'watch-error', id: msg.id, error: err.message })
                return
              }
              this._post({
                kind: 'events',
                id: msg.id,
                events: events.map((e) => ({ path: e.path, type: e.type })),
              })
            },
            opts,
          )
          this._subs.set(msg.id, sub)
          this._post({ kind: 'ack', seq: msg.seq })
          break
        }
        case 'unsubscribe': {
          await this._dropSubscription(msg.id)
          this._post({ kind: 'ack', seq: msg.seq })
          break
        }
      }
    } catch (err) {
      this._post({
        kind: 'ack',
        seq: msg.seq,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
  }

  private async _dropSubscription(id: number): Promise<void> {
    const sub = this._subs.get(id)
    if (!sub) return
    this._subs.delete(id)
    await sub.unsubscribe()
  }

  async dispose(): Promise<void> {
    const subs = Array.from(this._subs.values())
    this._subs.clear()
    await Promise.allSettled(subs.map((s) => s.unsubscribe()))
  }
}
