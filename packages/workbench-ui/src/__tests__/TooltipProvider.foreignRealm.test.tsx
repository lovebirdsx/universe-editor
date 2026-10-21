/*---------------------------------------------------------------------------------------------
 *  TooltipProvider — auxiliary-document realm.
 *
 *  Auxiliary windows are a separate JS realm, so their elements fail the main
 *  realm's `instanceof Element`. happy-dom cannot produce two realms (its
 *  `new Window()` shares constructors), so these tests feed shape-only doubles
 *  through a fake Document and assert the delegation's realm-agnostic checks.
 *  The real cross-realm path is covered by smoke.auxiliaryEditorWindow.realm.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TooltipProvider } from '../tooltip/TooltipProvider.js'

vi.mock('@floating-ui/react', () => ({
  useFloating: () => ({
    refs: { setReference: vi.fn(), setFloating: vi.fn() },
    floatingStyles: {},
  }),
  autoUpdate: vi.fn(),
  offset: vi.fn(() => ({})),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
  FloatingPortal: ({ children }: { children: ReactNode }) => children,
}))

interface FakeDocument {
  readonly doc: Document
  readonly listeners: Map<string, EventListener>
}

function makeDocument(): FakeDocument {
  const listeners = new Map<string, EventListener>()
  const doc = {
    activeElement: null,
    body: document.body,
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, listener)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  } as unknown as Document
  return { doc, listeners }
}

function dispatch(listeners: Map<string, EventListener>, type: string, event: object): void {
  const listener = listeners.get(type)
  if (!listener) throw new Error(`no ${type} listener registered`)
  listener(event as unknown as Event)
}

/** A shape-only element: nodeType/tagName are the only realm-agnostic identity. */
function foreignElement(text: string, internalTarget: EventTarget | null = null): Element {
  const el = {
    nodeType: 1,
    tagName: 'BUTTON',
    isConnected: true,
    closest: (selector: string) => (selector.includes('data-tooltip') ? el : null),
    getAttribute: (name: string) => (name === 'data-tooltip' ? text : null),
    setAttribute: () => {},
    removeAttribute: () => {},
    hasAttribute: () => false,
    contains: (node: EventTarget | null) => node === internalTarget,
  }
  return el as unknown as Element
}

describe('TooltipProvider — foreign realm event targets', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('shows a tooltip for a foreign-realm hover target', () => {
    vi.useFakeTimers()
    const { doc, listeners } = makeDocument()
    render(<TooltipProvider targetDocument={doc} delay={100} />)

    const target = foreignElement('foreign tip')
    act(() => dispatch(listeners, 'mouseover', { target, relatedTarget: null }))
    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(screen.getByRole('tooltip').textContent).toBe('foreign tip')
  })

  it('keeps the tooltip when the pointer moves onto a foreign-realm descendant', () => {
    vi.useFakeTimers()
    const { doc, listeners } = makeDocument()
    render(<TooltipProvider targetDocument={doc} delay={0} />)

    const child = foreignElement('child')
    const target = foreignElement('outer tip', child)
    act(() => dispatch(listeners, 'mouseover', { target, relatedTarget: null }))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toBeTruthy()

    // `relatedTarget` is a child node in the same foreign realm; the old
    // `instanceof Node` check treated it as "left the host" and flickered.
    act(() => dispatch(listeners, 'mouseout', { target, relatedTarget: child }))
    expect(screen.getByRole('tooltip')).toBeTruthy()

    act(() => dispatch(listeners, 'mouseout', { target, relatedTarget: null }))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
