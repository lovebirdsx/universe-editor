/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AutoRefreshGate state machine: debounced refresh gated on visibility.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoRefreshGate } from '../useGitGraphAutoRefresh.js'

const DEBOUNCE = 500

describe('AutoRefreshGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces external changes into one refresh while visible', () => {
    const refresh = vi.fn()
    const gate = new AutoRefreshGate(refresh, DEBOUNCE, true)

    gate.onExternalChange()
    gate.onExternalChange()
    gate.onExternalChange()
    vi.advanceTimersByTime(DEBOUNCE - 1)
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    gate.dispose()
  })

  it('does not refresh while hidden — external changes only mark stale', () => {
    const refresh = vi.fn()
    const gate = new AutoRefreshGate(refresh, DEBOUNCE, false)

    gate.onExternalChange()
    vi.advanceTimersByTime(DEBOUNCE * 10)
    expect(refresh).not.toHaveBeenCalled()
    gate.dispose()
  })

  it('collapses N hidden changes into a single refresh on re-show', () => {
    const refresh = vi.fn()
    const gate = new AutoRefreshGate(refresh, DEBOUNCE, false)

    gate.onExternalChange()
    gate.onExternalChange()
    gate.onExternalChange()
    gate.setVisible(true)

    vi.advanceTimersByTime(DEBOUNCE - 1)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    gate.dispose()
  })

  it('does not refresh on re-show when nothing changed while hidden', () => {
    const refresh = vi.fn()
    const gate = new AutoRefreshGate(refresh, DEBOUNCE, false)

    gate.setVisible(true)
    vi.advanceTimersByTime(DEBOUNCE * 10)
    expect(refresh).not.toHaveBeenCalled()
    gate.dispose()
  })

  it('keeps a refresh already scheduled when the graph goes hidden mid-debounce', () => {
    const refresh = vi.fn()
    const gate = new AutoRefreshGate(refresh, DEBOUNCE, true)

    gate.onExternalChange()
    gate.setVisible(false)
    vi.advanceTimersByTime(DEBOUNCE)
    // The scheduled refresh is not cancelled by becoming hidden.
    expect(refresh).toHaveBeenCalledTimes(1)
    gate.dispose()
  })

  it('clears a pending timer on dispose', () => {
    const refresh = vi.fn()
    const gate = new AutoRefreshGate(refresh, DEBOUNCE, true)

    gate.onExternalChange()
    gate.dispose()
    vi.advanceTimersByTime(DEBOUNCE * 10)
    expect(refresh).not.toHaveBeenCalled()
  })
})
