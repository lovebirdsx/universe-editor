import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '../tooltip/TooltipProvider.js'

function Fixture({ delay = 500 }: { delay?: number }) {
  return (
    <TooltipProvider delay={delay}>
      <div data-tooltip="outer tip" data-testid="outer">
        <button type="button" data-tooltip="inner tip" data-testid="inner">
          inner
        </button>
      </div>
      <button type="button" data-tooltip="second tip" data-testid="second">
        second
      </button>
      <div data-tooltip="" data-testid="empty">
        empty
      </div>
      <div data-testid="plain">plain</div>
    </TooltipProvider>
  )
}

describe('TooltipProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('shows the tooltip text after the delay', () => {
    vi.useFakeTimers()
    render(<Fixture delay={100} />)

    fireEvent.mouseOver(screen.getByTestId('outer'))
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('outer tip')
  })

  it('hides on mouseout', () => {
    vi.useFakeTimers()
    render(<Fixture delay={0} />)

    fireEvent.mouseOver(screen.getByTestId('outer'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toBeDefined()

    fireEvent.mouseOut(screen.getByTestId('outer'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('prefers the innermost data-tooltip host', () => {
    vi.useFakeTimers()
    render(<Fixture delay={0} />)

    fireEvent.mouseOver(screen.getByTestId('inner'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('inner tip')
  })

  it('switches to a new host instantly while visible', () => {
    vi.useFakeTimers()
    render(<Fixture delay={500} />)

    fireEvent.mouseOver(screen.getByTestId('outer'))
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('outer tip')

    fireEvent.mouseOut(screen.getByTestId('outer'))
    fireEvent.mouseOver(screen.getByTestId('second'))
    // No timer advance — visible tooltips chain without a fresh delay.
    expect(screen.getByRole('tooltip').textContent).toBe('second tip')
  })

  it('ignores empty data-tooltip and elements without one', () => {
    vi.useFakeTimers()
    render(<Fixture delay={0} />)

    fireEvent.mouseOver(screen.getByTestId('empty'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseOver(screen.getByTestId('plain'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('hides on Escape', () => {
    vi.useFakeTimers()
    render(<Fixture delay={0} />)

    fireEvent.mouseOver(screen.getByTestId('outer'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
