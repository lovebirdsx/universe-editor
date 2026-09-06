import { describe, expect, it } from 'vitest'
import {
  dispatchKeyboardContextMenu,
  findRowElement,
  createKeyboardContextMenuEvent,
  isContextMenuKey,
  isKeyboardContextMenu,
  isKeyupContextMenuSupplement,
} from '../tree/keyboardContextMenu.js'

describe('keyboardContextMenu', () => {
  it('marks the events it dispatches, anchored at the row bottom-left', () => {
    const row = document.createElement('div')
    row.getBoundingClientRect = () => ({ left: 40, top: 10, bottom: 32 }) as DOMRect
    document.body.appendChild(row)

    let seen: MouseEvent | undefined
    row.addEventListener('contextmenu', (e) => {
      seen = e as MouseEvent
    })
    dispatchKeyboardContextMenu(row, true)

    expect(seen).toBeDefined()
    expect(seen!.clientX).toBe(40)
    expect(seen!.clientY).toBe(32)
    expect(seen!.bubbles).toBe(true)
    // detail 1 gets it past the detail-0 guards that swallow Chromium's keyup
    // supplement, which is exactly why the origin cannot be read off `detail`.
    expect(seen!.detail).toBe(1)
    expect(isKeyboardContextMenu(seen!)).toBe(true)

    row.remove()
  })

  it('anchors at the top-left when the target is the container, not a row', () => {
    const container = document.createElement('div')
    container.getBoundingClientRect = () => ({ left: 5, top: 7, bottom: 99 }) as DOMRect
    document.body.appendChild(container)

    let seen: MouseEvent | undefined
    container.addEventListener('contextmenu', (e) => {
      seen = e as MouseEvent
    })
    dispatchKeyboardContextMenu(container, false)

    expect(seen!.clientY).toBe(7)
    container.remove()
  })

  it('reads the marker through a React synthetic wrapper too', () => {
    const row = document.createElement('div')
    row.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 0 }) as DOMRect
    document.body.appendChild(row)

    let seen: Event | undefined
    row.addEventListener('contextmenu', (e) => {
      seen = e
    })
    dispatchKeyboardContextMenu(row, true)

    expect(isKeyboardContextMenu({ nativeEvent: seen! })).toBe(true)
    row.remove()
  })

  it('does not mark a real mouse contextmenu', () => {
    expect(isKeyboardContextMenu(new MouseEvent('contextmenu', { detail: 1 }))).toBe(false)
  })

  it('marks an event it never dispatches, for hosts that call their handler directly', () => {
    const event = createKeyboardContextMenuEvent(120, 240)

    expect(event.clientX).toBe(120)
    expect(event.clientY).toBe(240)
    expect(isKeyboardContextMenu(event)).toBe(true)
    // Not dispatched anywhere, so it must not bubble if a host ever does.
    expect(event.bubbles).toBe(false)
    // Same detail-1 disguise as the dispatched flavour, so a host's own guard
    // against Chromium's keyup supplement cannot mistake it for one.
    expect(isKeyupContextMenuSupplement(event)).toBe(false)
  })

  it('identifies the keyup supplement by detail AND origin, sparing real clicks', () => {
    // Chromium's supplement: detail 0, (0,0), on the focused element.
    expect(isKeyupContextMenuSupplement(new MouseEvent('contextmenu'))).toBe(true)
    // A real right-click carries its click count.
    expect(
      isKeyupContextMenuSupplement(
        new MouseEvent('contextmenu', { detail: 1, clientX: 30, clientY: 40 }),
      ),
    ).toBe(false)
    // A CDP-driven right-click keeps detail 0 (clickCount does not feed detail)
    // but lands at real pointer coordinates — the (0,0) origin check must spare
    // it, or e2e can never open the menu.
    expect(
      isKeyupContextMenuSupplement(
        new MouseEvent('contextmenu', { detail: 0, clientX: 30, clientY: 40 }),
      ),
    ).toBe(false)
    // And so does the synthetic event the keydown path dispatches — otherwise a
    // host's guard would swallow the very menu it was asked to open.
    const row = document.createElement('div')
    row.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 0 }) as DOMRect
    document.body.appendChild(row)
    let seen: MouseEvent | undefined
    row.addEventListener('contextmenu', (e) => {
      seen = e as MouseEvent
    })
    dispatchKeyboardContextMenu(row, true)
    expect(isKeyupContextMenuSupplement(seen!)).toBe(false)
    row.remove()
  })

  it('recognises both context-menu keystrokes', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    // Plain F10 belongs to whatever the host does with it.
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
    expect(isContextMenuKey({ key: 'Enter', shiftKey: false })).toBe(false)
  })

  describe('findRowElement', () => {
    it('matches ids CSS would choke on rather than interpolating a selector', () => {
      const root = document.createElement('div')
      // A Windows path: the backslashes read as escape introducers in a selector.
      const id = 'C:\\repo\\src\\a.ts'
      root.innerHTML = `<div data-row-key="other"></div><div data-row-key="${id}"></div>`

      const found = findRowElement(root, 'data-row-key', id)
      expect(found).not.toBeNull()
      expect(found?.getAttribute('data-row-key')).toBe(id)
    })

    it('returns null when no row carries the id', () => {
      const root = document.createElement('div')
      root.innerHTML = '<div data-row-key="a"></div>'
      expect(findRowElement(root, 'data-row-key', 'missing')).toBeNull()
    })
  })
})
