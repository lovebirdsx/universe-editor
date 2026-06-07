/*---------------------------------------------------------------------------------------------
 *  Tests for the Sash resize handle.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { Sash } from '../layout/Sash.js'

describe('Sash', () => {
  it('emits delta on mousemove during drag (vertical)', () => {
    const onResize = vi.fn()
    const { container } = render(<Sash orientation="vertical" onResize={onResize} />)
    const handle = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 150, clientY: 0 })
    expect(onResize).toHaveBeenCalledWith(50)
    fireEvent.mouseMove(window, { clientX: 140, clientY: 0 })
    expect(onResize).toHaveBeenLastCalledWith(-10)
    fireEvent.mouseUp(window)
  })

  it('emits delta on mousemove during drag (horizontal)', () => {
    const onResize = vi.fn()
    const { container } = render(<Sash orientation="horizontal" onResize={onResize} />)
    const handle = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 50 })
    fireEvent.mouseMove(window, { clientX: 0, clientY: 80 })
    expect(onResize).toHaveBeenCalledWith(30)
    fireEvent.mouseUp(window)
  })

  it('does not emit before mousedown', () => {
    const onResize = vi.fn()
    render(<Sash orientation="vertical" onResize={onResize} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 0 })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('fires onStart on mousedown and onEnd on mouseup', () => {
    const onStart = vi.fn()
    const onEnd = vi.fn()
    const { container } = render(
      <Sash orientation="vertical" onResize={vi.fn()} onStart={onStart} onEnd={onEnd} />,
    )
    const handle = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 0 })
    expect(onStart).toHaveBeenCalledOnce()
    fireEvent.mouseUp(window)
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('cleans up global listeners on unmount mid-drag', () => {
    const onResize = vi.fn()
    const { container, unmount } = render(<Sash orientation="vertical" onResize={onResize} />)
    const handle = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 0 })
    unmount()
    fireEvent.mouseMove(window, { clientX: 100 })
    expect(onResize).not.toHaveBeenCalled()
    // body cursor should be restored
    expect(document.body.style.cursor).toBe('')
  })

  it('stops emitting after mouseup', () => {
    const onResize = vi.fn()
    const { container } = render(<Sash orientation="vertical" onResize={onResize} />)
    const handle = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseUp(window)
    onResize.mockClear()
    fireEvent.mouseMove(window, { clientX: 200 })
    expect(onResize).not.toHaveBeenCalled()
  })
})
