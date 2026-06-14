/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/async.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  AbstractIdleValue,
  AsyncIterableSource,
  DeferredPromise,
  GlobalIdleValue,
  runWhenIdle,
} from '../../base/async.js'
import { CancellationError } from '../../base/errors.js'

describe('runWhenIdle', () => {
  it('falls back to setTimeout when requestIdleCallback is unavailable', () => {
    return new Promise<void>((resolve) => {
      runWhenIdle(undefined, (deadline) => {
        expect(deadline.didTimeout).toBe(true)
        expect(deadline.timeRemaining()).toBeGreaterThanOrEqual(0)
        resolve()
      })
    })
  })

  it('uses requestIdleCallback when provided', () => {
    return new Promise<void>((resolve) => {
      const spy = vi.fn((cb: (d: { didTimeout: boolean; timeRemaining(): number }) => void) => {
        setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)
        return 7
      })
      const cancel = vi.fn()
      runWhenIdle({ requestIdleCallback: spy as never, cancelIdleCallback: cancel }, (deadline) => {
        expect(deadline.timeRemaining()).toBe(50)
        expect(spy).toHaveBeenCalledOnce()
        resolve()
      })
    })
  })

  it('disposable cancels pending idle callback', () => {
    const cancel = vi.fn()
    const target = {
      requestIdleCallback: vi.fn(() => 42),
      cancelIdleCallback: cancel,
    }
    const d = runWhenIdle(target as never, () => {})
    d.dispose()
    expect(cancel).toHaveBeenCalledWith(42)
  })

  it('disposable cancels pending timeout fallback', () => {
    return new Promise<void>((resolve) => {
      const spy = vi.fn()
      const d = runWhenIdle(undefined, spy)
      d.dispose()
      setTimeout(() => {
        expect(spy).not.toHaveBeenCalled()
        resolve()
      }, 20)
    })
  })
})

describe('AbstractIdleValue', () => {
  it('synchronously computes value on first .value read before idle fires', () => {
    const exec = vi.fn(() => 'hello')
    const v = new AbstractIdleValue(undefined, exec)
    expect(v.isInitialized).toBe(false)
    expect(v.value).toBe('hello')
    expect(v.isInitialized).toBe(true)
    expect(exec).toHaveBeenCalledOnce()
  })

  it('does not re-run executor on subsequent .value reads', () => {
    const exec = vi.fn(() => ({ n: 1 }))
    const v = new AbstractIdleValue(undefined, exec)
    const first = v.value
    const second = v.value
    expect(first).toBe(second)
    expect(exec).toHaveBeenCalledOnce()
  })

  it('caches and re-throws the executor error', () => {
    const exec = () => {
      throw new Error('boom')
    }
    const v = new AbstractIdleValue(undefined, exec)
    expect(() => v.value).toThrow('boom')
    expect(() => v.value).toThrow('boom')
  })

  it('idle callback fires the executor once when not eagerly read', () => {
    return new Promise<void>((resolve) => {
      const exec = vi.fn(() => 'idle-result')
      const v = new AbstractIdleValue(undefined, exec)
      setTimeout(() => {
        expect(v.isInitialized).toBe(true)
        expect(v.value).toBe('idle-result')
        expect(exec).toHaveBeenCalledOnce()
        resolve()
      }, 20)
    })
  })

  it('dispose() cancels pending idle callback without running executor', () => {
    return new Promise<void>((resolve) => {
      const exec = vi.fn(() => 'should-not-run')
      const v = new AbstractIdleValue(undefined, exec)
      v.dispose()
      setTimeout(() => {
        expect(exec).not.toHaveBeenCalled()
        expect(v.isInitialized).toBe(false)
        resolve()
      }, 20)
    })
  })
})

describe('GlobalIdleValue', () => {
  it('binds to globalThis idle API', () => {
    const exec = vi.fn(() => 7)
    const v = new GlobalIdleValue(exec)
    expect(v.value).toBe(7)
    expect(exec).toHaveBeenCalledOnce()
  })
})

describe('DeferredPromise', () => {
  it('resolves via complete()', async () => {
    const d = new DeferredPromise<number>()
    expect(d.isSettled).toBe(false)
    d.complete(42)
    await expect(d.p).resolves.toBe(42)
    expect(d.isResolved).toBe(true)
    expect(d.isSettled).toBe(true)
  })

  it('rejects via error()', async () => {
    const d = new DeferredPromise<number>()
    d.error(new Error('boom'))
    await expect(d.p).rejects.toThrow('boom')
    expect(d.isRejected).toBe(true)
  })

  it('cancel() rejects with CancellationError', async () => {
    const d = new DeferredPromise<number>()
    d.cancel()
    await expect(d.p).rejects.toBeInstanceOf(CancellationError)
  })

  it('ignores settling more than once', async () => {
    const d = new DeferredPromise<number>()
    d.complete(1)
    d.complete(2)
    d.error(new Error('late'))
    await expect(d.p).resolves.toBe(1)
  })
})

describe('AsyncIterableSource', () => {
  it('delivers buffered values then completes', async () => {
    const src = new AsyncIterableSource<number>()
    src.emitOne(1)
    src.emitOne(2)
    src.resolve()
    const out: number[] = []
    for await (const v of src.asyncIterable) out.push(v)
    expect(out).toEqual([1, 2])
  })

  it('delivers values emitted after iteration has started (async)', async () => {
    const src = new AsyncIterableSource<number>()
    const collected: number[] = []
    const done = (async () => {
      for await (const v of src.asyncIterable) collected.push(v)
    })()
    src.emitOne(10)
    await Promise.resolve()
    src.emitOne(20)
    src.resolve()
    await done
    expect(collected).toEqual([10, 20])
  })

  it('reject() surfaces the error to the consumer after prior values', async () => {
    const src = new AsyncIterableSource<number>()
    src.emitOne(1)
    src.reject(new Error('mid-stream'))
    const out: number[] = []
    await expect(
      (async () => {
        for await (const v of src.asyncIterable) out.push(v)
      })(),
    ).rejects.toThrow('mid-stream')
    expect(out).toEqual([1])
  })

  it('ignores emits after close', async () => {
    const src = new AsyncIterableSource<number>()
    src.emitOne(1)
    src.resolve()
    src.emitOne(2)
    const out: number[] = []
    for await (const v of src.asyncIterable) out.push(v)
    expect(out).toEqual([1])
  })

  it('throws when consumed twice', () => {
    const src = new AsyncIterableSource<number>()
    src.resolve()
    void src.asyncIterable[Symbol.asyncIterator]()
    expect(() => src.asyncIterable[Symbol.asyncIterator]()).toThrow(/once/)
  })
})
