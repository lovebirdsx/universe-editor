/*---------------------------------------------------------------------------------------------
 *  Regression test for useObservable consuming a `derived` observable.
 *
 *  A `derived` recomputes (returning a fresh reference) on every `.get()` while it
 *  has no active observer. Without snapshot caching, useSyncExternalStore would see
 *  a different reference on each getSnapshot call during render and warn
 *  "getSnapshot should be cached to avoid an infinite loop", looping forever.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { derived, observableValue } from '@universe-editor/platform'
import type { IObservable, ISettableObservable } from '@universe-editor/platform'
import { useObservable } from '../useService.js'

afterEach(cleanup)

function DerivedConsumer({ obs }: { obs: IObservable<{ n: number }> }) {
  const value = useObservable(obs)
  return <div data-testid="out">{value.n}</div>
}

describe('useObservable with derived observable', () => {
  it('does not warn about uncached getSnapshot and renders the value', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source: ISettableObservable<number> = observableValue('source', 1)
    // Each .get() while unobserved returns a brand-new object reference.
    const obj = derived((r) => ({ n: source.read(r) }))

    render(<DerivedConsumer obs={obj} />)

    expect(screen.getByTestId('out').textContent).toBe('1')
    const sawSnapshotWarning = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('getSnapshot should be cached'),
    )
    expect(sawSnapshotWarning).toBe(false)
    errorSpy.mockRestore()
  })

  it('re-renders when the underlying source changes', () => {
    const source: ISettableObservable<number> = observableValue('source', 1)
    const obj = derived((r) => ({ n: source.read(r) }))

    render(<DerivedConsumer obs={obj} />)
    expect(screen.getByTestId('out').textContent).toBe('1')

    act(() => {
      source.set(2, undefined)
    })
    expect(screen.getByTestId('out').textContent).toBe('2')
  })
})
