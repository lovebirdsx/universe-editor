import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
