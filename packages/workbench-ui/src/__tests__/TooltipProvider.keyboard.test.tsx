import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '../tooltip/TooltipProvider.js'
import {
  hideKeyboardTooltip,
  refreshKeyboardTooltip,
  showKeyboardTooltipForRow,
} from '../tooltip/keyboardTooltip.js'

/**
 * Keyboard-triggered tooltips (Vim `K` on a list row): the provider's
 * imperative controller, content resolution, and the dismissal rules that keep
 * a hidden row from leaving a stale bubble behind.
 */
function Fixture() {
  return (
    <TooltipProvider delay={0}>
      <div data-testid="primary-row" aria-selected="true" data-row-key="primary">
        <span data-tooltip="badge tip">badge</span>
        <span data-tooltip-primary="" data-tooltip="full body" data-testid="primary-target">
          message
        </span>
      </div>
      <div data-testid="root-row" aria-selected="true" data-tooltip="row tip">
        <span data-tooltip="child tip">child</span>
      </div>
      <div data-testid="title-row" aria-selected="true">
        <span title="native title" data-testid="title-target">
          titled
        </span>
      </div>
      <div data-testid="plain-row" aria-selected="true">
        <span>plain</span>
      </div>
    </TooltipProvider>
  )
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('keyboard tooltip', () => {
  it('shows the primary host immediately, without waiting for a hover delay', () => {
    render(<Fixture />)

    act(() => {
      expect(showKeyboardTooltipForRow(screen.getByTestId('primary-row'))).toBe(true)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('full body')
  })

  it('prefers the row root when it carries the tooltip', () => {
    render(<Fixture />)

    act(() => {
      showKeyboardTooltipForRow(screen.getByTestId('root-row'))
    })
    expect(screen.getByRole('tooltip').textContent).toBe('row tip')
  })

  it('falls back to a native title and restores it on hide', () => {
    render(<Fixture />)
    const target = screen.getByTestId('title-target')

    act(() => {
      showKeyboardTooltipForRow(screen.getByTestId('title-row'))
    })
    expect(screen.getByRole('tooltip').textContent).toBe('native title')
    expect(target.getAttribute('title')).toBeNull()

    act(() => hideKeyboardTooltip(document))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(target.getAttribute('title')).toBe('native title')
  })

  it('is a no-op for a row without any tooltip', () => {
    render(<Fixture />)

    act(() => {
      expect(showKeyboardTooltipForRow(screen.getByTestId('plain-row'))).toBe(false)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not dismiss on pointer movement', () => {
    render(<Fixture />)

    act(() => {
      showKeyboardTooltipForRow(screen.getByTestId('root-row'))
    })
    fireEvent.mouseOut(document.body)
    expect(screen.getByRole('tooltip').textContent).toBe('row tip')
  })

  it('keeps the opening stroke and dismisses on the next one', async () => {
    render(<Fixture />)

    act(() => {
      showKeyboardTooltipForRow(screen.getByTestId('root-row'))
    })
    // The stroke that opened it may still reach the provider's own listener.
    fireEvent.keyDown(document, { key: 'j' })
    expect(screen.getByRole('tooltip')).toBeDefined()

    await Promise.resolve()
    fireEvent.keyDown(document, { key: 'j' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('refreshes the text after the host fills it lazily', () => {
    render(<Fixture />)
    const target = screen.getByTestId('primary-target')

    act(() => {
      showKeyboardTooltipForRow(screen.getByTestId('primary-row'))
    })
    act(() => {
      target.setAttribute('data-tooltip', 'subject\n\nfull body')
      refreshKeyboardTooltip(document)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('subject\n\nfull body')
  })

  it('closes when the row loses the selection', () => {
    vi.useFakeTimers()
    render(<Fixture />)
    const row = screen.getByTestId('root-row')

    act(() => {
      showKeyboardTooltipForRow(row)
    })
    row.setAttribute('aria-selected', 'false')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('closes when the host element is unmounted', () => {
    vi.useFakeTimers()
    function Host({ show }: { show: boolean }) {
      return show ? (
        <div data-testid="root-row" aria-selected="true" data-tooltip="row tip">
          row
        </div>
      ) : null
    }
    const { rerender } = render(
      <TooltipProvider delay={0}>
        <Host show />
      </TooltipProvider>,
    )

    act(() => {
      showKeyboardTooltipForRow(screen.getByTestId('root-row'))
    })
    rerender(
      <TooltipProvider delay={0}>
        <Host show={false} />
      </TooltipProvider>,
    )
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('leaves pointer-driven tooltips alone on unrelated strokes', () => {
    vi.useFakeTimers()
    render(
      <TooltipProvider delay={0}>
        <button type="button" data-tooltip="mouse tip" data-testid="mouse">
          mouse
        </button>
      </TooltipProvider>,
    )

    fireEvent.mouseOver(screen.getByTestId('mouse'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    fireEvent.keyDown(document, { key: 'j' })
    expect(screen.getByRole('tooltip').textContent).toBe('mouse tip')
  })
})
