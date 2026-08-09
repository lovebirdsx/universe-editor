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
      <a href="command:example.run" title="command:example.run" data-testid="native">
        link
      </a>
      <div data-tooltip="both tip" data-testid="both" title="both title">
        both
      </div>
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

  it('re-reads the attribute at fire time so async-filled text wins', () => {
    vi.useFakeTimers()
    render(<Fixture delay={100} />)
    const el = screen.getByTestId('outer')

    fireEvent.mouseOver(el)
    // The host fills in fresh text during the delay (e.g. a lazy fetch).
    el.setAttribute('data-tooltip', 'updated tip')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('updated tip')
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

  it('replaces a native title with the themed tooltip and restores it on hide', () => {
    vi.useFakeTimers()
    render(<Fixture delay={0} />)
    const link = screen.getByTestId('native')

    fireEvent.mouseOver(link)
    // The native attribute is stashed immediately so the OS bubble never shows.
    expect(link.getAttribute('title')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('command:example.run')

    fireEvent.mouseOut(link)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(link.getAttribute('title')).toBe('command:example.run')
  })

  it('claims a native title on the same element when data-tooltip wins the text', () => {
    vi.useFakeTimers()
    render(<Fixture delay={0} />)
    const el = screen.getByTestId('both')

    fireEvent.mouseOver(el)
    expect(el.getAttribute('title')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('both tip')

    fireEvent.mouseOut(el)
    expect(el.getAttribute('title')).toBe('both title')
  })

  it('restores the previous native title when chaining into a nested host', () => {
    vi.useFakeTimers()
    render(
      <TooltipProvider delay={0}>
        <div title="parent title" data-testid="parent">
          <button type="button" title="child title" data-testid="child">
            child
          </button>
        </div>
      </TooltipProvider>,
    )
    const parent = screen.getByTestId('parent')
    const child = screen.getByTestId('child')

    fireEvent.mouseOver(parent)
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('parent title')

    // Moving into the child fires no mouseout that would restore the parent.
    fireEvent.mouseOver(child)
    expect(parent.getAttribute('title')).toBe('parent title')
    expect(child.getAttribute('title')).toBeNull()
    expect(screen.getByRole('tooltip').textContent).toBe('child title')

    fireEvent.mouseOut(child)
    expect(child.getAttribute('title')).toBe('child title')
  })

  it('appends the resolved keybinding for data-tooltip-command hosts', () => {
    vi.useFakeTimers()
    render(
      <TooltipProvider
        delay={0}
        resolveShortcut={(id) => (id === 'view.explorer' ? 'Ctrl+Shift+E' : undefined)}
      >
        <button
          type="button"
          data-tooltip="Explorer"
          data-tooltip-command="view.explorer"
          data-testid="bound"
        >
          explorer
        </button>
        <button
          type="button"
          data-tooltip="Unbound"
          data-tooltip-command="view.unbound"
          data-testid="unbound"
        >
          unbound
        </button>
      </TooltipProvider>,
    )

    fireEvent.mouseOver(screen.getByTestId('bound'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('Explorer (Ctrl+Shift+E)')

    // An unbound command degrades to the plain label.
    fireEvent.mouseOut(screen.getByTestId('bound'))
    fireEvent.mouseOver(screen.getByTestId('unbound'))
    expect(screen.getByRole('tooltip').textContent).toBe('Unbound')
  })

  it('leaves the text alone without a resolveShortcut prop', () => {
    vi.useFakeTimers()
    render(
      <TooltipProvider delay={0}>
        <button
          type="button"
          data-tooltip="Explorer"
          data-tooltip-command="view.explorer"
          data-testid="bound"
        >
          explorer
        </button>
      </TooltipProvider>,
    )

    fireEvent.mouseOver(screen.getByTestId('bound'))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('Explorer')
  })

  it('resolves the keybinding at hover time so rebinding is reflected', () => {
    vi.useFakeTimers()
    let key = 'Ctrl+Shift+E'
    render(
      <TooltipProvider delay={0} resolveShortcut={() => key}>
        <button
          type="button"
          data-tooltip="Explorer"
          data-tooltip-command="view.explorer"
          data-testid="bound"
        >
          explorer
        </button>
      </TooltipProvider>,
    )
    const el = screen.getByTestId('bound')

    fireEvent.mouseOver(el)
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('Explorer (Ctrl+Shift+E)')

    key = 'Ctrl+K E'
    fireEvent.mouseOut(el)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.mouseOver(el)
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('Explorer (Ctrl+K E)')
  })
})
