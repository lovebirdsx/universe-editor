import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FocusScopeOverlay } from '../overlay/FocusScopeOverlay.js'
import { Select } from '../atoms/Select.js'

describe('FocusScopeOverlay', () => {
  afterEach(() => {
    cleanup()
    document.body.querySelectorAll('[data-floating-ui-portal]').forEach((n) => n.remove())
  })

  it('closes on Escape from inside the overlay', () => {
    const onEscape = vi.fn()
    render(
      <FocusScopeOverlay visible onEscape={onEscape}>
        <button data-testid="inside">inside</button>
      </FocusScopeOverlay>,
    )
    fireEvent.keyDown(screen.getByTestId('inside'), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape aimed at a floating-ui popup rendered in a body-level portal', () => {
    const onEscape = vi.fn()
    render(
      <FocusScopeOverlay visible onEscape={onEscape}>
        <button data-testid="inside">inside</button>
      </FocusScopeOverlay>,
    )

    const portal = document.createElement('div')
    portal.setAttribute('data-floating-ui-portal', '')
    portal.innerHTML = '<div data-testid="popup" tabindex="-1"></div>'
    document.body.appendChild(portal)

    fireEvent.keyDown(portal.firstElementChild!, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  // The real shape of the problem: a themed Select inside a dialog. Its popup
  // lives in a body-level portal, so both the react-aria focus trap and the
  // overlay's own Escape handler used to fight it.
  it('lets a Select inside it open and close on Escape without closing the dialog', () => {
    const onEscape = vi.fn()
    render(
      <FocusScopeOverlay visible onEscape={onEscape}>
        <div role="dialog">
          <Select
            value="a"
            options={[
              { value: 'a', label: 'a' },
              { value: 'b', label: 'b' },
            ]}
            onChange={() => {}}
            data-testid="sel"
          />
        </div>
      </FocusScopeOverlay>,
    )

    fireEvent.click(screen.getByTestId('sel'))
    expect(screen.getByRole('listbox')).toBeTruthy()

    // A mouse-opened popup leaves focus on the trigger, so Escape is dispatched
    // there, not into the portal — the overlay must still keep out of the way.
    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})
