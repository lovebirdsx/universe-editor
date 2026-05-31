/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for CollapsibleSlot — the shared collapse shell: header toggles,
 *  aria-expanded reflects state, body renders only when expanded, summary shows
 *  when collapsed, and the kind label surfaces as a tooltip.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CollapsibleSlot } from '../CollapsibleSlot.js'

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
    expect(screen.getByTestId('acp-collapsible-toggle').getAttribute('title')).toBe('read')
  })

  it('invokes onToggle when the header is clicked', () => {
    const onToggle = renderSlot(false)
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
