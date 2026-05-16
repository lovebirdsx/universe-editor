/*---------------------------------------------------------------------------------------------
 *  Tests for new Event operators in packages/platform/src/base/event.ts:
 *  Event.debounce, Event.throttle, PauseableEmitter, Relay.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, Event, PauseableEmitter, Relay } from '../../base/event.js'

describe('Event.debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('collapses multiple fires within delay into one merged output', () => {
    const src = new Emitter<number>()
    const debounced = Event.debounce<number, number[]>(
      src.event,
      (last, cur) => [...(last ?? []), cur],
      50,
    )
    const results: number[][] = []
    debounced((v) => results.push(v))

    src.fire(1)
    src.fire(2)
    src.fire(3)
    expect(results).toEqual([])

    vi.advanceTimersByTime(50)
    expect(results).toEqual([[1, 2, 3]])
  })

  it('leading=true fires immediately on the first event, then again after delay', () => {
    const src = new Emitter<number>()
    const debounced = Event.debounce<number, number>(src.event, (_, cur) => cur, 50, true)
    const results: number[] = []
    debounced((v) => results.push(v))

    src.fire(1)
    expect(results).toEqual([1])

    src.fire(2)
    src.fire(3)
    vi.advanceTimersByTime(50)
    expect(results).toEqual([1, 3])
  })

  it('leading=true does not fire trailing when only one event in window', () => {
    const src = new Emitter<number>()
    const debounced = Event.debounce<number, number>(src.event, (_, cur) => cur, 50, true)
    const results: number[] = []
    debounced((v) => results.push(v))

    src.fire(42)
    vi.advanceTimersByTime(50)
    expect(results).toEqual([42])
  })

  it('flushOnListenerRemove flushes pending output before unsubscribe', () => {
    const src = new Emitter<number>()
    const debounced = Event.debounce<number, number>(
      src.event,
      (_, cur) => cur,
      50,
      false,
      /* flushOnListenerRemove */ true,
    )
    const results: number[] = []
    const sub = debounced((v) => results.push(v))

    src.fire(1)
    src.fire(2)
    sub.dispose()
    expect(results).toEqual([2])
  })
})

describe('Event.throttle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('leading fires immediately, subsequent events are coalesced and emitted at window end', () => {
    const src = new Emitter<number>()
    const throttled = Event.throttle<number, number>(
      src.event,
      (last, cur) => (last ?? 0) + cur,
      50,
    )
    const results: number[] = []
    throttled((v) => results.push(v))

    src.fire(1)
    expect(results).toEqual([1])
    src.fire(2)
    src.fire(3)
    expect(results).toEqual([1])

    vi.advanceTimersByTime(50)
    expect(results).toEqual([1, 5])
  })

  it('leading=false defers the first event to window end', () => {
    const src = new Emitter<number>()
    const throttled = Event.throttle<number, number>(
      src.event,
      (last, cur) => (last ?? 0) + cur,
      50,
      false,
      true,
    )
    const results: number[] = []
    throttled((v) => results.push(v))

    src.fire(1)
    src.fire(2)
    expect(results).toEqual([])
    vi.advanceTimersByTime(50)
    expect(results).toEqual([3])
  })

  it('trailing=false suppresses the window-end emit', () => {
    const src = new Emitter<number>()
    const throttled = Event.throttle<number, number>(
      src.event,
      (last, cur) => (last ?? 0) + cur,
      50,
      true,
      false,
    )
    const results: number[] = []
    throttled((v) => results.push(v))

    src.fire(1)
    src.fire(2)
    src.fire(3)
    vi.advanceTimersByTime(50)
    expect(results).toEqual([1])
  })
})

describe('PauseableEmitter', () => {
  it('does not fire while paused; flushes on resume', () => {
    const e = new PauseableEmitter<number>()
    const results: number[] = []
    e.event((v) => results.push(v))

    e.pause()
    e.fire(1)
    e.fire(2)
    expect(results).toEqual([])
    e.resume()
    expect(results).toEqual([1, 2])
  })

  it('merge collapses queued events into a single fire on resume', () => {
    const e = new PauseableEmitter<number>({ merge: (xs) => xs.reduce((a, b) => a + b, 0) })
    const results: number[] = []
    e.event((v) => results.push(v))

    e.pause()
    e.fire(1)
    e.fire(2)
    e.fire(3)
    e.resume()
    expect(results).toEqual([6])
  })

  it('nested pause/resume counts correctly', () => {
    const e = new PauseableEmitter<number>()
    const results: number[] = []
    e.event((v) => results.push(v))

    e.pause()
    e.pause()
    e.fire(1)
    e.resume()
    expect(results).toEqual([])
    e.resume()
    expect(results).toEqual([1])
  })

  it('fires synchronously when not paused', () => {
    const e = new PauseableEmitter<string>()
    const results: string[] = []
    e.event((v) => results.push(v))
    e.fire('hi')
    expect(results).toEqual(['hi'])
  })

  it('re-pause during resume stops flushing', () => {
    const e = new PauseableEmitter<number>()
    const results: number[] = []
    e.event((v) => {
      results.push(v)
      if (v === 1) e.pause()
    })

    e.pause()
    e.fire(1)
    e.fire(2)
    e.fire(3)
    e.resume()
    expect(results).toEqual([1])
    e.resume()
    expect(results).toEqual([1, 2, 3])
  })
})

describe('Relay', () => {
  it('forwards events from the active input', () => {
    const e1 = new Emitter<number>()
    const relay = new Relay<number>()
    relay.input = e1.event

    const results: number[] = []
    relay.event((v) => results.push(v))
    e1.fire(1)
    e1.fire(2)
    expect(results).toEqual([1, 2])
  })

  it('switching input unsubscribes from old and listens to new', () => {
    const e1 = new Emitter<number>()
    const e2 = new Emitter<number>()
    const relay = new Relay<number>()
    relay.input = e1.event

    const results: number[] = []
    relay.event((v) => results.push(v))
    e1.fire(1)
    relay.input = e2.event
    e1.fire(99) // should NOT reach
    e2.fire(2)
    expect(results).toEqual([1, 2])
  })

  it('no listener => no subscription held on input', () => {
    const onWillAdd = vi.fn()
    const onDidRemove = vi.fn()
    const e1 = new Emitter<number>({
      onWillAddFirstListener: onWillAdd,
      onDidRemoveLastListener: onDidRemove,
    })
    const relay = new Relay<number>()
    relay.input = e1.event
    expect(onWillAdd).not.toHaveBeenCalled()

    const sub = relay.event(() => {})
    expect(onWillAdd).toHaveBeenCalledOnce()
    sub.dispose()
    expect(onDidRemove).toHaveBeenCalledOnce()
  })

  it('dispose cleans up listener and emitter', () => {
    const e1 = new Emitter<number>()
    const relay = new Relay<number>()
    relay.input = e1.event
    const results: number[] = []
    relay.event((v) => results.push(v))
    relay.dispose()
    e1.fire(1)
    expect(results).toEqual([])
  })
})
