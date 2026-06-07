import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button } from '../atoms/Button.js'
import { IconButton } from '../atoms/IconButton.js'
import { Input } from '../atoms/Input.js'
import { Checkbox } from '../atoms/Checkbox.js'
import { Badge } from '../atoms/Badge.js'

describe('atoms', () => {
  afterEach(cleanup)

  it('Button fires onClick and disables when busy', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <Button onClick={onClick} variant="primary">
        Go
      </Button>,
    )
    fireEvent.click(screen.getByText('Go'))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(
      <Button onClick={onClick} busy>
        Go
      </Button>,
    )
    const btn = screen.getByText('Go').closest('button')!
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
  })

  it('IconButton exposes label as aria-label and title', () => {
    render(
      <IconButton label="Refresh">
        <svg />
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Refresh' })
    expect(btn.getAttribute('title')).toBe('Refresh')
  })

  it('Input reflects invalid state via aria-invalid', () => {
    render(<Input invalid placeholder="name" />)
    expect(screen.getByPlaceholderText('name').getAttribute('aria-invalid')).toBe('true')
  })

  it('Checkbox is controlled and reports changes', () => {
    const onChange = vi.fn()
    render(<Checkbox checked={false} onChange={onChange} label="Pick" data-testid="cb" />)
    fireEvent.click(screen.getByTestId('cb'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('Checkbox sets indeterminate on the DOM node', () => {
    render(<Checkbox checked={false} onChange={() => {}} indeterminate data-testid="cb" />)
    expect((screen.getByTestId('cb') as HTMLInputElement).indeterminate).toBe(true)
  })

  it('Badge renders children', () => {
    render(<Badge tone="accent">9</Badge>)
    expect(screen.getByText('9')).toBeTruthy()
  })
})
