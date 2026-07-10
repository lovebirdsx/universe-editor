/**
 * A simple concurrency gate. Every p4 command is a process spawn plus a network
 * round-trip, so running too many at once overwhelms the server and the local
 * machine (git has no such need — its operations are local and cheap). Callers
 * wrap each p4 invocation in `run`; at most `maxConcurrent` run at a time, the
 * rest queue FIFO.
 */
export class ConcurrencyGate {
  private _active = 0
  private readonly _queue: Array<() => void> = []
  private _max: number

  constructor(maxConcurrent: number) {
    this._max = Math.max(1, maxConcurrent)
  }

  /** Adjust the cap at runtime (e.g. after a config change). */
  setMax(maxConcurrent: number): void {
    this._max = Math.max(1, maxConcurrent)
    this._drain()
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this._acquire()
    try {
      return await task()
    } finally {
      this._release()
    }
  }

  private _acquire(): Promise<void> {
    if (this._active < this._max) {
      this._active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this._queue.push(() => {
        this._active++
        resolve()
      })
    })
  }

  private _release(): void {
    this._active--
    this._drain()
  }

  private _drain(): void {
    while (this._active < this._max && this._queue.length > 0) {
      const next = this._queue.shift()
      next?.()
    }
  }
}
