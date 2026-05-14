/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/event.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { DisposableStore, toDisposable } from '../../base/lifecycle.js'
import { Emitter, Event } from '../../base/event.js'

describe('Event.None', () => {
  it('returns a non-throwing no-op disposable', () => {
    const d = Event.None(() => {})
    expect(() => d.dispose()).not.toThrow()
  })
})

describe('Emitter', () => {
  it('fires listeners when fire() is called', () => {
    const emitter = new Emitter<number>()
    const results: number[] = []
    emitter.event((v) => results.push(v))
    emitter.fire(1)
    emitter.fire(2)
    expect(results).toEqual([1, 2])
  })

  it('disposes listener when returned disposable is disposed', () => {
    const emitter = new Emitter<number>()
    const results: number[] = []
    const d = emitter.event((v) => results.push(v))
    emitter.fire(1)
    d.dispose()
    emitter.fire(2)
    expect(results).toEqual([1])
  })

  it('supports multiple listeners', () => {
    const emitter = new Emitter<string>()
    const a: string[] = []
    const b: string[] = []
    emitter.event((v) => a.push(v))
    emitter.event((v) => b.push(v))
    emitter.fire('hello')
    expect(a).toEqual(['hello'])
    expect(b).toEqual(['hello'])
  })

  it('does not fire after dispose()', () => {
    const emitter = new Emitter<number>()
    const results: number[] = []
    emitter.event((v) => results.push(v))
    emitter.dispose()
    emitter.fire(99)
    expect(results).toEqual([])
  })

  it('binds thisArgs correctly', () => {
    const emitter = new Emitter<number>()
    const obj = { value: 0 }
    emitter.event(function (this: typeof obj, v: number) {
      this.value = v
    }, obj)
    emitter.fire(42)
    expect(obj.value).toBe(42)
  })

  it('calls onWillAddFirstListener before first subscription', () => {
    const spy = vi.fn()
    const emitter = new Emitter<void>({ onWillAddFirstListener: spy })
    expect(spy).not.toHaveBeenCalled()
    emitter.event(() => {})
    expect(spy).toHaveBeenCalledOnce()
    emitter.event(() => {})
    expect(spy).toHaveBeenCalledOnce()
  })

  it('calls onDidRemoveLastListener after last listener is removed', () => {
    const spy = vi.fn()
    const emitter = new Emitter<void>({ onDidRemoveLastListener: spy })
    const d1 = emitter.event(() => {})
    const d2 = emitter.event(() => {})
    d1.dispose()
    expect(spy).not.toHaveBeenCalled()
    d2.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('registers disposable in DisposableStore', () => {
    const emitter = new Emitter<number>()
    const store = new DisposableStore()
    const results: number[] = []
    emitter.event((v) => results.push(v), undefined, store)
    emitter.fire(1)
    store.dispose()
    emitter.fire(2)
    expect(results).toEqual([1])
  })

  it('registers disposable in IDisposable array', () => {
    const emitter = new Emitter<number>()
    const arr: ReturnType<typeof toDisposable>[] = []
    const results: number[] = []
    emitter.event((v) => results.push(v), undefined, arr)
    emitter.fire(1)
    arr[0]?.dispose()
    emitter.fire(2)
    expect(results).toEqual([1])
  })

  it('handles re-entrant fire safely', () => {
    const emitter = new Emitter<number>()
    const results: number[] = []
    emitter.event((v) => {
      results.push(v)
      if (v === 1) emitter.fire(2)
    })
    emitter.fire(1)
    expect(results).toContain(1)
    expect(results).toContain(2)
  })

  it('catches listener errors and calls onListenerError', () => {
    const errors: unknown[] = []
    const emitter = new Emitter<void>({ onListenerError: (e) => errors.push(e) })
    emitter.event(() => {
      throw new Error('boom')
    })
    emitter.fire()
    expect(errors).toHaveLength(1)
  })
})

describe('Event.once', () => {
  it('fires exactly once', () => {
    const emitter = new Emitter<number>()
    const results: number[] = []
    Event.once(emitter.event)((v) => results.push(v))
    emitter.fire(1)
    emitter.fire(2)
    expect(results).toEqual([1])
  })
})

describe('Event.map', () => {
  it('transforms event values', () => {
    const emitter = new Emitter<number>()
    const mapped = Event.map(emitter.event, (v) => v * 2)
    const results: number[] = []
    mapped((v) => results.push(v))
    emitter.fire(3)
    expect(results).toEqual([6])
  })
})

describe('Event.filter', () => {
  it('only fires when predicate is true', () => {
    const emitter = new Emitter<number>()
    const filtered = Event.filter(emitter.event, (v) => v > 2)
    const results: number[] = []
    filtered((v) => results.push(v))
    emitter.fire(1)
    emitter.fire(3)
    emitter.fire(2)
    emitter.fire(4)
    expect(results).toEqual([3, 4])
  })
})

describe('Event.any', () => {
  it('fires when any of the source events fires', () => {
    const e1 = new Emitter<number>()
    const e2 = new Emitter<number>()
    const combined = Event.any(e1.event, e2.event)
    const results: number[] = []
    combined((v) => results.push(v))
    e1.fire(1)
    e2.fire(2)
    expect(results).toEqual([1, 2])
  })
})

describe('Event.toPromise', () => {
  it('resolves on next fire', async () => {
    const emitter = new Emitter<number>()
    const promise = Event.toPromise(emitter.event)
    emitter.fire(42)
    const result = await promise
    expect(result).toBe(42)
  })
})
