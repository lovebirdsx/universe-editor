/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The poke seam: a record landing in the host has to reload the page once if it
 *  is mounted, and be remembered if it is not. Both halves are pure module state,
 *  so they are pinned here rather than through the editor component.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetForTests,
  noteSyncHistoryRecorded,
  perforceSyncHistoryViewState,
  SYNC_HISTORY_POKE_DEBOUNCE_MS,
} from '../syncHistoryViewState.js'

beforeEach(() => {
  vi.useFakeTimers()
  _resetForTests()
})

afterEach(() => {
  _resetForTests()
  vi.useRealTimers()
})

describe('noteSyncHistoryRecorded', () => {
  it('only raises stale while the page is unmounted', () => {
    const refresh = vi.fn()
    // Never registered: the tab was never opened, or is not the active editor.
    noteSyncHistoryRecorded()
    // Registered only AFTER the poke: a timer scheduled by it would fire into
    // this spy, so "nothing was scheduled" is actually observable here.
    perforceSyncHistoryViewState.refresh = refresh

    expect(perforceSyncHistoryViewState.stale).toBe(true)
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS * 4)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reloads a mounted page exactly once, after the debounce', () => {
    const refresh = vi.fn()
    perforceSyncHistoryViewState.refresh = refresh

    noteSyncHistoryRecorded()
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS - 1)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('merges several records landing inside one window into one reload', () => {
    // One user action can leave more than one record (a clobber remedy's force
    // retry), and each of them pokes.
    const refresh = vi.fn()
    perforceSyncHistoryViewState.refresh = refresh

    noteSyncHistoryRecorded()
    vi.advanceTimersByTime(20)
    noteSyncHistoryRecorded()
    vi.advanceTimersByTime(20)
    noteSyncHistoryRecorded()
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS)

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reloads again for a record landing after the window', () => {
    // The clobber remedy's force retry sits behind a dialog: it is a second
    // thing that happened, and the page has to show both.
    const refresh = vi.fn()
    perforceSyncHistoryViewState.refresh = refresh

    noteSyncHistoryRecorded()
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS + 1)
    noteSyncHistoryRecorded()
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS + 1)

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not fire into an unmount that happened before the timer', () => {
    const refresh = vi.fn()
    perforceSyncHistoryViewState.refresh = refresh

    noteSyncHistoryRecorded()
    // The tab was switched away inside the debounce window.
    perforceSyncHistoryViewState.refresh = null
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS + 1)

    expect(refresh).not.toHaveBeenCalled()
    // The poke is remembered for the next mount — that is the whole point of
    // raising `stale` at poke time rather than at fire time.
    expect(perforceSyncHistoryViewState.stale).toBe(true)
  })

  it('drops a pending reload on reset', () => {
    const refresh = vi.fn()
    perforceSyncHistoryViewState.refresh = refresh

    noteSyncHistoryRecorded()
    _resetForTests()
    vi.advanceTimersByTime(SYNC_HISTORY_POKE_DEBOUNCE_MS + 1)

    expect(refresh).not.toHaveBeenCalled()
    expect(perforceSyncHistoryViewState.stale).toBe(false)
    expect(perforceSyncHistoryViewState.loadSeq).toBe(0)
  })
})
