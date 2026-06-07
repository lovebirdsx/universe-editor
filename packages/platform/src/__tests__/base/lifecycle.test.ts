/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/lifecycle.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  combinedDisposable,
  Disposable,
  DisposableMap,
  DisposableStore,
  DisposableTracker,
  dispose,
  GCBasedDisposableTracker,
  isDisposable,
  markAsSingleton,
  MutableDisposable,
  setDisposableTracker,
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

describe('DisposableMap', () => {
  afterEach(() => setDisposableTracker(null))

  it('disposes the old value when a key is overwritten', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const map = new DisposableMap<string>()
    map.set('a', toDisposable(fn1))
    map.set('a', toDisposable(fn2))
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).not.toHaveBeenCalled()
  })

  it('deleteAndDispose disposes and removes the value', () => {
    const fn = vi.fn()
    const map = new DisposableMap<string>()
    map.set('a', toDisposable(fn))
    map.deleteAndDispose('a')
    expect(fn).toHaveBeenCalledOnce()
    expect(map.has('a')).toBe(false)
  })

  it('dispose() releases every held value', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const map = new DisposableMap<string>()
    map.set('a', toDisposable(fn1))
    map.set('b', toDisposable(fn2))
    map.dispose()
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).toHaveBeenCalledOnce()
    expect(map.size).toBe(0)
  })

  it('values parent through the map: not reported as leaks under a singleton root', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const root = markAsSingleton(new DisposableStore())
    const map = root.add(new DisposableMap<string>())
    map.set(
      'a',
      toDisposable(() => {}),
    )
    map.set(
      'b',
      toDisposable(() => {}),
    )
    // The owner is alive (never disposed) but rooted at a singleton — exactly the
    // extension-host scenario. A plain Map would orphan these values and report them.
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })
})

describe('DisposableTracker', () => {
  afterEach(() => setDisposableTracker(null))

  it('reports a tracked disposable as leaking when not disposed', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const d = toDisposable(() => {})
    const report = tracker.computeLeakingDisposables()
    expect(report).toBeDefined()
    expect(report!.leaks.length).toBe(1)
    // dispose to clean up
    d.dispose()
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })

  it('does not report disposables that were disposed', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    toDisposable(() => {}).dispose()
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })

  it('rooted children of a singleton are excluded', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const root = new DisposableStore()
    markAsSingleton(root)
    root.add(toDisposable(() => {}))
    root.add(toDisposable(() => {}))
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })

  it('Disposable subclass: dispose() releases all children, no leak', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    class Foo extends Disposable {
      constructor() {
        super()
        this._register(toDisposable(() => {}))
        this._register(toDisposable(() => {}))
      }
    }
    const f = new Foo()
    f.dispose()
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })

  it('MutableDisposable: swapping value disposes old and re-parents new', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const md = new MutableDisposable<{ dispose(): void }>()
    md.value = toDisposable(() => {})
    md.value = toDisposable(() => {})
    md.dispose()
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })

  it('clearAndLeak unparents the value (leak reported)', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const md = new MutableDisposable<{ dispose(): void }>()
    md.value = toDisposable(() => {})
    md.clearAndLeak()
    md.dispose()
    // the leaked value is no longer parented and was never disposed
    const report = tracker.computeLeakingDisposables()
    expect(report).toBeDefined()
    expect(report!.leaks.length).toBe(1)
  })

  it('details string includes a stack frame', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    toDisposable(() => {})
    const report = tracker.computeLeakingDisposables()
    expect(report!.details).toMatch(/Leak #1/)
  })
})

describe('GCBasedDisposableTracker', () => {
  afterEach(() => setDisposableTracker(null))

  it('does not throw when installed and exercised', () => {
    setDisposableTracker(new GCBasedDisposableTracker())
    const d = toDisposable(() => {})
    expect(() => d.dispose()).not.toThrow()
  })
})
