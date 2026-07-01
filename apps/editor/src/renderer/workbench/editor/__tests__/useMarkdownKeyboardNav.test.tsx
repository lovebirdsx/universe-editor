/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Repro for: pressing a nav key (j/k/g/Space/digit) inside the markdown
 *  preview's in-place find box got swallowed. The vim-style nav listener sits on
 *  the preview container in the bubble phase; the find input renders inside that
 *  container, so its keystrokes bubbled up, were claimed by the reducer, and
 *  preventDefault()'d — so the character never reached the input. The fix yields
 *  when the event target is an editable control.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useMarkdownKeyboardNav } from '../useMarkdownKeyboardNav.js'

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

afterEach(() => cleanup())

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
