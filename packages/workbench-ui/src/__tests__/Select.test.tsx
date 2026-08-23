import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../atoms/Select.js'

const OPTIONS = [
  { value: '', label: '(default)' },
  { value: 'low', label: 'low' },
  { value: 'high', label: 'high' },
] as const

describe('Select', () => {
  afterEach(cleanup)

  it('shows the selected option label on the trigger', () => {
    render(<Select value="high" options={OPTIONS} onChange={() => {}} data-testid="sel" />)
    expect(screen.getByTestId('sel').textContent).toContain('high')
  })

  it('opens the popup and fires onChange on click', () => {
    const onChange = vi.fn()
    render(<Select value="" options={OPTIONS} onChange={onChange} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    fireEvent.click(screen.getByRole('option', { name: 'low' }))
    expect(onChange).toHaveBeenCalledWith('low')
  })

  it('does not open when disabled', () => {
    render(<Select value="" options={OPTIONS} onChange={() => {}} data-testid="sel" disabled />)
    fireEvent.click(screen.getByTestId('sel'))
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('reflects invalid state via aria-invalid', () => {
    render(<Select value="" options={OPTIONS} onChange={() => {}} data-testid="sel" invalid />)
    expect(screen.getByTestId('sel').getAttribute('aria-invalid')).toBe('true')
  })

  it('shows triggerLabel on the trigger while the dropdown item keeps the full label', () => {
    const options = [
      {
        value: 'a',
        label: (
          <span>
            Title A<span>detail about A</span>
          </span>
        ),
        triggerLabel: 'Title A',
      },
    ]
    render(<Select value="a" options={options} onChange={() => {}} data-testid="sel" />)
    const trigger = screen.getByTestId('sel')
    expect(trigger.textContent).toContain('Title A')
    expect(trigger.textContent).not.toContain('detail about A')

    fireEvent.click(trigger)
    expect(screen.getByRole('option').textContent).toContain('detail about A')
  })

  it('marks the popup as a top layer so a react-aria focus trap lets focus in', () => {
    render(<Select value="" options={OPTIONS} onChange={() => {}} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    expect(document.querySelector('[data-react-aria-top-layer]')).toBeTruthy()
  })

  describe('disabled options', () => {
    const WITH_DISABLED = [
      { value: 'a', label: 'a' },
      { value: 'mid', label: 'mid', disabled: true },
      { value: 'b', label: 'b' },
    ] as const

    it('renders aria-disabled', () => {
      render(<Select value="a" options={WITH_DISABLED} onChange={() => {}} data-testid="sel" />)
      fireEvent.click(screen.getByTestId('sel'))
      expect(screen.getByRole('option', { name: 'mid' }).getAttribute('aria-disabled')).toBe('true')
    })

    it('does not select on click and keeps the popup open', () => {
      const onChange = vi.fn()
      render(<Select value="a" options={WITH_DISABLED} onChange={onChange} data-testid="sel" />)
      fireEvent.click(screen.getByTestId('sel'))
      fireEvent.click(screen.getByRole('option', { name: 'mid' }))
      expect(onChange).not.toHaveBeenCalled()
      expect(screen.queryByRole('option', { name: 'mid' })).toBeTruthy()
    })

    it('is skipped by keyboard navigation', () => {
      render(<Select value="a" options={WITH_DISABLED} onChange={() => {}} data-testid="sel" />)
      // ArrowDown on the trigger opens the popup with 'a' active; the next one
      // must land on 'b', not on the disabled 'mid' in between.
      fireEvent.keyDown(screen.getByTestId('sel'), { key: 'ArrowDown' })
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
      expect(screen.getByRole('option', { name: 'mid' }).getAttribute('data-active')).toBe('false')
      expect(screen.getByRole('option', { name: 'b' }).getAttribute('data-active')).toBe('true')
    })
  })
})
