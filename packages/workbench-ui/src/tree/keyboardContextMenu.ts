/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard-raised context menus, for any row list — `Tree` and the hand-rolled
 *  ones alike (session list, keybindings grid, commit graph).
 *
 *  The browser's own contextmenu event for the ContextMenu key / Shift+F10 is
 *  anchored on whatever holds focus — the scroll container, not the focused row
 *  — so the menu would open at that container's centre. So we synthesize one on
 *  the focused row with coordinates taken from its bounding rect: each view's
 *  existing row handler then opens the menu exactly as it does for a mouse
 *  right-click, and only has to ask `isKeyboardContextMenu` whether to open it
 *  with the first entry highlighted.
 *--------------------------------------------------------------------------------------------*/

/**
 * Contextmenu events synthesized from a key press. They cannot be told apart by
 * `detail` — the synthetic event deliberately claims `detail: 1` to get past the
 * detail-0 guards that swallow Chromium's keyup supplement — so the origin
 * travels out-of-band here.
 */
const keyboardContextMenuEvents = new WeakSet<Event>()

/**
 * True when this contextmenu came from the ContextMenu key / Shift+F10 rather
 * than the mouse. Views use it to open their menu with the first row already
 * highlighted (VSCode parity), since a keyboard user has no pointer to aim.
 */
export function isKeyboardContextMenu(e: Event | { nativeEvent: Event }): boolean {
  return keyboardContextMenuEvents.has('nativeEvent' in e ? e.nativeEvent : e)
}

/**
 * A marked `contextmenu` event that is never dispatched — for views that open
 * their menu by calling a handler directly instead of going through the DOM (the
 * commit graphs pass an anchor object into `openCommitMenu` & friends). The
 * handler reads coordinates off it and asks `isKeyboardContextMenu` the same way
 * it would for a real right-click.
 */
export function createKeyboardContextMenuEvent(clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent('contextmenu', { cancelable: true, detail: 1, clientX, clientY })
  keyboardContextMenuEvents.add(event)
  return event
}

/**
 * Dispatches a marked `contextmenu` on `target`, anchored at the bottom-left of
 * its bounding rect (top-left when `target` is the container itself, i.e. an
 * empty-area menu with no focused row).
 */
export function dispatchKeyboardContextMenu(target: HTMLElement, isRow: boolean): void {
  const rect = target.getBoundingClientRect()
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    // detail 1 marks the event as mouse-like so the detail-0 guards that swallow
    // Chromium's keyup supplement don't mistake this one for it.
    detail: 1,
    clientX: rect.left,
    clientY: isRow ? rect.bottom : rect.top,
  })
  keyboardContextMenuEvents.add(event)
  target.dispatchEvent(event)
}

/** True for the two keystrokes that raise a context menu (VSCode parity). */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

/**
 * True for the `contextmenu` Chromium re-dispatches on *keyup* after the
 * ContextMenu key / Shift+F10 — keydown `preventDefault` cannot cancel it. It
 * arrives with `detail: 0` and `button: -1`, targeting whatever holds focus.
 * Every host that raises its menu from the keydown must swallow it, or the same
 * keystroke opens a second, row-less menu.
 *
 * `button: -1` is the distinguishing half — Chromium's marker for "no button
 * produced this". A real right-click reports `button: 2`, including one driven
 * by CDP, whose `detail` stays 0 because `Input.dispatchMouseEvent`'s clickCount
 * does not feed `MouseEvent.detail`; `detail === 0` alone would swallow those.
 * The coordinates cannot serve as that half: the supplement lands at the centre
 * of the focused element, not at (0,0) as once assumed — and CDP clicks aim at
 * element centres too, so no coordinate test separates them.
 */
export function isKeyupContextMenuSupplement(e: { detail: number; button: number }): boolean {
  return e.detail === 0 && e.button === -1
}

/**
 * Finds a row element by its id attribute. Row ids are opaque and routinely
 * carry characters CSS gives meaning to — an SCM key embeds a Windows path,
 * whose backslashes read as escape introducers and make an interpolated
 * selector silently match nothing. Matching the attribute value directly
 * sidesteps CSS escaping altogether.
 */
export function findRowElement(
  root: HTMLElement,
  attribute: string,
  id: string,
): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
      (el) => el.getAttribute(attribute) === id,
    ) ?? null
  )
}
