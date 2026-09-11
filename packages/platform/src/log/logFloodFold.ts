/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Collapses a log line that repeats faster than a human can read it into one entry per
 *  window, carrying the count of what it swallowed.
 *
 *  Written for the renderer-death retry loop: when a frame goes away without an
 *  observable event, every send can fail and print the same line, and in the shipped
 *  crash that turned into 225 identical entries — enough to bury the entries that would
 *  have explained the crash, and (because log entries are themselves forwarded to the
 *  renderer) enough to keep the loop alive on its own.
 *
 *  Single-key on purpose. Every caller so far folds exactly one known-bad message shape;
 *  a general multi-key table would need eviction policy for no benefit.
 *--------------------------------------------------------------------------------------------*/

export interface LogFloodFoldOutcome {
  /** True when this line should be logged. */
  readonly log: boolean
  /**
   * Copies dropped since the last logged line. Non-zero only on a line that is itself
   * being logged — report it there, or the count is lost.
   */
  readonly folded: number
}

export class LogFloodFold {
  private _key: string | undefined
  private _windowStart = 0
  private _pending = 0

  constructor(private readonly _windowMs: number) {}

  /**
   * `now` is passed in rather than read so the window is testable without fake timers.
   * Feed `Date.now()`.
   *
   * `key` identifies the *class* of message being folded, not the message: a caller whose
   * line varies (a frame id, a path, a trailing detail) must pass something stable, or
   * every occurrence looks new and nothing is ever folded — a silent failure, since the
   * fold's whole output is "how many did I swallow". Pass the literal text only when the
   * text really is constant.
   *
   * A count is only ever emitted by a line that is itself being logged, so a burst that
   * stops mid-window leaves its tail uncounted until the next line arrives — either a
   * repeat (which reports it) or a different message (which reports it too, attributed to
   * the message it belongs to). {@link flush} drains it explicitly for callers that need
   * to close the books.
   */
  admit(key: string, now: number): LogFloodFoldOutcome {
    if (key !== this._key || now - this._windowStart >= this._windowMs) {
      this._key = key
      this._windowStart = now
      const folded = this._pending
      this._pending = 0
      return { log: true, folded }
    }
    this._pending++
    return { log: false, folded: 0 }
  }

  /** Copies dropped since the last logged line, and forgets them. */
  flush(): number {
    const folded = this._pending
    this._pending = 0
    return folded
  }

  reset(): void {
    this._key = undefined
    this._pending = 0
  }
}
