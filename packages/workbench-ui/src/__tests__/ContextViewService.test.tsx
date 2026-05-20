import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ContextViewProvider, useContextViewService } from '../contextView/ContextViewService.js'

function TestConsumer({
  onReady,
}: {
  onReady: (svc: ReturnType<typeof useContextViewService>) => void
}) {
  const svc = useContextViewService()
  onReady(svc)
  return null
}

describe('ContextViewService', () => {
  it('show() renders content in a portal', () => {
    let svc!: ReturnType<typeof useContextViewService>
    render(
      <ContextViewProvider>
        <TestConsumer onReady={(s) => (svc = s)} />
      </ContextViewProvider>,
    )

    act(() => {
      svc.show({ x: 10, y: 20 }, () => <div data-testid="popup">hello</div>)
    })

    expect(screen.getByTestId('popup')).toBeDefined()
  })

  it('hide() removes the portal content', () => {
    let svc!: ReturnType<typeof useContextViewService>
    render(
      <ContextViewProvider>
        <TestConsumer onReady={(s) => (svc = s)} />
      </ContextViewProvider>,
    )

    act(() => {
      svc.show({ x: 0, y: 0 }, () => <div data-testid="popup2">bye</div>)
    })
    expect(screen.getByTestId('popup2')).toBeDefined()

    act(() => svc.hide())
    expect(screen.queryByTestId('popup2')).toBeNull()
  })

  it('calling show() again replaces the previous content', () => {
    let svc!: ReturnType<typeof useContextViewService>
    render(
      <ContextViewProvider>
        <TestConsumer onReady={(s) => (svc = s)} />
      </ContextViewProvider>,
    )

    act(() => {
      svc.show({ x: 0, y: 0 }, () => <div data-testid="first">first</div>)
    })
    act(() => {
      svc.show({ x: 0, y: 0 }, () => <div data-testid="second">second</div>)
    })

    expect(screen.queryByTestId('first')).toBeNull()
    expect(screen.getByTestId('second')).toBeDefined()
  })

  it('Escape key hides the popup', () => {
    let svc!: ReturnType<typeof useContextViewService>
    render(
      <ContextViewProvider>
        <TestConsumer onReady={(s) => (svc = s)} />
      </ContextViewProvider>,
    )

    act(() => {
      svc.show({ x: 0, y: 0 }, () => <div data-testid="esc-popup">esc me</div>)
    })
    expect(screen.getByTestId('esc-popup')).toBeDefined()

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByTestId('esc-popup')).toBeNull()
  })

  it('mousedown outside hides the popup', () => {
    let svc!: ReturnType<typeof useContextViewService>
    render(
      <ContextViewProvider>
        <TestConsumer onReady={(s) => (svc = s)} />
      </ContextViewProvider>,
    )

    act(() => {
      svc.show({ x: 0, y: 0 }, () => <div data-testid="outside-popup">click outside</div>)
    })
    expect(screen.getByTestId('outside-popup')).toBeDefined()

    act(() => {
      fireEvent.mouseDown(document.body)
    })

    expect(screen.queryByTestId('outside-popup')).toBeNull()
  })
})
