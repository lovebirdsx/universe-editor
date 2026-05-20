import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useHover } from '../hover/HoverService.js'

function HoverTest({ delay = 0 }: { delay?: number }) {
  const { hoverProps, HoverPopup } = useHover(delay)
  return (
    <>
      <div data-testid="trigger" {...hoverProps} style={{ width: 100, height: 40 }}>
        Hover me
      </div>
      <HoverPopup>
        <span data-testid="tooltip">tooltip content</span>
      </HoverPopup>
    </>
  )
}

describe('useHover', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('does not show popup before the delay elapses', () => {
    vi.useFakeTimers()
    render(<HoverTest delay={300} />)

    fireEvent.mouseEnter(screen.getByTestId('trigger'), { clientX: 0, clientY: 0 })

    // Advance only partially.
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(screen.queryByTestId('tooltip')).toBeNull()
  })

  it('shows popup after the delay elapses', () => {
    vi.useFakeTimers()
    render(<HoverTest delay={100} />)

    fireEvent.mouseEnter(screen.getByTestId('trigger'), { clientX: 5, clientY: 5 })

    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(screen.getByTestId('tooltip')).toBeDefined()
  })

  it('hides popup on mouse leave', () => {
    vi.useFakeTimers()
    render(<HoverTest delay={0} />)

    fireEvent.mouseEnter(screen.getByTestId('trigger'), { clientX: 0, clientY: 0 })
    act(() => {
      vi.advanceTimersByTime(10)
    })

    expect(screen.getByTestId('tooltip')).toBeDefined()

    fireEvent.mouseLeave(screen.getByTestId('trigger'))

    expect(screen.queryByTestId('tooltip')).toBeNull()
  })
})
