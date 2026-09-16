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

/**
 * An overlay whose expanded body is itself an overlay — the overflow panel's
 * shape. The outer list opts out of focusing while a row is expanded, as the
 * real host does: refs fire child-first, so grabbing focus here would yank the
 * caret straight back out of the body that just took it.
 */
function NestedHarness({
  outerExitLeft,
  innerExitLeft,
}: {
  outerExitLeft: () => boolean
  innerExitLeft: () => boolean
}) {
  const noop = useCallback(() => {}, [])
  const outer = useOverlayListNavigation({
    count: 3,
    initialIndex: 0,
    onActivate: noop,
    onExitLeft: outerExitLeft,
    autoFocus: false,
  })
  const inner = useOverlayListNavigation({
    count: 2,
    initialIndex: 0,
    onActivate: noop,
    onExitLeft: innerExitLeft,
  })
  return (
    <div data-testid="outer" ref={outer.containerRef} {...outer.containerProps}>
      <div data-testid="outer-0" {...outer.getItemProps(0)}>
        row
      </div>
      <div data-testid="inner" ref={inner.containerRef} {...inner.containerProps}>
        <div data-testid="inner-0" {...inner.getItemProps(0)}>
          a
        </div>
        <div data-testid="inner-1" {...inner.getItemProps(1)}>
          b
        </div>
      </div>
    </div>
  )
}

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

  it('leaves non-alias ctrl/meta combos for the workbench and forwards Alt+digit', () => {
    const onAltDigit = vi.fn()
    render(<Harness onAltDigit={onAltDigit} />)
    // Ctrl+K leads the workbench's chord rather than moving the cursor, and no
    // Meta stroke is ever an alias (Cmd+P stays quick open on macOS). The four
    // letters that *are* aliases have their own block below.
    fireEvent.keyDown(popup(), { key: 'k', ctrlKey: true })
    fireEvent.keyDown(popup(), { key: 'ArrowDown', metaKey: true })
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

  // The Ctrl movement aliases are taken on WINDOW capture, ahead of the workbench
  // keybinding dispatcher — the phase AnchoredSurface uses for Escape, and for
  // the same reason: these strokes have real global bindings (quick open, new
  // file, replace) that would otherwise swallow them before React saw them.
  // happy-dom has no dispatcher, so what these cases pin down is the hook's own
  // contract: the mapping, the swallow-when-declined rule, and ownership.
  describe('Ctrl movement aliases', () => {
    it('steps with Ctrl+N / Ctrl+P exactly like the arrows, wrapping too', () => {
      render(<Harness />)
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      expect(active()).toBe(1)
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
      expect(active()).toBe(0)
      // Past the top it wraps, because that is what ArrowUp does on this list.
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
      expect(active()).toBe(LABELS.length - 1)
    })

    it('takes the end-of-list exits on the aliases as well', () => {
      const onExitDown = vi.fn()
      render(<Harness itemCount={2} wrap={false} onExitDown={onExitDown} />)
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      expect(active()).toBe(1)
      // Clamped at the last row — that is the exit, exactly as ArrowDown there.
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      expect(active()).toBe(1)
      expect(onExitDown).toHaveBeenCalledTimes(1)
    })

    it('hands Ctrl+L / Ctrl+H to the host, swallowing them either way', () => {
      const onExitLeft = vi.fn(() => false)
      const onExitRight = vi.fn(() => true)
      render(<Harness onExitLeft={onExitLeft} onExitRight={onExitRight} />)

      expect(fireEvent.keyDown(window, { key: 'l', ctrlKey: true })).toBe(false)
      expect(onExitRight).toHaveBeenCalledWith(0)

      // The host declined, and the stroke is swallowed all the same: leaking
      // Ctrl+H would pop the replace widget on top of the overlay.
      expect(fireEvent.keyDown(window, { key: 'h', ctrlKey: true })).toBe(false)
      expect(onExitLeft).toHaveBeenCalledWith(0)
      expect(active()).toBe(0)
    })

    it('consumes a bare ← / → only when the host takes it', () => {
      const onExitLeft = vi.fn(() => false)
      const onExitRight = vi.fn(() => true)
      render(<Harness onExitLeft={onExitLeft} onExitRight={onExitRight} />)

      expect(fireEvent.keyDown(popup(), { key: 'ArrowRight' })).toBe(false)
      expect(onExitRight).toHaveBeenCalledWith(0)
      // Declined: the arrow reaches whatever is underneath, as a menu's does.
      expect(fireEvent.keyDown(popup(), { key: 'ArrowLeft' })).toBe(true)
      expect(onExitLeft).toHaveBeenCalledWith(0)
    })

    it('answers only while its own container holds focus', () => {
      render(<Harness />)
      const elsewhere = document.createElement('button')
      document.body.append(elsewhere)
      try {
        elsewhere.focus()
        fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
        expect(active()).toBe(0)
      } finally {
        elsewhere.remove()
      }
      popup().focus()
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      expect(active()).toBe(1)
    })

    // The case the plain `contains` test gets wrong, and the one that actually
    // happens: an overflow panel's expanded row renders its body *inside* the
    // panel's own list container, so both are live and both contain the caret.
    it('lets only the innermost of two nested lists answer', () => {
      const outerExitLeft = vi.fn(() => true)
      const innerExitLeft = vi.fn(() => true)
      render(<NestedHarness outerExitLeft={outerExitLeft} innerExitLeft={innerExitLeft} />)
      // The body takes the focus as it mounts, exactly as it does in the panel.
      expect(document.activeElement).toBe(screen.getByTestId('inner'))

      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      expect(screen.getByTestId('inner-1').getAttribute('data-active')).toBe('true')
      expect(screen.getByTestId('outer-0').getAttribute('data-active')).toBe('true')

      // Ctrl+H belongs to the body's host too. The outer list answering instead
      // would collapse the row without handing the caret back, dropping it onto
      // <body> — and then no list owns the stroke that would reopen the row.
      fireEvent.keyDown(window, { key: 'h', ctrlKey: true })
      expect(innerExitLeft).toHaveBeenCalledTimes(1)
      expect(outerExitLeft).not.toHaveBeenCalled()
    })

    it('keeps stripes that already name a global command', () => {
      render(<Harness />)
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
      // Ctrl+Shift+N is a new window, Ctrl+Alt+… an AltGr character.
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true })
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true, altKey: true })
      fireEvent.keyDown(window, { key: 'p', metaKey: true })
      expect(active()).toBe(0)
    })

    it('ignores the aliases mid-composition', () => {
      render(<Harness />)
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true, isComposing: true })
      expect(active()).toBe(0)
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true, keyCode: 229 })
      expect(active()).toBe(0)
    })
  })
})
