/*---------------------------------------------------------------------------------------------
 *  Tests for the resize-seam gesture arbitration guard.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  RESIZE_SEAM_BAND_PX,
  ResizeSeamDragGuard,
  findNativeDragSourceAtPoint,
  findResizeSeamAtPoint,
} from '../dnd/resizeSeamGuard.js'
import { Sash } from '../layout/Sash.js'

function box(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }),
  }
}

function makeAllotmentSash(rect: DOMRect, opts: { disabled?: boolean } = {}): HTMLElement {
  const el = document.createElement('div')
  el.dataset['testid'] = 'sash'
  el.classList.add(rect.width < rect.height ? 'sash-vertical' : 'sash-horizontal')
  if (opts.disabled) el.classList.add('sash-disabled')
  el.getBoundingClientRect = () => rect
  document.body.append(el)
  return el
}

function makeMouseSash(rect: DOMRect): HTMLElement {
  const el = document.createElement('div')
  el.dataset['resizeSash'] = 'true'
  el.setAttribute('aria-orientation', rect.width < rect.height ? 'vertical' : 'horizontal')
  el.getBoundingClientRect = () => rect
  document.body.append(el)
  return el
}

function makeDraggable(interactive: boolean): { row: HTMLElement; target: HTMLElement } {
  const row = document.createElement('div')
  row.setAttribute('draggable', 'true')
  const target = document.createElement(interactive ? 'button' : 'span')
  row.append(target)
  document.body.append(row)
  return { row, target }
}

function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  buttons?: number,
): boolean {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
  })
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true })
  Object.defineProperty(ev, 'pointerType', { value: 'mouse', configurable: true })
  Object.defineProperty(ev, 'isPrimary', { value: true, configurable: true })
  Object.defineProperty(ev, 'screenX', { value: x, configurable: true })
  Object.defineProperty(ev, 'screenY', { value: y, configurable: true })
  return target.dispatchEvent(ev)
}

function dispatchMouse(target: EventTarget, type: string, x = 0, y = 0): boolean {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  })
  return target.dispatchEvent(ev)
}

function firstCallArg(mock: { mock: { calls: unknown[][] } }): Event | undefined {
  return mock.mock.calls[0]?.[0] as Event | undefined
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('findResizeSeamAtPoint', () => {
  it('finds a vertical Allotment sash by its centre within the band', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    expect(findResizeSeamAtPoint(document, 207, 100)?.el).toBe(sash)
    expect(findResizeSeamAtPoint(document, 200 - RESIZE_SEAM_BAND_PX, 100)?.el).toBe(sash)
    expect(findResizeSeamAtPoint(document, 200 - RESIZE_SEAM_BAND_PX - 1, 100)).toBeNull()
  })

  it('finds a horizontal Allotment sash', () => {
    const sash = makeAllotmentSash(box(0, 196, 800, 8))
    const hit = findResizeSeamAtPoint(document, 100, 207)
    expect(hit?.el).toBe(sash)
    expect(hit?.orientation).toBe('horizontal')
  })

  it('rejects points outside the sash along-axis extent', () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    expect(findResizeSeamAtPoint(document, 200, 900)).toBeNull()
  })

  it('skips disabled, zero-sized and hidden sashes', () => {
    makeAllotmentSash(box(196, 0, 8, 800), { disabled: true })
    expect(findResizeSeamAtPoint(document, 200, 100)).toBeNull()

    document.body.innerHTML = ''
    makeAllotmentSash(box(196, 0, 0, 800))
    expect(findResizeSeamAtPoint(document, 196, 100)).toBeNull()

    document.body.innerHTML = ''
    const hidden = makeAllotmentSash(box(196, 0, 8, 800))
    hidden.style.visibility = 'hidden'
    expect(findResizeSeamAtPoint(document, 200, 100)).toBeNull()

    hidden.style.visibility = ''
    hidden.style.pointerEvents = 'none'
    expect(findResizeSeamAtPoint(document, 200, 100)).toBeNull()
  })

  it('picks the nearest of several candidate sashes', () => {
    const farther = makeAllotmentSash(box(196, 0, 8, 800))
    const nearer = makeAllotmentSash(box(201, 0, 8, 800))
    expect(findResizeSeamAtPoint(document, 203, 100)?.el).toBe(nearer)
    expect(findResizeSeamAtPoint(document, 199, 100)?.el).toBe(farther)
  })

  it('recognises the shared Sash kind', () => {
    const sash = makeMouseSash(box(196, 0, 4, 800))
    const hit = findResizeSeamAtPoint(document, 204, 100)
    expect(hit?.el).toBe(sash)
    expect(hit?.kind).toBe('mouse-sash')
    expect(hit?.orientation).toBe('vertical')
  })
})

describe('drag source helpers', () => {
  it('walks up to the nearest explicit draggable', () => {
    const row = document.createElement('div')
    row.setAttribute('draggable', 'true')
    const child = document.createElement('span')
    row.append(child)
    document.body.append(row)
    expect(findNativeDragSourceAtPoint(child)).toBe(row)
    expect(findNativeDragSourceAtPoint(document.body)).toBeNull()
  })

  it('treats images and href links as native drag sources unless opted out', () => {
    const img = document.createElement('img')
    img.draggable = true
    document.body.append(img)
    expect(findNativeDragSourceAtPoint(img)).toBe(img)
    img.draggable = false
    expect(findNativeDragSourceAtPoint(img)).toBeNull()

    const link = document.createElement('a')
    link.href = '#'
    link.draggable = true
    document.body.append(link)
    expect(findNativeDragSourceAtPoint(link)).toBe(link)
    link.draggable = false
    expect(findNativeDragSourceAtPoint(link)).toBeNull()
  })
})

describe('ResizeSeamDragGuard', () => {
  it('defers a press on a draggable background until the pointer moves along the seam', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const { row, target } = makeDraggable(false)
    const onRowDown = vi.fn()
    target.parentElement?.addEventListener('pointerdown', onRowDown)
    render(<ResizeSeamDragGuard />)

    // The press itself is not stolen: click semantics and the row's own
    // handlers survive until the pointer commits to the seam.
    expect(dispatchPointer(target, 'pointerdown', 207, 100)).toBe(true)
    expect(onRowDown).toHaveBeenCalledOnce()
    expect(onSashDown).not.toHaveBeenCalled()
    expect(row.getAttribute('draggable')).toBe('false')

    expect(dispatchPointer(target, 'pointermove', 209, 100)).toBe(true)
    expect(onSashDown).not.toHaveBeenCalled()

    // 5px along the axis commits to the seam and cancels the Allotment move.
    expect(dispatchPointer(target, 'pointermove', 212, 100)).toBe(false)
    expect(onSashDown).toHaveBeenCalledOnce()
    const synthetic = firstCallArg(onSashDown) as PointerEvent
    expect(synthetic.type).toBe('pointerdown')
    expect(synthetic.clientX).toBe(207)
    expect(synthetic.clientY).toBe(100)
    expect(synthetic.pageX).toBe(207)
    expect(synthetic.pointerId).toBe(1)

    dispatchPointer(target, 'pointerup', 212, 100)
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it('leaves presses away from the seam alone', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const { row, target } = makeDraggable(false)
    const onRowDown = vi.fn()
    target.parentElement?.addEventListener('pointerdown', onRowDown)
    render(<ResizeSeamDragGuard />)

    expect(dispatchPointer(target, 'pointerdown', 250, 100)).toBe(true)
    expect(onSashDown).not.toHaveBeenCalled()
    expect(onRowDown).toHaveBeenCalledOnce()
    expect(row.getAttribute('draggable')).toBe('true')
    dispatchPointer(target, 'pointerup', 250, 100)
  })

  it('ignores presses without a drag source or on a disabled sash', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800), { disabled: true })
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const plain = document.createElement('div')
    document.body.append(plain)
    render(<ResizeSeamDragGuard />)

    expect(dispatchPointer(plain, 'pointerdown', 207, 100)).toBe(true)

    sash.classList.remove('sash-disabled')
    expect(dispatchPointer(plain, 'pointerdown', 207, 100)).toBe(true)
    expect(onSashDown).not.toHaveBeenCalled()
  })

  it('defers an interactive press until the pointer moves along the seam axis', async () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const { row, target } = makeDraggable(true)
    const onButtonDown = vi.fn()
    target.addEventListener('pointerdown', onButtonDown)
    render(<ResizeSeamDragGuard />)

    expect(dispatchPointer(target, 'pointerdown', 207, 100)).toBe(true)
    expect(onButtonDown).toHaveBeenCalledOnce()
    expect(onSashDown).not.toHaveBeenCalled()
    expect(row.getAttribute('draggable')).toBe('false')

    expect(dispatchPointer(target, 'pointermove', 209, 100)).toBe(true)
    expect(onSashDown).not.toHaveBeenCalled()

    expect(dispatchPointer(target, 'pointermove', 212, 100)).toBe(false)
    expect(onSashDown).toHaveBeenCalledOnce()

    dispatchPointer(target, 'pointerup', 212, 100)
    expect(row.getAttribute('draggable')).toBe('true')

    // The click that follows the drag must not reach the row/button.
    expect(dispatchMouse(target, 'click', 212, 100)).toBe(false)

    // Suppression is cleared by its zero-delay timer, not permanently.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(dispatchMouse(target, 'click', 212, 100)).toBe(true)
  })

  it('releases a forwarded gesture when its pointerup was lost', () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    const onPointerUp = vi.fn()
    window.addEventListener('pointerup', onPointerUp)
    const { row, target } = makeDraggable(false)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    dispatchPointer(target, 'pointermove', 212, 100)
    expect(row.getAttribute('draggable')).toBe('false')

    // The release happened outside the observed document; a button-less move
    // must still end the forwarded gesture instead of resizing forever.
    dispatchPointer(target, 'pointermove', 220, 100, 0)
    expect(onPointerUp).toHaveBeenCalledOnce()
    expect(row.getAttribute('draggable')).toBe('true')

    window.removeEventListener('pointerup', onPointerUp)
  })

  it('ends a forwarded gesture when a new primary press supersedes it', () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    const onPointerUp = vi.fn()
    window.addEventListener('pointerup', onPointerUp)
    const { row, target } = makeDraggable(false)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    dispatchPointer(target, 'pointermove', 212, 100)
    expect(row.getAttribute('draggable')).toBe('false')

    dispatchPointer(document.body, 'pointerdown', 400, 100)
    expect(onPointerUp).toHaveBeenCalledOnce()
    expect(row.getAttribute('draggable')).toBe('true')

    window.removeEventListener('pointerup', onPointerUp)
  })

  it('does not swallow a plain click that never crossed the threshold', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const { row, target } = makeDraggable(true)
    const onClick = vi.fn()
    target.addEventListener('click', onClick)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    dispatchPointer(target, 'pointerup', 207, 100)
    expect(row.getAttribute('draggable')).toBe('true')
    expect(dispatchMouse(target, 'click', 207, 100)).toBe(true)
    expect(onClick).toHaveBeenCalledOnce()
    expect(onSashDown).not.toHaveBeenCalled()
  })

  it('cancels a dragstart during a seam gesture without re-forwarding', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const { row, target } = makeDraggable(false)
    render(<ResizeSeamDragGuard />)

    // No guard gesture in flight: synthetic dragstart-based e2e must pass through.
    expect(dispatchMouse(target, 'dragstart')).toBe(true)

    dispatchPointer(target, 'pointerdown', 207, 100)
    expect(dispatchMouse(target, 'dragstart')).toBe(false)
    expect(onSashDown).not.toHaveBeenCalled()
    expect(row.getAttribute('draggable')).toBe('false')

    // The gesture still belongs to the seam; the next along-axis move hands it over.
    expect(dispatchPointer(target, 'pointermove', 212, 100)).toBe(false)
    expect(onSashDown).toHaveBeenCalledOnce()

    dispatchPointer(target, 'pointerup', 212, 100)
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it('cancels a drag that started on a nested action control', () => {
    const { target } = makeDraggable(true)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 300, 100)
    expect(dispatchMouse(target, 'dragstart')).toBe(false)

    const plain = makeDraggable(false)
    dispatchPointer(plain.target, 'pointerdown', 300, 100)
    expect(dispatchMouse(plain.target, 'dragstart')).toBe(true)
  })

  it('allows a drag when the draggable element is itself the control', () => {
    const button = document.createElement('button')
    button.setAttribute('draggable', 'true')
    document.body.append(button)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(button, 'pointerdown', 300, 100)
    expect(dispatchMouse(button, 'dragstart')).toBe(true)
  })

  it('cancels a row drag that started on an image inside a nested control', () => {
    const row = document.createElement('div')
    row.setAttribute('draggable', 'true')
    const button = document.createElement('button')
    const img = document.createElement('img')
    img.draggable = true
    button.append(img)
    row.append(button)
    document.body.append(row)
    render(<ResizeSeamDragGuard />)

    // The browser would pick the img itself as the drag source, so the check
    // must compare the control against the nearest draggable ancestor.
    dispatchPointer(img, 'pointerdown', 300, 100)
    expect(dispatchMouse(img, 'dragstart')).toBe(false)
  })

  it('restores the draggable attribute on pointercancel and on unmount', () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    const { row, target } = makeDraggable(true)
    const view = render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    expect(row.getAttribute('draggable')).toBe('false')
    dispatchPointer(document, 'pointercancel', 207, 100)
    expect(row.getAttribute('draggable')).toBe('true')

    dispatchPointer(target, 'pointerdown', 207, 100)
    expect(row.getAttribute('draggable')).toBe('false')
    view.unmount()
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it('keeps the drag source suspended when a re-render restores draggable', async () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    const { row, target } = makeDraggable(true)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    expect(row.getAttribute('draggable')).toBe('false')

    // React re-renders the row during the resize and writes `draggable` back.
    row.setAttribute('draggable', 'true')
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(row.getAttribute('draggable')).toBe('false')

    dispatchPointer(target, 'pointerup', 212, 100)
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it('releases a forwarded Allotment gesture on pointercancel and window blur', () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    const onPointerUp = vi.fn()
    window.addEventListener('pointerup', onPointerUp)
    const { row, target } = makeDraggable(false)
    const view = render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    dispatchPointer(target, 'pointermove', 212, 100)
    expect(row.getAttribute('draggable')).toBe('false')
    dispatchPointer(document, 'pointercancel', 212, 100)
    expect(onPointerUp).toHaveBeenCalledOnce()
    expect(row.getAttribute('draggable')).toBe('true')

    onPointerUp.mockClear()
    dispatchPointer(target, 'pointerdown', 207, 100)
    dispatchPointer(target, 'pointermove', 212, 100)
    window.dispatchEvent(new Event('blur'))
    expect(onPointerUp).toHaveBeenCalledOnce()
    expect(row.getAttribute('draggable')).toBe('true')

    window.removeEventListener('pointerup', onPointerUp)
    view.unmount()
  })

  it('ends a native Allotment sash gesture on pointercancel and window blur', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onPointerUp = vi.fn()
    window.addEventListener('pointerup', onPointerUp)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(sash, 'pointerdown', 200, 100)
    dispatchPointer(document, 'pointercancel', 200, 100)
    expect(onPointerUp).toHaveBeenCalledOnce()

    onPointerUp.mockClear()
    dispatchPointer(sash, 'pointerdown', 200, 100)
    window.dispatchEvent(new Event('blur'))
    expect(onPointerUp).toHaveBeenCalledOnce()

    window.removeEventListener('pointerup', onPointerUp)
  })

  it('cancels the mousedown default for the whole sash gesture', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const { target } = makeDraggable(false)
    render(<ResizeSeamDragGuard />)

    // A native sash drag can wander over a draggable row once the boundary
    // moves; the browser's default mousedown action is what arms native DnD.
    dispatchPointer(sash, 'pointerdown', 200, 100)
    expect(dispatchMouse(document.body, 'mousedown', 200, 100)).toBe(false)
    dispatchPointer(sash, 'pointerup', 200, 100)
    expect(dispatchMouse(document.body, 'mousedown', 200, 100)).toBe(true)

    dispatchPointer(target, 'pointerdown', 207, 100)
    expect(dispatchMouse(target, 'mousedown', 207, 100)).toBe(false)
    dispatchPointer(target, 'pointerup', 207, 100)
  })

  it('does not synthesize a second release for a normal native sash pointerup', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onPointerUp = vi.fn()
    window.addEventListener('pointerup', onPointerUp)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(sash, 'pointerdown', 200, 100)
    dispatchPointer(sash, 'pointerup', 200, 100)
    expect(onPointerUp).toHaveBeenCalledOnce()

    window.removeEventListener('pointerup', onPointerUp)
  })

  it('ends a native shared-Sash gesture on pointercancel', () => {
    const sash = makeMouseSash(box(196, 0, 4, 800))
    const onMouseUp = vi.fn()
    window.addEventListener('mouseup', onMouseUp)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(sash, 'pointerdown', 198, 100)
    dispatchPointer(document, 'pointercancel', 198, 100)
    expect(onMouseUp).toHaveBeenCalledOnce()

    window.removeEventListener('mouseup', onMouseUp)
  })

  it('does not leak click suppression after a cancelled gesture', () => {
    makeAllotmentSash(box(196, 0, 8, 800))
    const { target } = makeDraggable(false)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    dispatchPointer(target, 'pointermove', 212, 100)
    dispatchPointer(document, 'pointercancel', 212, 100)

    expect(dispatchMouse(target, 'click', 212, 100)).toBe(true)
  })

  it('abandons a pending gesture on a button-less move', () => {
    const sash = makeAllotmentSash(box(196, 0, 8, 800))
    const onSashDown = vi.fn()
    sash.addEventListener('pointerdown', onSashDown)
    const { row, target } = makeDraggable(false)
    render(<ResizeSeamDragGuard />)

    dispatchPointer(target, 'pointerdown', 207, 100)
    expect(row.getAttribute('draggable')).toBe('false')
    expect(dispatchPointer(target, 'pointermove', 212, 100, 0)).toBe(true)
    expect(onSashDown).not.toHaveBeenCalled()
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it('forwards to the shared Sash and drives its window mouse listeners', () => {
    const onResize = vi.fn()
    const onStart = vi.fn()
    const { container } = render(
      <>
        <ResizeSeamDragGuard />
        <Sash orientation="vertical" onResize={onResize} onStart={onStart} />
      </>,
    )
    const sash = container.querySelector<HTMLElement>('[data-resize-sash="true"]')
    expect(sash).not.toBeNull()
    sash!.getBoundingClientRect = () => box(196, 0, 4, 800)
    const onMouseDown = vi.fn()
    sash!.addEventListener('mousedown', onMouseDown)
    expect(findResizeSeamAtPoint(document, 204, 100)?.el).toBe(sash)
    const { target } = makeDraggable(false)

    expect(dispatchPointer(target, 'pointerdown', 204, 100)).toBe(true)
    expect(onMouseDown).not.toHaveBeenCalled()
    expect(document.body.style.cursor).toBe('')

    // A mouse-sash must leave the real move uncancelled: its Sash reads the
    // browser's compatibility mousemove, which a cancelled pointermove suppresses.
    let moveNotPrevented = true
    act(() => {
      moveNotPrevented = dispatchPointer(target, 'pointermove', 214, 100)
    })
    expect(moveNotPrevented).toBe(true)
    expect(onMouseDown).toHaveBeenCalledOnce()
    expect(onStart).toHaveBeenCalledOnce()
    expect(document.body.style.cursor).toBe('ew-resize')

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 214, clientY: 100, bubbles: true }))
    expect(onResize).toHaveBeenCalledWith(10)
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 214, clientY: 100, bubbles: true }))

    dispatchPointer(target, 'pointerup', 214, 100)
  })
})
