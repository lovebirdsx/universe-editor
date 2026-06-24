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
})
