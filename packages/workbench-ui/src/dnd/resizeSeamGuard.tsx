/*---------------------------------------------------------------------------------------------
 *  Resize-seam gesture arbitration.
 *
 *  A pointer press a few pixels inside a pane edge hits the draggable content
 *  underneath the (thin) sash and starts a native HTML5 drag instead of
 *  resizing. Cancelling at `dragstart` is too late: the browser already
 *  committed the gesture to the content, and `preventDefault()` cannot hand it
 *  back to the sash. This guard decides ownership at `pointerdown` and forwards
 *  the gesture to the real sash once the pointer moves along the seam axis.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { useOwnerDocument } from '../overlay/ownerDocumentContext.js'

export const RESIZE_SEAM_BAND_PX = 10
export const RESIZE_START_THRESHOLD_PX = 3

export type ResizeSeamKind = 'allotment' | 'mouse-sash'
export type ResizeSeamOrientation = 'vertical' | 'horizontal'

export interface ResizeSeamHit {
  readonly el: HTMLElement
  readonly kind: ResizeSeamKind
  readonly orientation: ResizeSeamOrientation
  readonly distance: number
}

export interface ResizeSeamDragGuardProps {
  readonly document?: Document | undefined
  readonly band?: number | undefined
}

const ALLOTMENT_SASH_SELECTOR = '[data-testid="sash"]'
const MOUSE_SASH_SELECTOR = '[data-resize-sash="true"]'
const SASH_SELECTOR = `${ALLOTMENT_SASH_SELECTOR}, ${MOUSE_SASH_SELECTOR}`
// Nested controls own their pointer gesture: pressing a row action button and
// moving must never turn into a row drag. Deliberately excludes `img` (native
// image drags are legitimate) and row-like roles (the drag source itself).
const NESTED_ACTION_CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label[for]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',')

const SYNTHETIC_EVENTS = new WeakSet<Event>()

type DomView = Window & typeof globalThis

interface SuspendedDraggable {
  readonly el: Element
  readonly previous: string | null
  readonly observer: MutationObserver | null
}

interface PressedDrag {
  readonly target: Element
  readonly source: Element
}

interface GestureOrigin {
  readonly pointerId: number
  readonly pointerType: string
  readonly startX: number
  readonly startY: number
  readonly startScreenX: number
  readonly startScreenY: number
  readonly seam: ResizeSeamHit
}

interface ActiveGesture extends GestureOrigin {
  phase: 'pending' | 'forwarded'
  readonly suspended: SuspendedDraggable
}

function asElement(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Element).closest !== 'function') return null
  return target as Element
}

function closestSash(target: Element | null): HTMLElement | null {
  return target?.closest<HTMLElement>(SASH_SELECTOR) ?? null
}

function resolveOrientation(el: HTMLElement, rect: DOMRect): ResizeSeamOrientation {
  const aria = el.getAttribute('aria-orientation')
  if (aria === 'vertical' || aria === 'horizontal') return aria
  if (el.classList.contains('sash-vertical')) return 'vertical'
  if (el.classList.contains('sash-horizontal')) return 'horizontal'
  return rect.width < rect.height ? 'vertical' : 'horizontal'
}

function isHittable(el: HTMLElement): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return style?.visibility !== 'hidden' && style?.pointerEvents !== 'none'
}

function seamHitForElement(el: HTMLElement): ResizeSeamHit {
  return {
    el,
    kind: el.dataset['resizeSash'] === 'true' ? 'mouse-sash' : 'allotment',
    orientation: resolveOrientation(el, el.getBoundingClientRect()),
    distance: 0,
  }
}

/**
 * The nearest enabled resize seam within `band` px of the point. Seams are
 * measured by their rect centre (Allotment's sash straddles the boundary, so
 * its centre is the seam) — never by the row's own edges, which can be shifted
 * by a scrollbar and do not necessarily border a sash at all.
 */
export function findResizeSeamAtPoint(
  doc: Document,
  clientX: number,
  clientY: number,
  band: number = RESIZE_SEAM_BAND_PX,
): ResizeSeamHit | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
  let best: ResizeSeamHit | null = null
  for (const el of doc.querySelectorAll<HTMLElement>(SASH_SELECTOR)) {
    if (el.classList.contains('sash-disabled') || !isHittable(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const orientation = resolveOrientation(el, rect)
    const along = orientation === 'vertical' ? clientX : clientY
    const center =
      orientation === 'vertical' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
    const cross = orientation === 'vertical' ? clientY : clientX
    const crossMin = orientation === 'vertical' ? rect.top : rect.left
    const crossMax = orientation === 'vertical' ? rect.bottom : rect.right
    if (cross < crossMin || cross > crossMax) continue
    const distance = Math.abs(along - center)
    if (distance > band) continue
    if (best && best.distance <= distance) continue
    best = {
      el,
      kind: el.dataset['resizeSash'] === 'true' ? 'mouse-sash' : 'allotment',
      orientation,
      distance,
    }
  }
  return best
}

/**
 * The element the browser would pick as the native drag source: the nearest
 * explicit `[draggable="true"]` ancestor, or a natively draggable image / link.
 */
export function findNativeDragSourceAtPoint(target: Element | null): Element | null {
  let el: Element | null = target
  while (el) {
    if (el.getAttribute('draggable') === 'true') return el
    const tag = el.tagName
    if (tag === 'IMG' || (tag === 'A' && el.hasAttribute('href'))) {
      if ((el as HTMLElement).draggable !== false) return el
    }
    el = el.parentElement
  }
  return null
}

function isNestedActionControl(target: Element, source: Element): boolean {
  const control = target.closest(NESTED_ACTION_CONTROL_SELECTOR)
  if (!control) return false
  // The native source may be an image/link inside the control (both are
  // draggable by default) rather than the row itself; compare the control
  // against the nearest explicitly draggable ancestor instead.
  const owner = target.closest('[draggable="true"]') ?? source
  return control !== owner && owner.contains(control)
}

function suspendDraggable(el: Element): SuspendedDraggable {
  const previous = el.getAttribute('draggable')
  el.setAttribute('draggable', 'false')
  // A React re-render during the resize re-applies the row's `draggable: true`
  // prop, which would let native DnD start and cancel the pointer stream.
  const Ctor = el.ownerDocument.defaultView?.MutationObserver
  const observer = Ctor
    ? new Ctor(() => {
        if (el.getAttribute('draggable') !== 'false') el.setAttribute('draggable', 'false')
      })
    : null
  observer?.observe(el, { attributes: true, attributeFilter: ['draggable'] })
  return { el, previous, observer }
}

function restoreDraggable(suspended: SuspendedDraggable): void {
  suspended.observer?.disconnect()
  if (suspended.previous === null) suspended.el.removeAttribute('draggable')
  else suspended.el.setAttribute('draggable', suspended.previous)
}

function definePageCoords(ev: Event, view: Window | null, clientX: number, clientY: number): void {
  Object.defineProperty(ev, 'pageX', {
    value: clientX + (view?.scrollX ?? 0),
    configurable: true,
  })
  Object.defineProperty(ev, 'pageY', {
    value: clientY + (view?.scrollY ?? 0),
    configurable: true,
  })
}

function makePointerEvent(
  view: DomView | null,
  type: 'pointerdown' | 'pointerup',
  gesture: GestureOrigin,
  buttons: number,
): Event | null {
  const Ctor =
    view?.PointerEvent ?? (typeof PointerEvent === 'undefined' ? undefined : PointerEvent)
  if (Ctor) {
    return new Ctor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: gesture.startX,
      clientY: gesture.startY,
      screenX: gesture.startScreenX,
      screenY: gesture.startScreenY,
      button: 0,
      buttons,
      pointerId: gesture.pointerId,
      pointerType: gesture.pointerType,
      isPrimary: true,
    })
  }
  const MouseCtor = view?.MouseEvent ?? (typeof MouseEvent === 'undefined' ? undefined : MouseEvent)
  if (!MouseCtor) return null
  const mouse = new MouseCtor(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: gesture.startX,
    clientY: gesture.startY,
    screenX: gesture.startScreenX,
    screenY: gesture.startScreenY,
    button: 0,
    buttons,
  })
  Object.defineProperty(mouse, 'pointerId', { value: gesture.pointerId })
  Object.defineProperty(mouse, 'pointerType', { value: gesture.pointerType })
  Object.defineProperty(mouse, 'isPrimary', { value: true })
  return mouse
}

function dispatchSyntheticPointerDown(gesture: ActiveGesture): void {
  const view = gesture.seam.el.ownerDocument.defaultView
  const ev = makePointerEvent(view, 'pointerdown', gesture, 1)
  if (!ev) return
  definePageCoords(ev, view, gesture.startX, gesture.startY)
  SYNTHETIC_EVENTS.add(ev)
  try {
    gesture.seam.el.dispatchEvent(ev)
  } catch (err) {
    console.debug('[resizeSeamGuard] failed to forward pointerdown to sash', err)
  }
}

function dispatchSyntheticPointerUp(gesture: GestureOrigin): void {
  const el = gesture.seam.el
  const view = el.ownerDocument.defaultView
  const ev = makePointerEvent(view, 'pointerup', gesture, 0)
  if (!ev) return
  definePageCoords(ev, view, gesture.startX, gesture.startY)
  SYNTHETIC_EVENTS.add(ev)
  // Allotment's pointerup handler calls releasePointerCapture *before* it
  // removes its window listeners; after pointercancel the pointer is inactive
  // and that call throws, stranding the listeners. Neutralise it for this one
  // dispatch, then release the real capture best-effort.
  const hadOwn = Object.prototype.hasOwnProperty.call(el, 'releasePointerCapture')
  const original = el.releasePointerCapture
  el.releasePointerCapture = () => {}
  try {
    el.dispatchEvent(ev)
  } catch (err) {
    console.debug('[resizeSeamGuard] failed to forward pointerup to sash', err)
  } finally {
    if (hadOwn) el.releasePointerCapture = original
    else Reflect.deleteProperty(el, 'releasePointerCapture')
    if (typeof original === 'function') {
      try {
        original.call(el, gesture.pointerId)
      } catch {
        // The pointer is already inactive (pointercancel); nothing to release.
      }
    }
  }
}

function dispatchSyntheticMouseDown(gesture: ActiveGesture): void {
  const view = gesture.seam.el.ownerDocument.defaultView
  const Ctor = view?.MouseEvent ?? (typeof MouseEvent === 'undefined' ? undefined : MouseEvent)
  if (!Ctor) return
  const ev = new Ctor('mousedown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: gesture.startX,
    clientY: gesture.startY,
    screenX: gesture.startScreenX,
    screenY: gesture.startScreenY,
    button: 0,
    buttons: 1,
  })
  SYNTHETIC_EVENTS.add(ev)
  try {
    gesture.seam.el.dispatchEvent(ev)
    // Best effort: capture retargets the compatibility mouse events to the
    // sash, so neither the source button nor its row sees the release/click.
    if (typeof gesture.seam.el.setPointerCapture === 'function') {
      try {
        gesture.seam.el.setPointerCapture(gesture.pointerId)
      } catch {
        // The pointer may already be gone; the sash still tracks window mouse moves.
      }
    }
  } catch (err) {
    console.debug('[resizeSeamGuard] failed to forward mousedown to sash', err)
  }
}

function dispatchSyntheticMouseUp(view: DomView | null): void {
  const Ctor = view?.MouseEvent ?? (typeof MouseEvent === 'undefined' ? undefined : MouseEvent)
  if (!Ctor) return
  const up = new Ctor('mouseup', { bubbles: true, cancelable: true })
  SYNTHETIC_EVENTS.add(up)
  try {
    view?.dispatchEvent(up)
  } catch {
    // Cancellation cleanup is best-effort.
  }
}

/**
 * Mount once per workbench document. It owns the pointerdown arbitration
 * between draggable content and resize seams; drag sources must not duplicate
 * edge heuristics of their own.
 */
export function ResizeSeamDragGuard({
  document: explicitDocument,
  band = RESIZE_SEAM_BAND_PX,
}: ResizeSeamDragGuardProps): null {
  const ownerDocument = useOwnerDocument(explicitDocument)
  const bandRef = useRef(band)
  bandRef.current = band

  useEffect(() => {
    if (!ownerDocument) return
    const view = ownerDocument.defaultView
    let active: ActiveGesture | null = null
    let nativeSash: GestureOrigin | null = null
    let lastPress: PressedDrag | null = null
    let suppressClick = false
    let suppressTimer: ReturnType<typeof setTimeout> | undefined

    const restore = (): void => {
      if (active) restoreDraggable(active.suspended)
      active = null
    }

    const clearSuppression = (): void => {
      suppressClick = false
      if (suppressTimer !== undefined) {
        clearTimeout(suppressTimer)
        suppressTimer = undefined
      }
    }

    const releaseForwardedGesture = (gesture: ActiveGesture): void => {
      if (gesture.phase !== 'forwarded') return
      if (gesture.seam.kind === 'mouse-sash') dispatchSyntheticMouseUp(view)
      else dispatchSyntheticPointerUp(gesture)
    }

    // A press directly on a sash is owned by Allotment / the shared Sash. We
    // only track it so a blur or pointercancel can end the native gesture:
    // Allotment removes its window listeners solely from pointerup, and the
    // Sash removes them from mouseup — neither fires on blur / cancel.
    const releaseNativeSash = (): void => {
      const gesture = nativeSash
      if (!gesture) return
      nativeSash = null
      if (gesture.seam.kind === 'mouse-sash') dispatchSyntheticMouseUp(view)
      else dispatchSyntheticPointerUp(gesture)
    }

    const finishActive = (suppress: boolean): void => {
      if (suppress && active?.phase === 'forwarded') {
        // The click (if any) follows pointerup immediately; swallow it so the
        // row/tab onClick doesn't open or select the content under the seam.
        suppressClick = true
        if (suppressTimer !== undefined) clearTimeout(suppressTimer)
        suppressTimer = setTimeout(() => {
          suppressClick = false
          suppressTimer = undefined
        }, 0)
      } else {
        clearSuppression()
      }
      restore()
    }

    const forward = (gesture: ActiveGesture): void => {
      if (gesture.phase === 'forwarded') return
      gesture.phase = 'forwarded'
      suppressClick = true
      if (gesture.seam.kind === 'allotment') dispatchSyntheticPointerDown(gesture)
      else dispatchSyntheticMouseDown(gesture)
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (SYNTHETIC_EVENTS.has(e)) return
      if (e.button !== 0 || !e.isPrimary) return
      // A new primary press supersedes any half-finished gesture.
      clearSuppression()
      if (active) releaseForwardedGesture(active)
      restore()
      releaseNativeSash()
      const target = asElement(e.target)
      if (!target) {
        lastPress = null
        return
      }
      const sash = closestSash(target)
      if (sash) {
        nativeSash = {
          pointerId: e.pointerId,
          pointerType: e.pointerType || 'mouse',
          startX: e.clientX,
          startY: e.clientY,
          startScreenX: e.screenX,
          startScreenY: e.screenY,
          seam: seamHitForElement(sash),
        }
        lastPress = null
        return
      }
      // Record the press even when it is not near a seam: a dragstart that
      // begins on a nested action control must never drag the row.
      const source = findNativeDragSourceAtPoint(target)
      lastPress = source ? { target, source } : null
      if (!source) return
      const seam = findResizeSeamAtPoint(ownerDocument, e.clientX, e.clientY, bandRef.current)
      if (!seam) return
      active = {
        phase: 'pending',
        pointerId: e.pointerId,
        pointerType: e.pointerType || 'mouse',
        startX: e.clientX,
        startY: e.clientY,
        startScreenX: e.screenX,
        startScreenY: e.screenY,
        seam,
        suspended: suspendDraggable(source),
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (SYNTHETIC_EVENTS.has(e)) return
      if (!active || e.pointerId !== active.pointerId) return
      if (e.buttons === 0) {
        // The release happened where we could not observe it; never keep a
        // forwarded gesture alive from a button-less move.
        if (active.phase === 'forwarded') releaseForwardedGesture(active)
        finishActive(false)
        return
      }
      if (active.phase !== 'pending') return
      const dx = e.clientX - active.startX
      const dy = e.clientY - active.startY
      const along = active.seam.orientation === 'vertical' ? Math.abs(dx) : Math.abs(dy)
      if (along < RESIZE_START_THRESHOLD_PX) return
      // Allotment listens to pointermove on window. Our shared Sash listens to
      // mousemove, so leave the real move uncancelled: the browser's
      // compatibility mousemove is what drives it.
      if (active.seam.kind === 'allotment') e.preventDefault()
      forward(active)
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (SYNTHETIC_EVENTS.has(e)) return
      if (nativeSash && e.pointerId === nativeSash.pointerId) nativeSash = null
      lastPress = null
      if (!active || e.pointerId !== active.pointerId) return
      finishActive(true)
    }

    const onPointerCancel = (e: PointerEvent): void => {
      if (SYNTHETIC_EVENTS.has(e)) return
      if (nativeSash && e.pointerId === nativeSash.pointerId) releaseNativeSash()
      lastPress = null
      if (!active || e.pointerId !== active.pointerId) return
      releaseForwardedGesture(active)
      finishActive(false)
    }

    // Chromium decides the native drag source while processing pointer moves,
    // hit-testing whatever element currently sits under the cursor. Once the
    // sash moves with the pane boundary the pointer can be over a draggable row
    // even though the press landed on the sash itself. Cancelling the mousedown
    // default for the whole gesture keeps the browser from arming a content
    // drag, without disturbing the sash's pointer listeners (Allotment reads
    // pointer events; the shared Sash reads the compatibility mouse events,
    // whose dispatch preventDefault does not stop).
    const onMouseDown = (e: MouseEvent): void => {
      if (SYNTHETIC_EVENTS.has(e)) return
      // Only the primary button owns the gesture; a right-click during a
      // resize must keep its context menu.
      if (e.button !== 0) return
      if (nativeSash || active) e.preventDefault()
    }

    const onDragStart = (e: DragEvent): void => {
      if (SYNTHETIC_EVENTS.has(e)) return
      if (active) {
        // Backstop: the pointerdown arbitration and the temporary
        // `draggable=false` should have stopped native DnD, but a gesture that
        // started on a seam must never turn into a content drag.
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const pressed = lastPress
      lastPress = null
      if (pressed && isNestedActionControl(pressed.target, pressed.source)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const onDragEnd = (): void => {
      lastPress = null
      finishActive(false)
    }

    const onClick = (e: MouseEvent): void => {
      if (!suppressClick) return
      const target = asElement(e.target)
      if (target && closestSash(target)) {
        // Leave sash clicks alone (Allotment uses double-click to reset).
        suppressClick = false
        return
      }
      suppressClick = false
      e.preventDefault()
      e.stopPropagation()
    }

    const onWindowBlur = (): void => {
      if (nativeSash) releaseNativeSash()
      if (active) releaseForwardedGesture(active)
      lastPress = null
      finishActive(false)
    }

    ownerDocument.addEventListener('pointerdown', onPointerDown, true)
    ownerDocument.addEventListener('mousedown', onMouseDown, true)
    ownerDocument.addEventListener('pointermove', onPointerMove, true)
    ownerDocument.addEventListener('pointerup', onPointerUp, true)
    ownerDocument.addEventListener('pointercancel', onPointerCancel, true)
    ownerDocument.addEventListener('dragstart', onDragStart, true)
    ownerDocument.addEventListener('dragend', onDragEnd, true)
    ownerDocument.addEventListener('click', onClick, true)
    view?.addEventListener('blur', onWindowBlur)

    return () => {
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true)
      ownerDocument.removeEventListener('mousedown', onMouseDown, true)
      ownerDocument.removeEventListener('pointermove', onPointerMove, true)
      ownerDocument.removeEventListener('pointerup', onPointerUp, true)
      ownerDocument.removeEventListener('pointercancel', onPointerCancel, true)
      ownerDocument.removeEventListener('dragstart', onDragStart, true)
      ownerDocument.removeEventListener('dragend', onDragEnd, true)
      ownerDocument.removeEventListener('click', onClick, true)
      view?.removeEventListener('blur', onWindowBlur)
      releaseNativeSash()
      if (active) releaseForwardedGesture(active)
      lastPress = null
      restore()
      clearSuppression()
    }
  }, [ownerDocument])

  return null
}
