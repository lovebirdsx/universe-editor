import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { DragSessionProvider } from '../dnd/DragSessionProvider.js'
import { useDragHandle } from '../dnd/useDragHandle.js'
import { useDropTarget } from '../dnd/useDropTarget.js'

function DragSource({ payload }: { payload: string }) {
  const { dragHandleProps } = useDragHandle(payload)
  return (
    <div data-testid="source" {...dragHandleProps}>
      drag me
    </div>
  )
}

function DropTarget({ onDrop }: { onDrop: (p: string | undefined) => void }) {
  const { dropTargetProps } = useDropTarget<string>((payload) => onDrop(payload))
  return (
    <div data-testid="target" {...dropTargetProps}>
      drop here
    </div>
  )
}

// happy-dom's synthetic drag events drop clientX; dispatch a native event with
// it defined. Returns false if the handler called preventDefault (drag cancelled).
function dispatchDragStart(el: HTMLElement, clientX: number): boolean {
  const ev = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clientX', { value: clientX })
  Object.defineProperty(ev, 'dataTransfer', {
    value: { setData: () => {}, getData: () => '', effectAllowed: 'none' },
  })
  return el.dispatchEvent(ev)
}

describe('DnD hooks', () => {
  afterEach(() => cleanup())
  it('dragstart stores payload in context', () => {
    const onDrop = vi.fn()
    render(
      <DragSessionProvider>
        <DragSource payload="hello" />
        <DropTarget onDrop={onDrop} />
      </DragSessionProvider>,
    )

    fireEvent.dragStart(screen.getByTestId('source'))
    fireEvent.dragOver(screen.getByTestId('target'))
    fireEvent.drop(screen.getByTestId('target'))

    expect(onDrop).toHaveBeenCalledWith('hello')
  })

  it('drop calls onDrop with correct payload', () => {
    const onDrop = vi.fn()
    render(
      <DragSessionProvider>
        <DragSource payload="world" />
        <DropTarget onDrop={onDrop} />
      </DragSessionProvider>,
    )

    fireEvent.dragStart(screen.getByTestId('source'))
    fireEvent.drop(screen.getByTestId('target'))

    expect(onDrop).toHaveBeenCalledWith('world')
  })

  it('dragend clears payload so a later drop reports no in-tree payload', () => {
    const onDrop = vi.fn()
    render(
      <DragSessionProvider>
        <DragSource payload="cleared" />
        <DropTarget onDrop={onDrop} />
      </DragSessionProvider>,
    )

    fireEvent.dragStart(screen.getByTestId('source'))
    fireEvent.dragEnd(screen.getByTestId('source'))

    // Drop without a preceding dragStart — the in-tree payload is cleared, so
    // the target receives `undefined` (and would fall back to the DataTransfer).
    fireEvent.drop(screen.getByTestId('target'))

    expect(onDrop).toHaveBeenCalledWith(undefined)
  })

  it('suppresses a drag that starts on the row edge (resize sash seam)', () => {
    const onDrop = vi.fn()
    render(
      <DragSessionProvider>
        <DragSource payload="edge" />
        <DropTarget onDrop={onDrop} />
      </DragSessionProvider>,
    )
    const source = screen.getByTestId('source')
    // happy-dom returns a zero rect by default; stub a real one so the guard has
    // measurable edges (left 0 → right 200).
    source.getBoundingClientRect = () => ({ left: 0, right: 200 }) as DOMRect

    // Press 2px from the right edge — a resize gesture, not a content drag.
    // fireEvent drops clientX from synthetic drag events, so dispatch natively.
    const cancelled = !dispatchDragStart(source, 198)
    expect(cancelled).toBe(true)
    fireEvent.drop(screen.getByTestId('target'))
    // No payload was stored, so the drop sees nothing from this drag.
    expect(onDrop).toHaveBeenCalledWith(undefined)
  })

  it('allows a drag from the row interior', () => {
    const onDrop = vi.fn()
    render(
      <DragSessionProvider>
        <DragSource payload="interior" />
        <DropTarget onDrop={onDrop} />
      </DragSessionProvider>,
    )
    const source = screen.getByTestId('source')
    source.getBoundingClientRect = () => ({ left: 0, right: 200 }) as DOMRect

    const cancelled = !dispatchDragStart(source, 100)
    expect(cancelled).toBe(false)
    fireEvent.drop(screen.getByTestId('target'))
    expect(onDrop).toHaveBeenCalledWith('interior')
  })

  // Regression: dragging a tab into a split unmounts the source tab (React moves
  // it to the new group's tab bar) BEFORE the browser can dispatch `dragend` to
  // it — so `onDragEnd`/`clearPayload` never runs and the payload lingers in the
  // provider. A subsequent unrelated drop (e.g. a file dragged from the Explorer)
  // then wrongly reads the stale in-tree payload instead of `undefined`, silently
  // no-op-ing the open. The provider must clear the payload on a window-level
  // drop/dragend so the stale value can't survive the gesture.
  it('clears a stale payload on a window drop even when the source never got dragend', () => {
    const onDrop = vi.fn()

    function UnmountableSource() {
      const [mounted, setMounted] = useState(true)
      return (
        <>
          {mounted && <DragSource payload="from-tab" />}
          <button data-testid="unmount" onClick={() => setMounted(false)}>
            unmount
          </button>
        </>
      )
    }

    render(
      <DragSessionProvider>
        <UnmountableSource />
        <DropTarget onDrop={onDrop} />
      </DragSessionProvider>,
    )

    // 1. Start dragging the tab → payload stored.
    fireEvent.dragStart(screen.getByTestId('source'))
    // 2. The drop that performs the split unmounts the source tab. The browser
    //    fires a window-level `drop` for the completed gesture.
    fireEvent.click(screen.getByTestId('unmount'))
    fireEvent.drop(window)
    // (The source is gone, so `dragEnd` can never reach it — do NOT fire it.)

    // 3. A brand-new, unrelated drop must see NO in-tree payload.
    fireEvent.drop(screen.getByTestId('target'))
    expect(onDrop).toHaveBeenLastCalledWith(undefined)
  })
})
