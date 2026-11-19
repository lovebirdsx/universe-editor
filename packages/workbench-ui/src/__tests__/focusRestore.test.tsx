import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  captureFocus,
  focusElement,
  FocusRestoreFallbackContext,
  restoreFocus,
  useFocusRestore,
  type UseFocusRestoreOptions,
} from '../overlay/focusRestore.js'

async function flushRestore(): Promise<void> {
  await act(async () => {})
}

function makeButton(id: string, doc: Document = document): HTMLButtonElement {
  const button = doc.createElement('button')
  button.textContent = id
  doc.body.appendChild(button)
  return button
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('captureFocus', () => {
  it('skips <body> and records the focused element with its document', () => {
    expect(document.activeElement).toBe(document.body)
    expect(captureFocus(document)).toBeNull()

    const opener = makeButton('opener')
    opener.focus()
    expect(captureFocus(document)).toEqual({ element: opener, document })
  })

  it('skips elements inside the excluded subtree', () => {
    const excluded = document.createElement('div')
    document.body.appendChild(excluded)
    const inside = document.createElement('button')
    excluded.appendChild(inside)
    inside.focus()

    expect(captureFocus(document, { exclude: excluded })).toBeNull()
  })
})

describe('restoreFocus', () => {
  it('focuses a still-connected snapshot element', () => {
    const opener = makeButton('opener')
    opener.focus()
    const snapshot = captureFocus(document)
    makeButton('elsewhere').focus()

    expect(restoreFocus(snapshot)).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('declines when the `when` gate says no', () => {
    const opener = makeButton('opener')
    opener.focus()
    const snapshot = captureFocus(document)
    const elsewhere = makeButton('elsewhere')
    elsewhere.focus()

    expect(restoreFocus(snapshot, { when: () => false })).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('only restores into `onlyIfLost` when focus is inside it or dropped to body', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const opener = makeButton('opener')
    opener.focus()
    const snapshot = captureFocus(document)

    const elsewhere = makeButton('elsewhere')
    elsewhere.focus()
    expect(restoreFocus(snapshot, { onlyIfLost: container })).toBe(false)
    expect(document.activeElement).toBe(elsewhere)

    elsewhere.blur()
    expect(document.activeElement).toBe(document.body)
    expect(restoreFocus(snapshot, { onlyIfLost: container })).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('accepts an `onlyIfLost` getter and follows a detached container', () => {
    let container: Element | null = document.createElement('div')
    document.body.appendChild(container)
    const opener = makeButton('opener')
    opener.focus()
    const snapshot = captureFocus(document)
    container.remove()
    document.body.focus?.()
    ;(document.activeElement as HTMLElement | null)?.blur()

    // Detached container still answers `contains` — it is the "user moved on"
    // test that matters, and body keeps it eligible.
    expect(restoreFocus(snapshot, { onlyIfLost: () => container })).toBe(true)
    expect(document.activeElement).toBe(opener)

    container = null
  })

  it('runs the fallback when the snapshot element left the document', () => {
    const opener = makeButton('opener')
    opener.focus()
    const snapshot = captureFocus(document)
    opener.remove()
    ;(document.activeElement as HTMLElement | null)?.blur()

    const fallback = vi.fn(() => true)
    expect(restoreFocus(snapshot, { fallback })).toBe(true)
    expect(fallback).toHaveBeenCalledWith(document)
    // The fallback owns the caret; restore must not focus <body>.
    expect(document.activeElement).toBe(document.body)
  })

  it('does not focus <body> when no fallback handles it', () => {
    const opener = makeButton('opener')
    opener.focus()
    const snapshot = captureFocus(document)
    opener.remove()
    ;(document.activeElement as HTMLElement | null)?.blur()

    const fallback = vi.fn(() => false)
    expect(restoreFocus(snapshot, { fallback })).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('treats a null snapshot as a no-op', () => {
    const fallback = vi.fn(() => true)
    expect(restoreFocus(null, { fallback })).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('works against an auxiliary document', () => {
    const win = new Window()
    const doc = win.document as unknown as Document
    const opener = makeButton('opener', doc)
    opener.focus()
    const snapshot = captureFocus(doc)
    const elsewhere = makeButton('elsewhere', doc)
    elsewhere.focus()

    expect(restoreFocus(snapshot)).toBe(true)
    expect(doc.activeElement).toBe(opener)
  })
})

describe('focusElement', () => {
  it('refuses detached elements and focuses connected ones', () => {
    const detached = document.createElement('button')
    expect(focusElement(detached)).toBe(false)

    const opener = makeButton('opener')
    expect(focusElement(opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
  })
})

function Host({ visible, options }: { visible: boolean; options?: UseFocusRestoreOptions }) {
  useFocusRestore(visible, options)
  return visible ? <button data-testid="inside">inside</button> : null
}

describe('useFocusRestore', () => {
  it('captures on the visible render and restores on a real close', async () => {
    const opener = makeButton('opener')
    opener.focus()

    const view = render(<Host visible={false} />)
    view.rerender(<Host visible />)
    const inside = screen.getByTestId('inside')
    inside.focus()
    expect(document.activeElement).toBe(inside)

    view.rerender(<Host visible={false} />)
    await flushRestore()
    expect(document.activeElement).toBe(opener)
  })

  it('skips the StrictMode rehearsal cleanup and keeps the snapshot for the real close', async () => {
    const opener = makeButton('opener')
    opener.focus()

    // Mounted with the overlay already visible: StrictMode replays
    // setup→cleanup→setup, and the rehearsal's deferred restore must not steal
    // the caret from the overlay.
    const view = render(<Host visible />)
    const inside = screen.getByTestId('inside')
    inside.focus()
    await flushRestore()
    expect(document.activeElement).toBe(inside)

    view.rerender(<Host visible={false} />)
    await flushRestore()
    expect(document.activeElement).toBe(opener)
  })

  it('does not pull focus back when the user moved elsewhere while it was open', async () => {
    const opener = makeButton('opener')
    opener.focus()

    const view = render(<Host visible={false} />)
    view.rerender(<Host visible />)
    const elsewhere = makeButton('elsewhere')
    elsewhere.focus()

    const container = screen.getByTestId('inside').parentElement
    view.rerender(<Host visible={false} options={{ onlyIfLost: () => container }} />)
    await flushRestore()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('leaves focus that something claimed between the close and the deferred restore', async () => {
    const opener = makeButton('opener')
    opener.focus()

    const view = render(<Host visible={false} />)
    view.rerender(<Host visible />)
    screen.getByTestId('inside').focus()

    // An accepted command runs right after the close and focuses its own target
    // (e.g. Go to Line focuses the editor and opens Monaco's quick input) before
    // the deferred restore lands; restoring would blur and dismiss it.
    const target = makeButton('target')
    view.rerender(<Host visible={false} />)
    target.focus()
    await flushRestore()
    expect(document.activeElement).toBe(target)
  })

  it('uses the context fallback when the captured element is disconnected', async () => {
    const opener = makeButton('opener')
    opener.focus()
    const fallback = vi.fn(() => true)

    const view = render(
      <FocusRestoreFallbackContext value={fallback}>
        <Host visible={false} />
      </FocusRestoreFallbackContext>,
    )
    view.rerender(
      <FocusRestoreFallbackContext value={fallback}>
        <Host visible />
      </FocusRestoreFallbackContext>,
    )
    screen.getByTestId('inside').focus()
    opener.remove()
    ;(document.activeElement as HTMLElement | null)?.blur()

    view.rerender(
      <FocusRestoreFallbackContext value={fallback}>
        <Host visible={false} />
      </FocusRestoreFallbackContext>,
    )
    await flushRestore()
    expect(fallback).toHaveBeenCalledWith(document)
    expect(document.activeElement).toBe(document.body)
  })

  it('honours the restore gate at close time', async () => {
    const opener = makeButton('opener')
    opener.focus()

    const view = render(<Host visible={false} options={{ shouldRestore: () => false }} />)
    view.rerender(<Host visible options={{ shouldRestore: () => false }} />)
    screen.getByTestId('inside').focus()

    view.rerender(<Host visible={false} options={{ shouldRestore: () => false }} />)
    await flushRestore()
    expect(document.activeElement).not.toBe(opener)
  })
})
