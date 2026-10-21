/*---------------------------------------------------------------------------------------------
 *  Tests for the owner-window helpers. Auxiliary windows are separate realms: the
 *  helpers must resolve the node's own window and reject/fall back predictably
 *  when there is none (detached docs, renderer-node).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelOwnerFrame,
  getOwnerComputedStyle,
  getOwnerDocument,
  getOwnerKeyboardEvent,
  getOwnerMouseEvent,
  getOwnerResizeObserver,
  getOwnerWindow,
  requestOwnerFrame,
  type OwnerFrame,
} from '../dom/ownerWindow.js'

/** A detached document whose `defaultView` is the supplied fake window. */
function documentWithWindow(win: object): Document {
  const doc = document.implementation.createHTMLDocument('aux')
  Object.defineProperty(doc, 'defaultView', { value: win, configurable: true })
  return doc
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('getOwnerDocument / getOwnerWindow', () => {
  it('recognises a Document itself without instanceof', () => {
    expect(getOwnerDocument(document)).toBe(document)
  })

  it('resolves the owner document of elements and text nodes', () => {
    const el = document.createElement('div')
    el.textContent = 'text'
    expect(getOwnerDocument(el)).toBe(document)
    expect(getOwnerDocument(el.firstChild)).toBe(document)
    expect(getOwnerWindow(el)).toBe(document.defaultView)
  })

  it('returns undefined without a node or owner window', () => {
    expect(getOwnerDocument(null)).toBeUndefined()
    expect(getOwnerWindow(undefined)).toBeUndefined()
    const detached = document.implementation.createHTMLDocument('detached')
    expect(getOwnerWindow(detached)).toBeUndefined()
  })
})

describe('owner-realm constructors', () => {
  it('prefers the owner window’s ResizeObserver, MouseEvent and KeyboardEvent', () => {
    class FakeResizeObserver {}
    class FakeMouseEvent {}
    class FakeKeyboardEvent {}
    const win = {
      ResizeObserver: FakeResizeObserver,
      MouseEvent: FakeMouseEvent,
      KeyboardEvent: FakeKeyboardEvent,
    }
    const el = documentWithWindow(win).createElement('div')

    expect(getOwnerResizeObserver(el)).toBe(FakeResizeObserver)
    expect(getOwnerMouseEvent(el)).toBe(FakeMouseEvent)
    expect(getOwnerKeyboardEvent(el)).toBe(FakeKeyboardEvent)
  })

  it('falls back to the global constructors when the owner window lacks them', () => {
    class GlobalResizeObserver {}
    vi.stubGlobal('ResizeObserver', GlobalResizeObserver)
    const el = documentWithWindow({}).createElement('div')

    expect(getOwnerResizeObserver(el)).toBe(GlobalResizeObserver)
  })

  it('returns undefined when neither the window nor the global has the constructor', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const el = documentWithWindow({}).createElement('div')

    expect(getOwnerResizeObserver(el)).toBeUndefined()
  })

  it('calls getComputedStyle as a method of the owner window', () => {
    const declaration = { columnGap: '8px' } as CSSStyleDeclaration
    const getComputedStyle = vi.fn(() => declaration)
    const el = documentWithWindow({ getComputedStyle }).createElement('div')

    expect(getOwnerComputedStyle(el)).toBe(declaration)
    expect(getComputedStyle).toHaveBeenCalledWith(el)
  })
})

describe('requestOwnerFrame', () => {
  it('schedules on the owner window and cancels through the same window', () => {
    const frames: FrameRequestCallback[] = []
    const requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      frames.push(cb)
      return 7
    })
    const cancelAnimationFrame = vi.fn()
    const el = documentWithWindow({ requestAnimationFrame, cancelAnimationFrame }).createElement(
      'div',
    )

    const callback = vi.fn()
    const frame = requestOwnerFrame(el, callback)

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    frames[0]!(0)
    expect(callback).toHaveBeenCalledTimes(1)

    frame.cancel()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
  })

  it('falls back to the global frame loop when the owner window has none', () => {
    const requestAnimationFrame = vi.fn(() => 11)
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const el = documentWithWindow({}).createElement('div')

    const frame = requestOwnerFrame(el, () => {})
    frame.cancel()

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(11)
  })

  it('degrades to a macrotask when no frame loop exists at all', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    vi.stubGlobal('cancelAnimationFrame', undefined)

    const callback = vi.fn()
    const frame = requestOwnerFrame(undefined, callback)
    vi.runAllTimers()

    expect(callback).toHaveBeenCalledTimes(1)
    frame.cancel()
  })

  it('cancelOwnerFrame is a no-op for an undefined token', () => {
    expect(() => cancelOwnerFrame(undefined)).not.toThrow()
    const frame: OwnerFrame = { cancel: vi.fn() }
    cancelOwnerFrame(frame)
    expect(frame.cancel).toHaveBeenCalledTimes(1)
  })
})
