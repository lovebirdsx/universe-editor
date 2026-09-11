/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { LogFloodFold } from '../../log/logFloodFold.js'

const WINDOW = 1000

describe('LogFloodFold', () => {
  it('lets the first occurrence through untouched', () => {
    const fold = new LogFloodFold(WINDOW)
    expect(fold.admit('boom', 0)).toEqual({ log: true, folded: 0 })
  })

  it('swallows repeats inside the window and reports them on the next one', () => {
    const fold = new LogFloodFold(WINDOW)
    fold.admit('boom', 0)
    expect(fold.admit('boom', 100)).toEqual({ log: false, folded: 0 })
    expect(fold.admit('boom', 200)).toEqual({ log: false, folded: 0 })

    // The window closing is the only chance to report the two that were dropped —
    // a fold that never emits its count is indistinguishable from data loss.
    expect(fold.admit('boom', WINDOW)).toEqual({ log: true, folded: 2 })
  })

  it('restarts the window after each logged line', () => {
    const fold = new LogFloodFold(WINDOW)
    fold.admit('boom', 0)
    fold.admit('boom', 500)
    expect(fold.admit('boom', WINDOW)).toEqual({ log: true, folded: 1 })
    // The count was consumed, so the next window starts from zero.
    expect(fold.admit('boom', WINDOW + 1)).toEqual({ log: false, folded: 0 })
    expect(fold.admit('boom', WINDOW * 2)).toEqual({ log: true, folded: 1 })
  })

  it('does not fold a different message into the running count', () => {
    const fold = new LogFloodFold(WINDOW)
    fold.admit('boom', 0)
    fold.admit('boom', 10)
    // A different text is a new key: the pending count is reported rather than
    // attributed to the wrong message.
    expect(fold.admit('bang', 20)).toEqual({ log: true, folded: 1 })
  })

  it('forgets the count on reset', () => {
    const fold = new LogFloodFold(WINDOW)
    fold.admit('boom', 0)
    fold.admit('boom', 10)
    fold.reset()
    expect(fold.admit('boom', 11)).toEqual({ log: true, folded: 0 })
  })

  it('folds a sustained flood down to one line per window', () => {
    // The shipped shape: 225 identical entries from one dying frame, arriving over
    // seconds rather than in one turn.
    const fold = new LogFloodFold(WINDOW)
    let logged = 0
    let reported = 0
    for (let i = 0; i < 225; i++) {
      const outcome = fold.admit('Error sending from webFrameMain', i * 20)
      if (outcome.log) logged++
      reported += outcome.folded
    }
    // One line per second instead of 225, and every dropped copy is accounted for
    // either on the line that replaced it or (for the tail) still being held.
    expect(logged).toBe(5)
    const trailing = fold.flush()
    expect(trailing).toBe(24)
    expect(reported + trailing).toBe(225 - logged)
  })

  it('holds the tail count until something is logged or it is flushed', () => {
    const fold = new LogFloodFold(WINDOW)
    fold.admit('boom', 0)
    for (let i = 1; i <= 10; i++) fold.admit('boom', i * 10)

    // Nothing has asked for a line since, so the ten copies are still pending.
    expect(fold.flush()).toBe(10)
    expect(fold.flush()).toBe(0)
  })

  it('folds a varying line only when the caller supplies a stable key', () => {
    // Electron appends its own tail to the frame-send failure, so keying on the raw line
    // folds nothing while still looking like a working fold — the caller passes a
    // constant instead (main/index.ts).
    const byLine = new LogFloodFold(WINDOW)
    const loggedByLine = [0, 1, 2, 3, 4].filter(
      (i) => byLine.admit(`Error sending from webFrameMain ${i}`, i * 20).log,
    )
    expect(loggedByLine).toHaveLength(5)

    const byKey = new LogFloodFold(WINDOW)
    const loggedByKey = [0, 1, 2, 3, 4].filter((i) => byKey.admit('frame-send-failure', i * 20).log)
    expect(loggedByKey).toEqual([0])
  })
})
