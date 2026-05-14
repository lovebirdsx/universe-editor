/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/lifecycle.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  combinedDisposable,
  Disposable,
  DisposableStore,
  dispose,
  isDisposable,
  markAsSingleton,
  MutableDisposable,
  toDisposable,
} from '../../base/lifecycle.js'

describe('isDisposable', () => {
  it('returns true for objects with dispose()', () => {
    expect(isDisposable({ dispose() {} })).toBe(true)
  })

  it('returns false for non-objects', () => {
    expect(isDisposable(null)).toBe(false)
    expect(isDisposable(42)).toBe(false)
    expect(isDisposable('str')).toBe(false)
  })

  it('returns false if dispose is not a function', () => {
    expect(isDisposable({ dispose: 'nope' })).toBe(false)
  })
})

describe('toDisposable', () => {
  it('calls fn on dispose', () => {
    const fn = vi.fn()
    const d = toDisposable(fn)
    d.dispose()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('only calls fn once even if disposed multiple times', () => {
    const fn = vi.fn()
    const d = toDisposable(fn)
    d.dispose()
    d.dispose()
    expect(fn).toHaveBeenCalledOnce()
  })
})

describe('combinedDisposable', () => {
  it('disposes all when disposed', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const combined = combinedDisposable(toDisposable(fn1), toDisposable(fn2))
    combined.dispose()
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).toHaveBeenCalledOnce()
  })
})

describe('dispose()', () => {
  it('disposes a single disposable', () => {
    const fn = vi.fn()
    dispose(toDisposable(fn))
    expect(fn).toHaveBeenCalledOnce()
  })

  it('handles undefined gracefully', () => {
    expect(() => dispose(undefined)).not.toThrow()
  })

  it('disposes all items in an array', () => {
    const fns = [vi.fn(), vi.fn(), vi.fn()]
    dispose(fns.map((fn) => toDisposable(fn)))
    fns.forEach((fn) => expect(fn).toHaveBeenCalledOnce())
  })

  it('disposes all items in a Set', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const set = new Set([toDisposable(fn1), toDisposable(fn2)])
    dispose(set)
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).toHaveBeenCalledOnce()
  })
})

describe('DisposableStore', () => {
  it('disposes all added disposables', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const store = new DisposableStore()
    store.add(toDisposable(fn1))
    store.add(toDisposable(fn2))
    store.dispose()
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).toHaveBeenCalledOnce()
  })

  it('marks as disposed after dispose()', () => {
    const store = new DisposableStore()
    expect(store.isDisposed).toBe(false)
    store.dispose()
    expect(store.isDisposed).toBe(true)
  })

  it('clear() disposes items but keeps store alive', () => {
    const fn = vi.fn()
    const store = new DisposableStore()
    store.add(toDisposable(fn))
    store.clear()
    expect(fn).toHaveBeenCalledOnce()
    expect(store.isDisposed).toBe(false)
  })

  it('delete() removes and disposes a specific item', () => {
    const fn = vi.fn()
    const store = new DisposableStore()
    const d = toDisposable(fn)
    store.add(d)
    store.delete(d)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('throws when adding itself', () => {
    const store = new DisposableStore()
    expect(() => store.add(store)).toThrow()
  })
})

describe('Disposable (abstract class)', () => {
  it('_register adds to internal store and disposes on dispose()', () => {
    const fn = vi.fn()
    class MyClass extends Disposable {
      constructor() {
        super()
        this._register(toDisposable(fn))
      }
    }
    const obj = new MyClass()
    obj.dispose()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('Disposable.None is a safe no-op', () => {
    expect(() => Disposable.None.dispose()).not.toThrow()
  })
})

describe('MutableDisposable', () => {
  it('disposes old value when new value is set', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const md = new MutableDisposable<{ dispose(): void }>()
    md.value = toDisposable(fn1)
    md.value = toDisposable(fn2)
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).not.toHaveBeenCalled()
  })

  it('disposes current value on dispose()', () => {
    const fn = vi.fn()
    const md = new MutableDisposable()
    md.value = toDisposable(fn)
    md.dispose()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('returns undefined after dispose()', () => {
    const md = new MutableDisposable()
    md.value = toDisposable(() => {})
    md.dispose()
    expect(md.value).toBeUndefined()
  })

  it('clearAndLeak returns old value without disposing', () => {
    const fn = vi.fn()
    const md = new MutableDisposable()
    const d = toDisposable(fn)
    md.value = d
    const leaked = md.clearAndLeak()
    expect(leaked).toBe(d)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('markAsSingleton', () => {
  it('returns the same disposable', () => {
    const d = toDisposable(() => {})
    expect(markAsSingleton(d)).toBe(d)
  })
})
