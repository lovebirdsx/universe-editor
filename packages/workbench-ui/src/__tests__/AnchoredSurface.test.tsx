import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'
import { OwnerDocumentProvider } from '../overlay/ownerDocumentContext.js'

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

  it('portals into the provider document and takes Escape from its window', () => {
    const win = new Window()
    const aux = win.document as unknown as Document
    const onClose = vi.fn()
    render(
      <OwnerDocumentProvider targetDocument={aux}>
        <AnchoredSurface x={0} y={0} onClose={onClose}>
          <div data-testid="aux-content">aux</div>
        </AnchoredSurface>
      </OwnerDocumentProvider>,
    )

    expect(aux.body.querySelector('[data-testid="aux-content"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="aux-content"]')).toBeNull()

    fireEvent.keyDown(win as unknown as globalThis.Window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // The main window's Escape belongs to whatever is open there.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
