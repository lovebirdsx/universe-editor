/*---------------------------------------------------------------------------------------------
 *  Demonstrates `useLeakCheck` / `withLeakCheck` from `_helpers/leakAssert.ts`.
 *  Verifies that the tracker fires when a disposable is leaked and stays quiet
 *  when everything is cleaned up.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Emitter } from '../../base/event.js'
import { Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js'
import { useLeakCheck, withLeakCheck } from '../_helpers/leakAssert.js'

describe('useLeakCheck — no leaks in this block', () => {
  useLeakCheck()

  it('emitter created and disposed', () => {
    const e = new Emitter<number>()
    const sub = e.event(() => {})
    e.fire(1)
    sub.dispose()
    e.dispose()
  })

  it('DisposableStore drains its children', () => {
    const store = new DisposableStore()
    store.add(toDisposable(() => {}))
    store.add(toDisposable(() => {}))
    store.dispose()
  })

  it('Disposable subclass cleans up via _register', () => {
    class Foo extends Disposable {
      constructor() {
        super()
        this._register(toDisposable(() => {}))
      }
    }
    const f = new Foo()
    f.dispose()
  })
})

describe('withLeakCheck', () => {
  it('passes when fn does not leak', async () => {
    await withLeakCheck(() => {
      const d = toDisposable(() => {})
      d.dispose()
    })
  })

  it('fails when fn leaks', async () => {
    let didFail = false
    try {
      await withLeakCheck(() => {
        toDisposable(() => {}) // intentionally not disposed
      })
    } catch (e) {
      didFail = true
      expect(String(e)).toContain('Disposable leak detected')
    }
    expect(didFail).toBe(true)
  })
})
