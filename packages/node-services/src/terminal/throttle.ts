/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TerminalDataThrottler — coalesces high-frequency per-id string chunks into a
 *  single emission per quiet window. pty output arrives in many small chunks;
 *  over a tunnel each chunk is a framed event, so merging them into one event per
 *  ~5ms window keeps the frame count proportional to time rather than to the
 *  number of raw write() syscalls, without a perceptible output delay.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '@universe-editor/platform'

export class TerminalDataThrottler extends Disposable {
  private readonly _pending = new Map<string, string>()
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly _emit: (id: string, data: string) => void,
    private readonly _windowMs = 5,
  ) {
    super()
  }

  /** Append `data` to `id`'s pending batch; the batch is emitted after the window. */
  push(id: string, data: string): void {
    if (data.length === 0) return
    this._pending.set(id, (this._pending.get(id) ?? '') + data)
    if (this._timers.has(id)) return
    const timer = setTimeout(() => this._flush(id), this._windowMs)
    timer.unref?.()
    this._timers.set(id, timer)
  }

  /** Immediately emit `id`'s pending batch (used by tests / shutdown). */
  flushNow(id: string): void {
    this._flush(id)
  }

  /** Number of ids currently holding an unsent batch. */
  get pendingCount(): number {
    return this._pending.size
  }

  private _flush(id: string): void {
    const timer = this._timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this._timers.delete(id)
    }
    const data = this._pending.get(id)
    if (data === undefined) return
    this._pending.delete(id)
    this._emit(id, data)
  }

  override dispose(): void {
    for (const timer of this._timers.values()) clearTimeout(timer)
    this._timers.clear()
    this._pending.clear()
    super.dispose()
  }
}
