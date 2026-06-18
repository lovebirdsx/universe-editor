/*---------------------------------------------------------------------------------------------
 *  Tests for Toggle — a role="switch" control: aria-checked reflects state, click
 *  flips it via onChange, and disabled suppresses the callback.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Toggle } from '../atoms/Toggle.js'

afterEach(() => {
  cleanup()
})

describe('Toggle', () => {
  it('reflects checked state via aria-checked', () => {
    render(<Toggle checked onChange={vi.fn()} aria-label="t" data-testid="t" />)
    expect(screen.getByTestId('t').getAttribute('aria-checked')).toBe('true')
  })

  it('calls onChange with the negated value on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} data-testid="t" />)
    fireEvent.click(screen.getByTestId('t'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not call onChange when disabled', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} disabled data-testid="t" />)
    fireEvent.click(screen.getByTestId('t'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
