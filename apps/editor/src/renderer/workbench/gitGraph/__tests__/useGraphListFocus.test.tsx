/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useGraphListFocus — the commit/change list's focus mirror. The focusable scroll
 *  container reports its own DOM focus as `data-focused` (the stylesheet keys the
 *  active vs inactive selection fill off it), keeps reporting "focused" while focus
 *  moves between descendants, and reconciles against `document.activeElement` when
 *  the container is swapped out and back (the loading state).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { useRef, type FocusEvent, type RefObject } from 'react'
import { useGraphListFocus } from '../useGraphListFocus.js'

function Harness({ show = true }: { show?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const props = useGraphListFocus(ref)
  if (!show) return <div data-testid="status">Loading…</div>
  return (
    <div {...props} data-testid="list" tabIndex={0}>
      <button data-testid="load-more">Load more</button>
    </div>
  )
}

function list(): HTMLElement {
  return document.querySelector('[data-testid="list"]') as HTMLElement
}

function foreignNode(): Node {
  // Auxiliary-window nodes fail `instanceof Node` in the main realm.
  return { nodeType: 1, tagName: 'BUTTON' } as unknown as Node
}

describe('useGraphListFocus', () => {
  it('mirrors focus into data-focused', () => {
    render(<Harness />)
    expect(list().getAttribute('data-focused')).toBe('false')
    fireEvent.focus(list())
    expect(list().getAttribute('data-focused')).toBe('true')
    fireEvent.blur(list())
    expect(list().getAttribute('data-focused')).toBe('false')
  })

  it('stays focused while focus moves onto a descendant', () => {
    render(<Harness />)
    fireEvent.focus(list())
    const loadMore = document.querySelector('[data-testid="load-more"]') as HTMLElement

    // React's onBlur bubbles: the container's own button taking focus is still the list.
    fireEvent.blur(list(), { relatedTarget: loadMore })
    expect(list().getAttribute('data-focused')).toBe('true')
    fireEvent.focusIn(loadMore)
    expect(list().getAttribute('data-focused')).toBe('true')
  })

  it('drops focus when it leaves the container', () => {
    render(<Harness />)
    fireEvent.focus(list())

    fireEvent.blur(list(), { relatedTarget: document.body })
    expect(list().getAttribute('data-focused')).toBe('false')

    fireEvent.focus(list())
    fireEvent.blur(list(), { relatedTarget: null })
    expect(list().getAttribute('data-focused')).toBe('false')
  })

  it('reconciles when the container is swapped out and back', () => {
    const { rerender } = render(<Harness />)
    fireEvent.focus(list())
    expect(list().getAttribute('data-focused')).toBe('true')

    // Loading replaces the whole listbox: removing the focused node dispatches no
    // `focusout`, so the stale `true` has to be cleared by the attach reconcile.
    rerender(<Harness show={false} />)
    rerender(<Harness />)
    expect(list().getAttribute('data-focused')).toBe('false')
  })

  it('keeps data-focused when focus moves to a foreign-realm descendant', () => {
    const inside = foreignNode()
    const container = {
      ownerDocument: { activeElement: null },
      contains: (node: Node | null) => node === inside,
    } as unknown as HTMLDivElement
    const scrollRef: RefObject<HTMLDivElement | null> = { current: null }
    const { result } = renderHook(() => useGraphListFocus(scrollRef))

    act(() => result.current.ref(container))
    act(() => result.current.onFocus())
    expect(result.current['data-focused']).toBe(true)

    act(() =>
      result.current.onBlur({
        relatedTarget: inside,
        currentTarget: container,
      } as unknown as FocusEvent<HTMLDivElement>),
    )
    expect(result.current['data-focused']).toBe(true)

    act(() =>
      result.current.onBlur({
        relatedTarget: foreignNode(),
        currentTarget: container,
      } as unknown as FocusEvent<HTMLDivElement>),
    )
    expect(result.current['data-focused']).toBe(false)
  })
})
