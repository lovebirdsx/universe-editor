import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ImagePreviewOverlay } from '../ImagePreviewOverlay.js'

function renderOverlay(onClose = vi.fn()): { readonly onClose: ReturnType<typeof vi.fn> } {
  render(<ImagePreviewOverlay src="blob:https://example.com/1" alt="shot" onClose={onClose} />)
  return { onClose }
}

describe('ImagePreviewOverlay', () => {
  it('renders an accessible modal, locks scrolling and closes on Escape', () => {
    const { onClose } = renderOverlay()
    const dialog = screen.getByTestId('image-preview')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.documentElement.classList.contains('is-scroll-locked')).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('image-preview-close'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a backdrop tap but not on an image tap', () => {
    const { onClose } = renderOverlay()
    const image = screen.getByTestId('image-preview-image')
    fireEvent.click(image)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(image.parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from the close button', () => {
    const { onClose } = renderOverlay()
    fireEvent.click(screen.getByTestId('image-preview-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('double-tap zooms to 2x and back to fit', () => {
    renderOverlay()
    const stage = screen.getByTestId('image-preview-image').parentElement as HTMLElement
    const image = screen.getByTestId('image-preview-image')

    for (let tap = 0; tap < 2; tap++) {
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 100 })
    }
    expect(image.style.transform).toContain('scale(2)')

    for (let tap = 0; tap < 2; tap++) {
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 100 })
    }
    expect(image.style.transform).toContain('scale(1)')
  })

  it('swipe down past the threshold dismisses, a short drag springs back', () => {
    const { onClose } = renderOverlay()
    const stage = screen.getByTestId('image-preview-image').parentElement as HTMLElement
    const image = screen.getByTestId('image-preview-image')

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 160 })
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 160 })
    expect(onClose).not.toHaveBeenCalled()
    expect(image.style.transform).toContain('translate3d(0px, 0px, 0)')

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 300 })
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 300 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
