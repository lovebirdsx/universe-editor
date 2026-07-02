import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'

describe('AnchoredSurface', () => {
  afterEach(cleanup)

  it('renders children in a portal', () => {
    render(
      <AnchoredSurface x={10} y={20}>
        <div data-testid="content">hello</div>
      </AnchoredSurface>,
    )
    expect(screen.getByTestId('content')).toBeDefined()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(
      <AnchoredSurface x={0} y={0} onClose={onClose}>
        <div data-testid="content">esc me</div>
      </AnchoredSurface>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose on outside mousedown', () => {
    const onClose = vi.fn()
    render(
      <AnchoredSurface x={0} y={0} onClose={onClose}>
        <div data-testid="content">click outside</div>
      </AnchoredSurface>,
    )
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when clicking inside', () => {
    const onClose = vi.fn()
    render(
      <AnchoredSurface x={0} y={0} onClose={onClose}>
        <div data-testid="content">inside</div>
      </AnchoredSurface>,
    )
    fireEvent.mouseDown(screen.getByTestId('content'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('forwards surfaceProps onto the floating element', () => {
    render(
      <AnchoredSurface x={0} y={0} surfaceProps={{ role: 'menu', 'aria-label': 'surface' }}>
        <div>content</div>
      </AnchoredSurface>,
    )
    const surface = screen.getByRole('menu')
    expect(surface.getAttribute('aria-label')).toBe('surface')
  })
})
