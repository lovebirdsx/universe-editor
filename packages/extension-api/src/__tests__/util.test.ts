/**
 * Tests for the self-contained utility primitives: Disposable, EventEmitter,
 * CancellationTokenSource.
 */
import { describe, expect, it, vi } from 'vitest'
import { CancellationTokenSource, Disposable, EventEmitter } from '../util.js'

describe('Disposable', () => {
  it('runs the callback on dispose, exactly once', () => {
    const callback = vi.fn()
    const d = new Disposable(callback)
    d.dispose()
    d.dispose()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('from() disposes every entry in order', () => {
    const calls: string[] = []
    const d = Disposable.from(
      { dispose: () => calls.push('a') },
      { dispose: () => calls.push('b') },
    )
    d.dispose()
    expect(calls).toEqual(['a', 'b'])
  })

  it('from() is idempotent as a whole', () => {
    const callback = vi.fn()
    Disposable.from({ dispose: callback }).dispose()
    Disposable.from({ dispose: callback }).dispose()
    expect(callback).toHaveBeenCalledTimes(2)
    const combined = Disposable.from({ dispose: callback })
    combined.dispose()
    combined.dispose()
    expect(callback).toHaveBeenCalledTimes(3)
  })

  it('plain object literals stay assignable to Disposable', () => {
    // Structural compatibility is the contract: subscriptions arrays and bridge
    // methods accept any dispose-shaped object, not just class instances.
    const literal: Disposable = { dispose: () => undefined }
    expect(() => literal.dispose()).not.toThrow()
  })
})

describe('EventEmitter', () => {
  it('delivers fired data to every listener', () => {
    const emitter = new EventEmitter<number>()
    const seen: number[] = []
    emitter.event((e) => seen.push(e))
    emitter.event((e) => seen.push(e * 10))
    emitter.fire(2)
    expect(seen).toEqual([2, 20])
    emitter.dispose()
  })

  it('unsubscribes via the returned disposable', () => {
    const emitter = new EventEmitter<string>()
    const seen: string[] = []
    const sub = emitter.event((e) => seen.push(e))
    emitter.fire('one')
    sub.dispose()
    emitter.fire('two')
    expect(seen).toEqual(['one'])
    emitter.dispose()
  })

  it('a throwing listener does not prevent delivery to the rest', () => {
    const emitter = new EventEmitter<number>()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: number[] = []
    try {
      emitter.event(() => {
        throw new Error('boom')
      })
      emitter.event((e) => seen.push(e))
      emitter.fire(1)
      expect(seen).toEqual([1])
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
      emitter.dispose()
    }
  })

  it('fire is a no-op after dispose', () => {
    const emitter = new EventEmitter<number>()
    const listener = vi.fn()
    emitter.event(listener)
    emitter.dispose()
    emitter.fire(1)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('CancellationTokenSource', () => {
  it('starts uncancelled; cancel flips the token', () => {
    const source = new CancellationTokenSource()
    expect(source.token.isCancellationRequested).toBe(false)
    source.cancel()
    expect(source.token.isCancellationRequested).toBe(true)
  })

  it('fires registered listeners once on cancel', () => {
    const source = new CancellationTokenSource()
    const listener = vi.fn()
    source.token.onCancellationRequested(listener)
    source.cancel()
    source.cancel()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fires a listener registered after cancel immediately', () => {
    const source = new CancellationTokenSource()
    source.cancel()
    const listener = vi.fn()
    source.token.onCancellationRequested(listener)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener does not prevent the rest from firing', () => {
    const source = new CancellationTokenSource()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const listener = vi.fn()
    try {
      source.token.onCancellationRequested(() => {
        throw new Error('boom')
      })
      source.token.onCancellationRequested(listener)
      source.cancel()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('dispose without cancel does not fire listeners', () => {
    const source = new CancellationTokenSource()
    const listener = vi.fn()
    source.token.onCancellationRequested(listener)
    source.dispose()
    expect(listener).not.toHaveBeenCalled()
    expect(source.token.isCancellationRequested).toBe(false)
  })

  it('the unsubscription disposable stops delivery', () => {
    const source = new CancellationTokenSource()
    const listener = vi.fn()
    const sub = source.token.onCancellationRequested(listener)
    sub.dispose()
    source.cancel()
    expect(listener).not.toHaveBeenCalled()
  })
})
