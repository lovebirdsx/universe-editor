import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Panel } from '../Panel.js'

vi.mock('../output/OutputView.js', () => ({
  OutputView: () => <div data-testid="output-view">Output Content</div>,
}))

describe('Panel', () => {
  it('renders the Output tab selected by default', () => {
    render(<Panel />)
    const tab = screen.getByTestId('panel-tab-output')
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it('renders the active tab content', () => {
    render(<Panel />)
    expect(screen.getByTestId('output-view')).toBeTruthy()
  })

  it('has correct ARIA role on the tab', () => {
    render(<Panel />)
    const tab = screen.getByTestId('panel-tab-output')
    expect(tab.getAttribute('role')).toBe('tab')
  })

  it('tab list has role tablist', () => {
    render(<Panel />)
    expect(screen.getByRole('tablist')).toBeTruthy()
  })

  it('clicking the active tab keeps it selected', () => {
    render(<Panel />)
    const tab = screen.getByTestId('panel-tab-output')
    fireEvent.click(tab)
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })
})
