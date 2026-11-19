/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for useEventValue / useEventSubscription — the Event-service counterparts
 *  to useObservable. Covers: initial snapshot, re-render on fire, snapshot caching
 *  (fresh reference each getValue is allowed), disposal on unmount, and that a
 *  still-mounted subscription is markAsSingleton-wrapped so the leak tracker
 *  ignores it (the Restart-Editor snapshot regression class).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  DisposableTracker,
  Emitter,
  setDisposableTracker,
  toDisposable,
} from '@universe-editor/platform'
import { useEventSubscription, useEventValue } from '../useService.js'

afterEach(() => {
  cleanup()
  setDisposableTracker(null)
})

describe('useEventValue', () => {
  it('seeds the initial value and re-renders on fire', () => {
    const emitter = new Emitter<void>()
    let store = 1
    function Consumer() {
      const value = useEventValue(emitter.event, () => store)
      return <div data-testid="out">{value}</div>
    }

    render(<Consumer />)
    expect(screen.getByTestId('out').textContent).toBe('1')

    act(() => {
      store = 2
      emitter.fire()
    })
    expect(screen.getByTestId('out').textContent).toBe('2')
  })

  it('tolerates getValue returning a fresh reference each call (no uncached-snapshot loop)', () => {
    const emitter = new Emitter<void>()
    let n = 5
    function Consumer() {
      // Returns a brand-new object every call — the caching guard must hold.
      const value = useEventValue(emitter.event, () => ({ n }))
      return <div data-testid="out">{value.n}</div>
    }

    render(<Consumer />)
    expect(screen.getByTestId('out').textContent).toBe('5')

    act(() => {
      n = 6
      emitter.fire()
    })
    expect(screen.getByTestId('out').textContent).toBe('6')
  })

  it('disposes the subscription on unmount', () => {
    let disposed = false
    const event = (listener: () => unknown) => {
      void listener
      return toDisposable(() => {
        disposed = true
      })
    }
    function Consumer() {
      useEventValue(event as never, () => 0)
      return null
    }

    const { unmount } = render(<Consumer />)
    act(() => unmount())
    expect(disposed).toBe(true)
  })

  it('does not report its subscription as a leak while mounted', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    const emitter = new Emitter<void>()
    function Consumer() {
      useEventValue(emitter.event, () => 0)
      return null
    }
    render(<Consumer />)

    // Restart Editor snapshots leaks with React still mounted.
    const report = tracker.computeLeakingDisposables()
    // No leaking disposables — the only subscription is singleton-wrapped.
    expect(report).toBeUndefined()
  })
})

describe('useEventSubscription', () => {
  it('opens subscriptions on mount and disposes them all on unmount', () => {
    // Track each subscription instance: StrictMode's dry run opens a set, tears
    // it down, then opens the real one, so only the live count is meaningful.
    const opened: { active: boolean }[] = []
    const open = () => {
      const subscription = { active: true }
      opened.push(subscription)
      return toDisposable(() => {
        subscription.active = false
      })
    }
    function Consumer() {
      useEventSubscription(() => [open(), open()], [])
      return null
    }

    const { unmount } = render(<Consumer />)
    expect(opened.filter((subscription) => subscription.active)).toHaveLength(2)
    act(() => unmount())
    expect(opened.length).toBeGreaterThanOrEqual(2)
    expect(opened.every((subscription) => !subscription.active)).toBe(true)
  })

  it('accepts a single disposable return', () => {
    let disposed = false
    function Consumer() {
      useEventSubscription(
        () =>
          toDisposable(() => {
            disposed = true
          }),
        [],
      )
      return null
    }
    const { unmount } = render(<Consumer />)
    act(() => unmount())
    expect(disposed).toBe(true)
  })

  it('does not report its subscriptions as leaks while mounted', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    const emitter = new Emitter<void>()
    function Consumer() {
      useEventSubscription(() => emitter.event(() => {}), [])
      return null
    }
    render(<Consumer />)

    const report = tracker.computeLeakingDisposables()
    expect(report).toBeUndefined()
  })

  it('re-subscribes when deps change', () => {
    // Live subscriptions per dep value — the rehearsal's extra open/close pair
    // nets out, so this is stable under StrictMode.
    const active = new Map<number, number>()
    let dep = 0
    function Consumer({ d }: { d: number }) {
      useEventSubscription(() => {
        active.set(d, (active.get(d) ?? 0) + 1)
        return toDisposable(() => active.set(d, (active.get(d) ?? 1) - 1))
      }, [d])
      return null
    }

    const { rerender, unmount } = render(<Consumer d={dep} />)
    expect(active.get(0)).toBe(1)

    dep = 1
    act(() => rerender(<Consumer d={dep} />))
    expect(active.get(0)).toBe(0)
    expect(active.get(1)).toBe(1)

    act(() => unmount())
    expect(active.get(1)).toBe(0)
  })
})
