import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useRef, useCallback, useState } from 'react'
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

/**
 * Mirrors the AGENTS session list: the scroll container is rendered behind an
 * async placeholder and only appears once `ready` flips true. Restoration must
 * survive the scroller being absent at mount time.
 */
function DelayedScroller({ scrollKey }: { scrollKey: string | undefined }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  useScrollRestore(
    scrollKey,
    useCallback(() => ref.current, []),
  )
  return ready ? (
    <div ref={ref} data-testid="scroller" />
  ) : (
    <button data-testid="reveal" onClick={() => setReady(true)} />
  )
}

const el = (r: { container: HTMLElement }): HTMLDivElement =>
  r.container.querySelector<HTMLDivElement>('[data-testid="scroller"]')!

/**
 * A scroller stuck with no scroll range: assigning `scrollTop` clamps back to 0,
 * exactly like an Allotment pane that hasn't been sized yet (clientHeight ===
 * scrollHeight). Models the short-lived middle mount that must NOT overwrite the
 * saved position with its spurious 0.
 */
function UnsizedScroller({ scrollKey }: { scrollKey: string | undefined }) {
  const setRef = useCallback((node: HTMLDivElement | null) => {
    if (node && !Object.getOwnPropertyDescriptor(node, 'scrollTop')?.set) {
      Object.defineProperty(node, 'scrollTop', {
        configurable: true,
        get: () => 0,
        set: () => {
          /* no range: clamps to 0 */
        },
      })
    }
    unsizedRef.current = node
  }, [])
  const unsizedRef = useRef<HTMLDivElement | null>(null)
  useScrollRestore(
    scrollKey,
    useCallback(() => unsizedRef.current, []),
  )
  return <div ref={setRef} data-testid="scroller" />
}

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

  it('restores once the scroller appears after mount (async content)', async () => {
    ScrollStateCache.save('agentsSessionList', 120)
    const view = render(<DelayedScroller scrollKey="agentsSessionList" />)
    // Scroller not in the tree yet — the saved position can't be applied.
    expect(view.container.querySelector('[data-testid="scroller"]')).toBeNull()

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="reveal"]')!.click()
      // Let the rAF poll run and reapply the saved position.
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(el(view).scrollTop).toBe(120)
  })

  it('a short-lived remount over an unsized scroller does not clobber the saved position', () => {
    ScrollStateCache.save('agentsSessionList', 1300)
    // The middle mount sees a scroller with no scroll range: scrollTop clamps to
    // 0. Its cleanup must leave the saved 1300 intact (restoration never stuck),
    // so a later, properly-sized mount can still reach it.
    const middle = render(<UnsizedScroller scrollKey="agentsSessionList" />)
    middle.unmount()
    expect(ScrollStateCache.load('agentsSessionList')).toBe(1300)

    // Now a mount with a normal (happy-dom) scroller where scrollTop sticks.
    const real = render(<Scroller scrollKey="agentsSessionList" />)
    expect(el(real).scrollTop).toBe(1300)
  })
})
