import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ILayoutService, InstantiationService, ServiceCollection } from '@universe-editor/platform'
import { Panel } from '../Panel.js'
import { ServicesContext } from '../../useService.js'

vi.mock('../output/OutputView.js', () => ({
  OutputView: () => <div data-testid="output-view">Output Content</div>,
}))

function renderPanel() {
  const services = new ServiceCollection()
  services.set(ILayoutService, {
    _serviceBrand: undefined,
    getVisible: () => false,
    setVisible: () => {},
    toggleVisible: () => {},
  } as never)
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <Panel />
    </ServicesContext.Provider>,
  )
}

describe('Panel', () => {
  it('renders the Output tab selected by default', () => {
    renderPanel()
    const tab = screen.getByTestId('panel-tab-output')
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it('renders the Output tab with a compact icon and label', () => {
    renderPanel()
    const tab = screen.getByTestId('panel-tab-output')
    expect(tab.textContent).toContain('Output')
    expect(tab.querySelector('svg')).toBeTruthy()
  })

  it('renders the active tab content', () => {
    renderPanel()
    expect(screen.getByTestId('output-view')).toBeTruthy()
  })

  it('has correct ARIA role on the tab', () => {
    renderPanel()
    const tab = screen.getByTestId('panel-tab-output')
    expect(tab.getAttribute('role')).toBe('tab')
  })

  it('tab list has role tablist', () => {
    renderPanel()
    expect(screen.getByRole('tablist')).toBeTruthy()
  })

  it('clicking the active tab keeps it selected', () => {
    renderPanel()
    const tab = screen.getByTestId('panel-tab-output')
    fireEvent.click(tab)
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })
})
