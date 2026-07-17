import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useRef, useCallback } from 'react'
import { useScrollRestore } from '../list/useScrollRestore.js'
import { ScrollStateCache } from '../list/scrollStateCache.js'

function Scroller({ scrollKey }: { scrollKey: string | undefined }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useScrollRestore(
    scrollKey,
    useCallback(() => ref.current, []),
  )
  return <div ref={ref} data-testid="scroller" />
}

const el = (r: { container: HTMLElement }): HTMLDivElement =>
  r.container.querySelector<HTMLDivElement>('[data-testid="scroller"]')!

describe('useScrollRestore', () => {
  beforeEach(() => ScrollStateCache._resetForTests())
  afterEach(() => cleanup())

  it('saves scrollTop on unmount and restores it on remount', () => {
    const first = render(<Scroller scrollKey="explorer" />)
    el(first).scrollTop = 87
    first.unmount()

    expect(ScrollStateCache.load('explorer')).toBe(87)

    const second = render(<Scroller scrollKey="explorer" />)
    expect(el(second).scrollTop).toBe(87)
  })

  it('does nothing when key is undefined', () => {
    const view = render(<Scroller scrollKey={undefined} />)
    el(view).scrollTop = 40
    view.unmount()
    // No key means nothing is ever written to the cache.
    expect(ScrollStateCache.load('undefined')).toBeUndefined()
  })

  it('restores 0 when nothing was saved for the key', () => {
    const view = render(<Scroller scrollKey="fresh" />)
    expect(el(view).scrollTop).toBe(0)
  })
})
