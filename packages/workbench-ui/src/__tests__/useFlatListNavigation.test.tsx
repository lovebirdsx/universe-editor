/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for useFlatListNavigation — the flat-list sibling of Tree's keyboard
 *  navigation. Mirrors Tree.keyboard.test.tsx's style (fireEvent.keyDown against
 *  a real render, no userEvent).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCallback, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  useFlatListNavigation,
  type IUseFlatListNavigationOptions,
} from '../list/useFlatListNavigation.js'

afterEach(cleanup)

type HarnessProps = Partial<IUseFlatListNavigationOptions> & {
  readonly itemCount?: number
  /** Render an inner input inside the first row (inner-control guard test). */
  readonly withInnerInput?: boolean
  /** Suppress row rendering so findRowElement misses (virtualization test). */
  readonly renderRows?: boolean
}

function Harness({
  itemCount = 5,
  withInnerInput = false,
  renderRows = true,
  ...overrides
}: HarnessProps) {
  // `focusedIndex` seeds local state and must NOT be spread back into the hook,
  // or the controlled value stays pinned to the initial prop.
  const { focusedIndex: initialFocusedIndex, onFocusChange, ...hookOverrides } = overrides
  const [focusedIndex, setFocusedIndex] = useState(initialFocusedIndex ?? -1)
  const containerRef = useRef<HTMLDivElement>(null)
  const getItemKey = useCallback((i: number) => `row-${i}`, [])
  const getContainer = useCallback(() => containerRef.current, [])

  const nav = useFlatListNavigation({
    count: itemCount,
    focusedIndex,
    onFocusChange: (i) => {
      setFocusedIndex(i)
      onFocusChange?.(i)
    },
    getItemKey,
    getContainer,
    ...hookOverrides,
  })

  return (
    <div ref={containerRef} data-testid="list" {...nav.containerProps}>
      {renderRows &&
        Array.from({ length: itemCount }, (_, i) => (
          <div key={i} data-testid={`row-${i}`} {...nav.getRowProps(i)}>
            row {i}
            {withInnerInput && i === 0 ? <input data-testid="inner-input" /> : null}
          </div>
        ))}
      <button type="button" data-testid="focus-3" onClick={() => nav.focusRow(3)}>
        focus 3
      </button>
    </div>
  )
}

const list = () => screen.getByTestId('list')
const selected = () =>
  Array.from(document.querySelectorAll('[data-row-key]'))
    .filter((r) => r.getAttribute('aria-selected') === 'true')
    .map((r) => r.getAttribute('data-row-key'))

describe('useFlatListNavigation — navigation keys', () => {
  it('ArrowDown from an unfocused list lands on the first row', () => {
    render(<Harness />)
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(selected()).toEqual(['row-0'])
  })

  it('ArrowDown/ArrowUp move by one and clamp at both ends', () => {
    render(<Harness focusedIndex={0} />)
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(selected()).toEqual(['row-1'])
    fireEvent.keyDown(list(), { key: 'ArrowUp' })
    expect(selected()).toEqual(['row-0'])
    fireEvent.keyDown(list(), { key: 'ArrowUp' })
    expect(selected()).toEqual(['row-0'])
  })

  it('Home/End jump to the ends', () => {
    render(<Harness focusedIndex={2} />)
    fireEvent.keyDown(list(), { key: 'End' })
    expect(selected()).toEqual(['row-4'])
    fireEvent.keyDown(list(), { key: 'Home' })
    expect(selected()).toEqual(['row-0'])
  })

  it('PageDown/PageUp use getPageSize when provided', () => {
    render(<Harness itemCount={50} focusedIndex={0} getPageSize={() => 20} />)
    fireEvent.keyDown(list(), { key: 'PageDown' })
    expect(selected()).toEqual(['row-20'])
    fireEvent.keyDown(list(), { key: 'PageUp' })
    expect(selected()).toEqual(['row-0'])
  })

  it('ignores navigation on an empty list', () => {
    const onFocusChange = vi.fn()
    render(<Harness itemCount={0} onFocusChange={onFocusChange} />)
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(onFocusChange).not.toHaveBeenCalled()
  })
})

describe('useFlatListNavigation — passthrough guards', () => {
  it('lets Alt/Ctrl/Meta combos through to the global keybinding handler', () => {
    const onFocusChange = vi.fn()
    render(<Harness focusedIndex={0} onFocusChange={onFocusChange} />)
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      fireEvent.keyDown(list(), { key: 'ArrowDown', [mod]: true })
    }
    expect(onFocusChange).not.toHaveBeenCalled()
  })

  it('ignores keys bubbling up from an inner control', () => {
    const onFocusChange = vi.fn()
    render(<Harness focusedIndex={0} withInnerInput onFocusChange={onFocusChange} />)
    fireEvent.keyDown(screen.getByTestId('inner-input'), { key: 'ArrowDown', bubbles: true })
    expect(onFocusChange).not.toHaveBeenCalled()
  })

  it('routes unhandled keys to onRowKeyDown with the focused index', () => {
    const onRowKeyDown = vi.fn()
    render(<Harness focusedIndex={2} onRowKeyDown={onRowKeyDown} />)
    fireEvent.keyDown(list(), { key: 'Delete' })
    expect(onRowKeyDown).toHaveBeenCalledTimes(1)
    expect(onRowKeyDown.mock.calls[0]![1]).toBe(2)
  })

  it('does not call onRowKeyDown when nothing is focused', () => {
    const onRowKeyDown = vi.fn()
    render(<Harness onRowKeyDown={onRowKeyDown} />)
    fireEvent.keyDown(list(), { key: 'Delete' })
    expect(onRowKeyDown).not.toHaveBeenCalled()
  })
})

describe('useFlatListNavigation — activation', () => {
  it('Enter commits and Space previews', () => {
    const onActivate = vi.fn()
    render(<Harness focusedIndex={1} onActivate={onActivate} />)
    fireEvent.keyDown(list(), { key: 'Enter' })
    expect(onActivate).toHaveBeenLastCalledWith(1, { preview: false })
    fireEvent.keyDown(list(), { key: ' ' })
    expect(onActivate).toHaveBeenLastCalledWith(1, { preview: true })
  })

  it('leaves Enter alone when no onActivate is supplied (global command wins)', () => {
    const onRowKeyDown = vi.fn()
    render(<Harness focusedIndex={1} onRowKeyDown={onRowKeyDown} />)
    const e = fireEvent.keyDown(list(), { key: 'Enter', cancelable: true })
    // Not consumed here: it falls through to the view / a global binding.
    expect(e).toBe(true)
    expect(onRowKeyDown).toHaveBeenCalledTimes(1)
  })

  it('does not activate when nothing is focused', () => {
    const onActivate = vi.fn()
    render(<Harness onActivate={onActivate} />)
    fireEvent.keyDown(list(), { key: 'Enter' })
    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('useFlatListNavigation — keyboard context menu', () => {
  it('ContextMenu key raises a contextmenu on the focused row', () => {
    render(<Harness focusedIndex={2} />)
    const spy = vi.fn()
    screen.getByTestId('row-2').addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'ContextMenu' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('Shift+F10 does the same', () => {
    render(<Harness focusedIndex={0} />)
    const spy = vi.fn()
    screen.getByTestId('row-0').addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'F10', shiftKey: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not stack menus while the key repeats', () => {
    render(<Harness focusedIndex={0} />)
    const spy = vi.fn()
    screen.getByTestId('row-0').addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'ContextMenu' })
    fireEvent.keyDown(list(), { key: 'ContextMenu', repeat: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('anchors on the first row when the cursor sits nowhere', () => {
    // Matching resolveIndexNavigation's treatment of -1 as 0. Anchoring on the
    // container instead would make the key a no-op exactly when the user has
    // just tabbed in and has no other way to reach the menu.
    render(<Harness />)
    const spy = vi.fn()
    screen.getByTestId('row-0').addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'ContextMenu' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the container when the row is not in the DOM', () => {
    // Virtualized: the cursor is on a row outside the rendered window.
    render(<Harness renderRows={false} />)
    const spy = vi.fn()
    list().addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'ContextMenu' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ignores the ContextMenu key on an empty list', () => {
    render(<Harness itemCount={0} />)
    const spy = vi.fn()
    list().addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'ContextMenu' })
    expect(spy).not.toHaveBeenCalled()
  })

  it("swallows Chromium's keyup contextmenu supplement (detail 0)", () => {
    render(<Harness focusedIndex={0} />)
    const supplement = fireEvent.contextMenu(list(), { detail: 0, cancelable: true })
    expect(supplement).toBe(false) // preventDefault'd
    const real = fireEvent.contextMenu(list(), { detail: 1, cancelable: true })
    expect(real).toBe(true)
  })
})

describe('useFlatListNavigation — reveal', () => {
  it('scrolls a rendered row into view', () => {
    render(<Harness />)
    const scrollIntoView = vi.fn()
    screen.getByTestId('row-3').scrollIntoView = scrollIntoView
    fireEvent.click(screen.getByTestId('focus-3'))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(selected()).toEqual(['row-3'])
  })

  it('falls back to scrollToIndex when the row is virtualized out', () => {
    const scrollToIndex = vi.fn()
    render(<Harness renderRows={false} scrollToIndex={scrollToIndex} />)
    fireEvent.click(screen.getByTestId('focus-3'))
    expect(scrollToIndex).toHaveBeenCalledWith(3)
  })

  it('ignores an out-of-range focusRow', () => {
    const scrollToIndex = vi.fn()
    const onFocusChange = vi.fn()
    render(
      <Harness
        itemCount={2}
        renderRows={false}
        scrollToIndex={scrollToIndex}
        onFocusChange={onFocusChange}
      />,
    )
    fireEvent.click(screen.getByTestId('focus-3'))
    expect(onFocusChange).not.toHaveBeenCalled()
    expect(scrollToIndex).not.toHaveBeenCalled()
  })
})

describe('useFlatListNavigation — container props', () => {
  it('focuses the container without scrolling on mousedown', () => {
    render(<Harness />)
    const focus = vi.fn()
    list().focus = focus
    fireEvent.mouseDown(list())
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('mirrors focus into data-focused', () => {
    render(<Harness />)
    expect(list().getAttribute('data-focused')).toBe('false')
    fireEvent.focus(list())
    expect(list().getAttribute('data-focused')).toBe('true')
    fireEvent.blur(list())
    expect(list().getAttribute('data-focused')).toBe('false')
  })

  it('defaults to listbox/option roles and switches to grid/row', () => {
    const { unmount } = render(<Harness />)
    expect(list().getAttribute('role')).toBe('listbox')
    expect(screen.getByTestId('row-0').getAttribute('role')).toBe('option')
    unmount()

    render(<Harness role="grid" ariaRowCount={5} />)
    expect(list().getAttribute('role')).toBe('grid')
    expect(list().getAttribute('aria-rowcount')).toBe('5')
    expect(screen.getByTestId('row-0').getAttribute('role')).toBe('row')
  })

  it('honours a custom row identity attribute', () => {
    render(<Harness rowDataAttr="data-row-id" />)
    expect(screen.getByTestId('row-1').getAttribute('data-row-id')).toBe('row-1')
    const spy = vi.fn()
    screen.getByTestId('row-1').addEventListener('contextmenu', spy)
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    fireEvent.keyDown(list(), { key: 'ContextMenu' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('Shift+Tab hands focus back to the caller', () => {
    const onShiftTab = vi.fn()
    render(<Harness onShiftTab={onShiftTab} />)
    fireEvent.keyDown(list(), { key: 'Tab', shiftKey: true })
    expect(onShiftTab).toHaveBeenCalledTimes(1)
  })
})

describe('useFlatListNavigation — focus seeds the cursor', () => {
  it('landing focus on an unfocused, non-empty list selects the first row', () => {
    const onFocusChange = vi.fn()
    render(<Harness onFocusChange={onFocusChange} />)
    fireEvent.focus(list())
    expect(selected()).toEqual(['row-0'])
    expect(onFocusChange).toHaveBeenCalledWith(0)
  })

  it('leaves an existing cursor where it is on refocus', () => {
    const onFocusChange = vi.fn()
    render(<Harness focusedIndex={2} onFocusChange={onFocusChange} />)
    fireEvent.blur(list())
    fireEvent.focus(list())
    expect(selected()).toEqual(['row-2'])
    expect(onFocusChange).not.toHaveBeenCalled()
  })

  it('seeds nothing on an empty list', () => {
    const onFocusChange = vi.fn()
    render(<Harness itemCount={0} onFocusChange={onFocusChange} />)
    fireEvent.focus(list())
    expect(onFocusChange).not.toHaveBeenCalled()
  })

  it('seeds once rows arrive, if focus landed while the list was still empty', () => {
    // Async lists (records over IPC, a search that has not resolved) mount empty
    // and can be focused before their data lands. `onFocus` is a one-shot DOM
    // event, so without a follow-up the cursor would stay empty until the user
    // pressed a key — the very symptom the seed exists to prevent.
    const onFocusChange = vi.fn()
    const { rerender } = render(<Harness itemCount={0} onFocusChange={onFocusChange} />)
    fireEvent.focus(list())
    expect(onFocusChange).not.toHaveBeenCalled()

    rerender(<Harness itemCount={3} onFocusChange={onFocusChange} />)
    expect(onFocusChange).toHaveBeenCalledWith(0)
    expect(selected()).toEqual(['row-0'])
  })

  it('does not re-seed a list that gained rows while unfocused', () => {
    const onFocusChange = vi.fn()
    const { rerender } = render(<Harness itemCount={0} onFocusChange={onFocusChange} />)
    rerender(<Harness itemCount={3} onFocusChange={onFocusChange} />)
    expect(onFocusChange).not.toHaveBeenCalled()
    expect(selected()).toEqual([])
  })

  it('focusSelectsFirst=false opts out entirely', () => {
    const onFocusChange = vi.fn()
    render(<Harness focusSelectsFirst={false} onFocusChange={onFocusChange} />)
    fireEvent.focus(list())
    expect(selected()).toEqual([])
    expect(onFocusChange).not.toHaveBeenCalled()
    // Opting out of the seed must not disable navigation itself.
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(selected()).toEqual(['row-0'])
  })
})
