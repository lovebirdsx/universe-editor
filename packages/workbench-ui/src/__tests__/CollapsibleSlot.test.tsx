/*---------------------------------------------------------------------------------------------
 *  Tests for CollapsibleSlot — the shared collapse shell: header toggles,
 *  aria-expanded reflects state, body renders only when expanded, summary shows
 *  when collapsed, and the kind label surfaces as a tooltip.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CollapsibleSlot } from '../layout/CollapsibleSlot.js'

afterEach(() => {
  cleanup()
})

function renderSlot(collapsed: boolean, onToggle = vi.fn()) {
  render(
    <ul>
      <CollapsibleSlot
        icon={<span>icon</span>}
        kindLabel="read"
        title={<span>the title</span>}
        summary="a short summary"
        collapsed={collapsed}
        onToggle={onToggle}
      >
        <div data-testid="slot-body">body content</div>
      </CollapsibleSlot>
    </ul>,
  )
  return onToggle
}

describe('CollapsibleSlot', () => {
  it('renders the body and title when expanded', () => {
    renderSlot(false)
    expect(screen.getByTestId('slot-body')).toBeTruthy()
    expect(screen.getByText('the title')).toBeTruthy()
    expect(screen.getByTestId('acp-collapsible-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('hides the body and shows the summary when collapsed', () => {
    renderSlot(true)
    expect(screen.queryByTestId('slot-body')).toBeNull()
    expect(screen.getByText('a short summary')).toBeTruthy()
    expect(screen.getByTestId('acp-collapsible-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('exposes the kind label as the header tooltip', () => {
    renderSlot(true)
    expect(screen.getByTestId('acp-collapsible-toggle').getAttribute('data-tooltip')).toBe('read')
  })

  it('invokes onToggle when the header is clicked', () => {
    const onToggle = renderSlot(false)
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('merges headerClassName onto the header button', () => {
    render(
      <ul>
        <CollapsibleSlot
          icon={<span>icon</span>}
          kindLabel="user"
          collapsed={false}
          onToggle={vi.fn()}
          headerClassName="sticky-header"
        >
          <div>body</div>
        </CollapsibleSlot>
      </ul>,
    )
    expect(screen.getByTestId('acp-collapsible-toggle').className).toContain('sticky-header')
  })

  describe('actions', () => {
    function renderWithActions(collapsed: boolean) {
      const onAction = vi.fn()
      render(
        <ul>
          <CollapsibleSlot
            icon={<span>icon</span>}
            kindLabel="edit"
            title={<span>the title</span>}
            summary="a short summary"
            collapsed={collapsed}
            onToggle={vi.fn()}
            actions={
              <button type="button" data-testid="slot-action" onClick={onAction}>
                preview
              </button>
            }
          >
            <div data-testid="slot-body">body content</div>
          </CollapsibleSlot>
        </ul>,
      )
      return onAction
    }

    it('renders the action outside the toggle button (no nested buttons)', () => {
      renderWithActions(true)
      const action = screen.getByTestId('slot-action')
      expect(screen.getByTestId('acp-collapsible-toggle').contains(action)).toBe(false)
    })

    it('renders actions in both collapsed and expanded states', () => {
      renderWithActions(true)
      expect(screen.getByTestId('slot-action')).toBeTruthy()
      cleanup()
      renderWithActions(false)
      expect(screen.getByTestId('slot-action')).toBeTruthy()
    })

    it('does not toggle the slot when the action is clicked', () => {
      const onToggle = vi.fn()
      render(
        <ul>
          <CollapsibleSlot
            icon={<span>icon</span>}
            kindLabel="edit"
            collapsed
            onToggle={onToggle}
            actions={<button type="button" data-testid="slot-action" />}
          >
            <div>body</div>
          </CollapsibleSlot>
        </ul>,
      )
      fireEvent.click(screen.getByTestId('slot-action'))
      expect(onToggle).not.toHaveBeenCalled()
    })

    it('leaves the header unwrapped when no actions are given, so a sticky header keeps working', () => {
      renderSlot(false)
      const header = screen.getByTestId('acp-collapsible-toggle')
      // The header is a direct child of the slot root — an extra wrapper box
      // would clip a caller-applied `position: sticky` out of stickiness.
      expect(header.parentElement?.tagName).toBe('LI')
    })
  })
})
