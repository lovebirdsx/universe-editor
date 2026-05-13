import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

afterEach(cleanup)
import App from '../App.js'

describe('App', () => {
  it('renders all three products with formatted prices', () => {
    render(<App />)
    expect(screen.getByText('Widget Pro')).toBeDefined()
    expect(screen.getByText('$49.99')).toBeDefined()
    expect(screen.getByText('Gadget Plus')).toBeDefined()
    expect(screen.getByText('$129.00')).toBeDefined()
    expect(screen.getByText('Doohickey')).toBeDefined()
    expect(screen.getByText('$9.99')).toBeDefined()
  })

  it('shows selected product name after clicking Select', () => {
    render(<App />)
    const buttons = screen.getAllByRole('button', { name: 'Select' })
    fireEvent.click(buttons[0]!)
    expect(screen.getByText('Widget Pro', { selector: 'strong' })).toBeDefined()
  })

  it('deselects product when clicking the button again', () => {
    render(<App />)
    const buttons = screen.getAllByRole('button', { name: 'Select' })
    fireEvent.click(buttons[0]!)
    // button label changes to Deselect
    const deselectBtn = screen.getByRole('button', { name: 'Deselect' })
    fireEvent.click(deselectBtn)
    // selected message should be gone
    expect(screen.queryByText('Selected:')).toBeNull()
  })
})
