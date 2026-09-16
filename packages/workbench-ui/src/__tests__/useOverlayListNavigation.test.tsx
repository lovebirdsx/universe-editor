/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for useOverlayListNavigation — the popup-side sibling of
 *  useFlatListNavigation. Mirrors its style: fireEvent.keyDown against a real
 *  render, no userEvent.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCallback, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  useOverlayListNavigation,
  type IOverlayListActivateOptions,
  type IUseOverlayListNavigationOptions,
} from '../overlay/useOverlayListNavigation.js'

afterEach(cleanup)

const LABELS = ['Sonnet', 'Opus', 'Haiku', 'GPT-5']

type HarnessProps = Partial<IUseOverlayListNavigationOptions> & {
  readonly itemCount?: number
}

function Harness({ itemCount = LABELS.length, ...overrides }: HarnessProps) {
  const [activations, setActivations] = useState<
    ReadonlyArray<{ index: number; opts: IOverlayListActivateOptions }>
  >([])
  const onActivate = useCallback((index: number, opts: IOverlayListActivateOptions) => {
    setActivations((prev) => [...prev, { index, opts }])
  }, [])
  const getTypeaheadText = useCallback((i: number) => LABELS[i] ?? `item-${i}`, [])

  const nav = useOverlayListNavigation({
    count: itemCount,
    initialIndex: 0,
    onActivate,
    getTypeaheadText,
    ...overrides,
  })

  return (
    <>
      <div data-testid="popup" ref={nav.containerRef} {...nav.containerProps}>
        {Array.from({ length: itemCount }, (_, i) => (
          <div key={i} data-testid={`item-${i}`} {...nav.getItemProps(i)}>
            {LABELS[i] ?? `item-${i}`}
          </div>
        ))}
      </div>
      <output data-testid="log">{JSON.stringify(activations)}</output>
    </>
  )
}

const popup = () => screen.getByTestId('popup')
const active = () =>
  Array.from({ length: LABELS.length }, (_, i) => screen.queryByTestId(`item-${i}`))
    .filter((el): el is HTMLElement => el !== null)
    .findIndex((el) => el.getAttribute('data-active') === 'true')
const log = () =>
  JSON.parse(screen.getByTestId('log').textContent ?? '[]') as Array<{
    index: number
    opts: IOverlayListActivateOptions
  }>

describe('useOverlayListNavigation', () => {
  it('focuses the container on mount and seeds the initial index', () => {
    render(<Harness />)
    expect(document.activeElement).toBe(popup())
    expect(active()).toBe(0)
    expect(popup().getAttribute('tabindex')).toBe('-1')
    expect(screen.getByTestId('item-0').getAttribute('aria-selected')).toBe('true')
  })

  it('seeds the cursor when the list arrives after an empty mount', () => {
    // The config bar's overflow panel mounts while its rows are still being
    // packed in by a measurement that lands after the first render, so the hook
    // sees count 0; a cursor left at -1 makes Enter a dead key forever after.
    const { rerender } = render(<Harness itemCount={0} />)
    expect(active()).toBe(-1)

    rerender(<Harness itemCount={3} />)
    expect(active()).toBe(0)
    fireEvent.keyDown(popup(), { key: 'Enter' })
    expect(log()).toEqual([{ index: 0, opts: { preview: false } }])
  })

  it('keeps the cursor but leaves focus alone when autoFocus is off', () => {
    // A list mounted next to a nested region that owns the focus opts out:
    // host refs fire child-first, so focusing here would steal it back.
    render(<Harness autoFocus={false} />)
    expect(document.activeElement).not.toBe(popup())
    expect(active()).toBe(0)
  })

  it('honours a non-zero initial index and clamps an out-of-range one', () => {
    const { unmount } = render(<Harness initialIndex={2} />)
    expect(active()).toBe(2)
    unmount()
    render(<Harness initialIndex={99} />)
    expect(active()).toBe(LABELS.length - 1)
  })

  it('moves with the arrows, Home and End, wrapping at the ends', () => {
    render(<Harness />)
    fireEvent.keyDown(popup(), { key: 'ArrowDown' })
    expect(active()).toBe(1)
    fireEvent.keyDown(popup(), { key: 'End' })
    expect(active()).toBe(LABELS.length - 1)
    // Already at the last row: wrap back to the top.
    fireEvent.keyDown(popup(), { key: 'ArrowDown' })
    expect(active()).toBe(0)
    // And the same in reverse.
    fireEvent.keyDown(popup(), { key: 'ArrowUp' })
    expect(active()).toBe(LABELS.length - 1)
    fireEvent.keyDown(popup(), { key: 'Home' })
    expect(active()).toBe(0)
  })

  it('clamps instead of wrapping when wrap is disabled', () => {
    render(<Harness wrap={false} />)
    fireEvent.keyDown(popup(), { key: 'ArrowUp' })
    expect(active()).toBe(0)
  })

  it('activates on Enter without preview and on Space with it', () => {
    render(<Harness />)
    fireEvent.keyDown(popup(), { key: 'ArrowDown' })
    fireEvent.keyDown(popup(), { key: 'Enter' })
    fireEvent.keyDown(popup(), { key: ' ' })
    expect(log()).toEqual([
      { index: 1, opts: { preview: false } },
      { index: 1, opts: { preview: true } },
    ])
  })

  it('activates the clicked row and keeps focus on the container', () => {
    render(<Harness />)
    fireEvent.mouseDown(screen.getByTestId('item-2'))
    expect(log()).toEqual([{ index: 2, opts: { preview: false } }])
    expect(document.activeElement).toBe(popup())
  })

  it('jumps by typeahead, cycling on repeats of a single letter', () => {
    vi.useFakeTimers()
    try {
      render(<Harness />)
      fireEvent.keyDown(popup(), { key: 'o' })
      expect(active()).toBe(1) // Opus
      // A different letter arriving inside the window extends the query instead
      // of starting a new one — 'og' matches nothing, so the cursor stays put.
      fireEvent.keyDown(popup(), { key: 'g' })
      expect(active()).toBe(1)
      // Past the window the query resets, so 'g' now jumps on its own.
      vi.advanceTimersByTime(600)
      fireEvent.keyDown(popup(), { key: 'g' })
      expect(active()).toBe(3) // GPT-5
      // A repeated single letter cycles to the next match after the cursor.
      vi.advanceTimersByTime(600)
      fireEvent.keyDown(popup(), { key: 'o' })
      expect(active()).toBe(1) // wrapping past the end back to Opus
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves ctrl/meta combos for the workbench and forwards Alt+digit', () => {
    const onAltDigit = vi.fn()
    render(<Harness onAltDigit={onAltDigit} />)
    fireEvent.keyDown(popup(), { key: 'p', ctrlKey: true })
    expect(active()).toBe(0)
    fireEvent.keyDown(popup(), { key: '1', code: 'Digit1', altKey: true })
    expect(onAltDigit).toHaveBeenCalledWith(1)
    // Off the number row (or out of range) it is not a jump.
    onAltDigit.mockClear()
    fireEvent.keyDown(popup(), { key: '0', code: 'Digit0', altKey: true })
    expect(onAltDigit).not.toHaveBeenCalled()
    // 9 is past the range the host binds (1..8). Forwarding it would make a key
    // that does nothing while the overlay is closed act only while it is up.
    fireEvent.keyDown(popup(), { key: '9', code: 'Digit9', altKey: true })
    expect(onAltDigit).not.toHaveBeenCalled()
  })

  it('re-seeds when the host swaps to another list in the same slot', () => {
    const { rerender } = render(<Harness initialIndex={0} />)
    fireEvent.keyDown(popup(), { key: 'ArrowDown' })
    expect(active()).toBe(1)
    rerender(<Harness initialIndex={3} />)
    expect(active()).toBe(3)
  })

  it('pulls the cursor back when the list shrinks under it', () => {
    const { rerender } = render(<Harness />)
    fireEvent.keyDown(popup(), { key: 'End' })
    expect(active()).toBe(3)
    rerender(<Harness itemCount={2} />)
    expect(active()).toBe(1)
  })

  it('does nothing on navigation keys when the list is empty', () => {
    const onActivate = vi.fn()
    render(<Harness itemCount={0} onActivate={onActivate} />)
    fireEvent.keyDown(popup(), { key: 'ArrowDown' })
    fireEvent.keyDown(popup(), { key: 'Enter' })
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('ignores keys while an IME composition is in flight', () => {
    render(<Harness />)
    // fireEvent's `isComposing` init reaches the native event; the hook reads it
    // through `nativeEvent` (React does not surface it on the synthetic event).
    fireEvent.keyDown(popup(), { key: 'ArrowDown', isComposing: true })
    expect(active()).toBe(0)
    fireEvent.keyDown(popup(), { key: 'ArrowDown', keyCode: 229 })
    expect(active()).toBe(0)
  })
})
