/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Repro for: pressing a nav key (j/k/g/Space/digit) inside the markdown
 *  preview's in-place find box got swallowed. The vim-style nav listener sits on
 *  the preview container in the bubble phase; the find input renders inside that
 *  container, so its keystrokes bubbled up, were claimed by the reducer, and
 *  preventDefault()'d — so the character never reached the input. The fix yields
 *  when the event target is an editable control.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { __resetVimSurfacesForTests, getActiveVimSurface } from '@universe-editor/workbench-ui'
import { createReaderVimActions, useMarkdownKeyboardNav } from '../useMarkdownKeyboardNav.js'

function Host() {
  const rootRef = useRef<HTMLDivElement>(null)
  useMarkdownKeyboardNav(rootRef, { goBack() {}, goForward() {} }, true)
  return (
    <div ref={rootRef} data-testid="root">
      <input data-testid="find" />
    </div>
  )
}

function pressKey(el: Element, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
})

describe('useMarkdownKeyboardNav — editable-target guard', () => {
  it('does not swallow nav keys typed into an input inside the preview', () => {
    const { getByTestId } = render(<Host />)
    const input = getByTestId('find')
    // scrollBy isn't implemented in happy-dom; the guard should stop us before
    // ever reaching it, but stub it so a regression throws a clear signal.
    ;(getByTestId('root') as HTMLElement).scrollBy = () => {}

    for (const key of ['j', 'k', 'g', 'G', ' ', '3', 'h', 'l']) {
      const e = pressKey(input, key)
      expect(e.defaultPrevented).toBe(false)
    }
  })

  it('still claims nav keys when focus is on the container itself', () => {
    const { getByTestId } = render(<Host />)
    const root = getByTestId('root') as HTMLElement
    root.scrollBy = () => {}

    const e = pressKey(root, 'j')
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('markdown preview as a reader Vim surface', () => {
  function scrollable() {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { value: 400 })
    Object.defineProperty(el, 'scrollHeight', { value: 5000 })
    const scrollBy = vi.fn()
    const scrollTo = vi.fn()
    el.scrollBy = scrollBy as never
    el.scrollTo = scrollTo as never
    return { el, scrollBy, scrollTo }
  }
  const callbacks = { current: { goBack: vi.fn(), goForward: vi.fn() } }

  it('maps the list.* contract to the same scrolls as the legacy keys, with Vim counts', () => {
    const { el, scrollBy, scrollTo } = scrollable()
    const actions = createReaderVimActions(() => el, callbacks)

    actions.move?.('down', 3)
    actions.move?.('up', 1)
    actions.move?.('right', 2)
    actions.move?.('left', 1)
    actions.page?.('down', 1)
    actions.page?.('up', 2)
    actions.scrollViewport?.('down', 2)
    actions.scrollViewport?.('up', 1)

    expect(scrollBy.mock.calls.map((call) => call[0])).toEqual([
      { top: 180, behavior: 'smooth' },
      { top: -60, behavior: 'smooth' },
      { left: 120, behavior: 'smooth' },
      { left: -60, behavior: 'smooth' },
      { top: 200, behavior: 'smooth' },
      { top: -400, behavior: 'smooth' },
      { top: 40 },
      { top: -20 },
    ])

    actions.first?.(0)
    actions.last?.(0)
    expect(scrollTo.mock.calls.map((call) => call[0])).toEqual([
      { top: 0, behavior: 'smooth' },
      { top: 5000, behavior: 'smooth' },
    ])
  })

  it('treats a count on gg / G as the markdown source line', () => {
    const { el, scrollTo } = scrollable()
    // Blocks at source lines 1, 11 and 21 (data-line is 0-based), 100px apart.
    for (const [index, line] of [0, 10, 20].entries()) {
      const block = document.createElement('p')
      block.dataset['line'] = String(line)
      block.getBoundingClientRect = () => ({ top: index * 100 }) as DOMRect
      el.appendChild(block)
    }
    el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    const actions = createReaderVimActions(() => el, callbacks)

    actions.first?.(11)
    actions.last?.(21)
    actions.last?.(1)
    actions.last?.(999)
    expect(scrollTo.mock.calls.map((call) => call[0])).toEqual([
      { top: 100, behavior: 'smooth' },
      { top: 200, behavior: 'smooth' },
      { top: 0, behavior: 'smooth' },
      { top: 200, behavior: 'smooth' },
    ])
  })

  it('falls back to the edge for a count when the preview has no source lines', () => {
    const { el, scrollTo } = scrollable()
    const actions = createReaderVimActions(() => el, callbacks)
    actions.first?.(7)
    actions.last?.(7)
    expect(scrollTo.mock.calls.map((call) => call[0])).toEqual([
      { top: 0, behavior: 'smooth' },
      { top: 5000, behavior: 'smooth' },
    ])
  })

  it('does nothing once the element is gone', () => {
    const actions = createReaderVimActions(() => null, callbacks)
    expect(() => actions.move?.('down', 1)).not.toThrow()
  })

  it('registers a reader surface only while the host keeps navigation enabled (it passes false during link hints)', () => {
    function ReaderHost({ enabled }: { enabled: boolean }) {
      const rootRef = useRef<HTMLDivElement>(null)
      useMarkdownKeyboardNav(rootRef, { goBack() {}, goForward() {} }, enabled)
      return (
        <div ref={rootRef} tabIndex={0} data-testid="root">
          <input data-testid="find" />
        </div>
      )
    }
    const { getByTestId, rerender } = render(<ReaderHost enabled />)
    const root = getByTestId('root')
    root.focus()
    expect(getActiveVimSurface(document)?.surface.kind).toBe('reader')

    // An editable child (the in-preview find box) is not the reader: its keys type.
    getByTestId('find').focus()
    expect(getActiveVimSurface(document)).toBeUndefined()

    rerender(<ReaderHost enabled={false} />)
    root.focus()
    expect(getActiveVimSurface(document)).toBeUndefined()
  })
})
