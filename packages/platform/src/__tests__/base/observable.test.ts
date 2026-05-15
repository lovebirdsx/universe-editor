import { describe, it, expect, vi } from 'vitest'
import { observableValue, derived, transaction, autorun } from '../../base/observable/index.js'

describe('observableValue', () => {
  it('get returns initial value', () => {
    const obs = observableValue('test', 42)
    expect(obs.get()).toBe(42)
  })

  it('set updates value', () => {
    const obs = observableValue('test', 0)
    transaction((tx) => obs.set(10, tx))
    expect(obs.get()).toBe(10)
  })

  it('notifies subscriber on change', () => {
    const obs = observableValue('test', 0)
    const spy = vi.fn()
    const d = autorun((r) => {
      obs.read(r)
      spy()
    })
    expect(spy).toHaveBeenCalledTimes(1) // initial run
    transaction((tx) => obs.set(1, tx))
    expect(spy).toHaveBeenCalledTimes(2)
    d.dispose()
  })

  it('does not notify when value unchanged', () => {
    const obs = observableValue('test', 5)
    const spy = vi.fn()
    const d = autorun((r) => {
      obs.read(r)
      spy()
    })
    spy.mockClear()
    transaction((tx) => obs.set(5, tx)) // same value
    expect(spy).toHaveBeenCalledTimes(0)
    d.dispose()
  })
})

describe('derived', () => {
  it('computes from source observable', () => {
    const base = observableValue('base', 3)
    const doubled = derived(undefined, (r) => base.read(r) * 2)
    expect(doubled.get()).toBe(6)
  })

  it('updates when source changes', () => {
    const base = observableValue('base', 3)
    const doubled = derived(undefined, (r) => base.read(r) * 2)
    transaction((tx) => base.set(5, tx))
    expect(doubled.get()).toBe(10)
  })

  it('tracks multiple dependencies', () => {
    const a = observableValue('a', 1)
    const b = observableValue('b', 2)
    const sum = derived(undefined, (r) => a.read(r) + b.read(r))
    expect(sum.get()).toBe(3)
    transaction((tx) => b.set(10, tx))
    expect(sum.get()).toBe(11)
  })
})

describe('transaction', () => {
  it('batches multiple set() into one notification', () => {
    const a = observableValue('a', 0)
    const b = observableValue('b', 0)
    const spy = vi.fn()
    const d = autorun((r) => {
      a.read(r)
      b.read(r)
      spy()
    })
    spy.mockClear()
    transaction((tx) => {
      a.set(1, tx)
      b.set(2, tx)
    })
    expect(spy).toHaveBeenCalledTimes(1) // only one re-run
    expect(a.get()).toBe(1)
    expect(b.get()).toBe(2)
    d.dispose()
  })
})

describe('autorun', () => {
  it('runs immediately on creation', () => {
    const obs = observableValue('test', 'hello')
    const spy = vi.fn()
    const d = autorun((r) => {
      obs.read(r)
      spy()
    })
    expect(spy).toHaveBeenCalledTimes(1)
    d.dispose()
  })

  it('stops after dispose', () => {
    const obs = observableValue('test', 0)
    const spy = vi.fn()
    const d = autorun((r) => {
      obs.read(r)
      spy()
    })
    spy.mockClear()
    d.dispose()
    transaction((tx) => obs.set(99, tx))
    expect(spy).toHaveBeenCalledTimes(0)
  })
})
