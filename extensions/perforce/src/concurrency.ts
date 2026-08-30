/**
 * A simple concurrency gate. Every p4 command is a process spawn plus a network
 * round-trip, so running too many at once overwhelms the server and the local
 * machine (git has no such need — its operations are local and cheap). Callers
 * wrap each p4 invocation in `run`; at most `maxConcurrent` run at a time, the
 * rest queue FIFO.
 *
 * `reserve` slots are held back from background work: interactive commands (a
 * user click) may use all `maxConcurrent`, background is hard-capped at
 * `maxConcurrent - reserve`. This is a static ceiling on background, not a
 * background floor — otherwise a burst of long background commands (a 114-batch
 * reconcile scan) would still fill every slot and queue the user's click behind
 * them, which is exactly the minutes-long diff-open wedge this fixes.
 */
export type P4Priority = 'background' | 'interactive'

export class ConcurrencyGate {
  private _active = 0
  private readonly _interactive: Array<() => void> = []
  private readonly _background: Array<() => void> = []
  private _max: number
  private _backgroundCap: number
  private readonly _reserve: number

  constructor(maxConcurrent: number, reserve = 1) {
    this._max = Math.max(1, maxConcurrent)
    this._reserve = reserve
    this._backgroundCap = Math.max(1, this._max - this._reserve)
  }

  /** Adjust the cap at runtime (e.g. after a config change). */
  setMax(maxConcurrent: number): void {
    this._max = Math.max(1, maxConcurrent)
    this._backgroundCap = Math.max(1, this._max - this._reserve)
    this._drain()
  }

  async run<T>(
    task: () => Promise<T>,
    priority: P4Priority = 'background',
    onStart?: (waitedMs: number) => void,
  ): Promise<T> {
    const enqueued = Date.now()
    await this._acquire(priority)
    try {
      // onStart stays inside the try so a throwing hook can't leak the slot —
      // `_active` was already incremented and the finally below must always run.
      onStart?.(Date.now() - enqueued)
      return await task()
    } finally {
      this._release()
    }
  }

  private _acquire(priority: P4Priority): Promise<void> {
    if (this._canRun(priority)) {
      this._active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this._queueFor(priority).push(() => {
        this._active++
        resolve()
      })
    })
  }

  private _canRun(priority: P4Priority): boolean {
    return priority === 'interactive'
      ? this._active < this._max
      : this._active < this._backgroundCap
  }

  private _queueFor(priority: P4Priority): Array<() => void> {
    return priority === 'interactive' ? this._interactive : this._background
  }

  private _release(): void {
    this._active--
    this._drain()
  }

  private _drain(): void {
    // Interactive first — a user's click jumps ahead of any queued background
    // batch, even when the background work enqueued earlier.
    while (this._active < this._max) {
      const next = this._interactive.shift()
      if (next === undefined) break
      next()
    }
    while (this._active < this._backgroundCap) {
      const next = this._background.shift()
      if (next === undefined) break
      next()
    }
  }
}
