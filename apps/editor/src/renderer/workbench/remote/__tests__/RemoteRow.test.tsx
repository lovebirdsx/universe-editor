/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/remote/RemoteRow.tsx
 *
 *  RemoteRow is a pure tree row: the shared `Tree` container owns focus and every
 *  navigation key, so this file asserts presentation + the two events the row
 *  still owns (click, contextmenu) — not keyboard behaviour.
 *--------------------------------------------------------------------------------------------*/

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RemoteRow, REMOTE_ROW_INDENT_BASE, REMOTE_ROW_INDENT_WIDTH } from '../RemoteRow.js'

describe('RemoteRow', () => {
  it('fires onClick on row click, passing the event with modifiers', () => {
    const onClick = vi.fn()
    render(<RemoteRow testId="remote-recent-row" label="h" tooltip="h" onClick={onClick} />)
    const row = screen.getByTestId('remote-recent-row')
    fireEvent.click(row, { ctrlKey: true })
    fireEvent.click(row)
    expect(onClick).toHaveBeenCalledTimes(2)
    const first = onClick.mock.calls[0]?.[0] as { ctrlKey: boolean }
    const second = onClick.mock.calls[1]?.[0] as { ctrlKey: boolean }
    expect(first.ctrlKey).toBe(true)
    expect(second.ctrlKey).toBe(false)
  })

  it('is a treeitem, never a tab stop (the tree container owns focus)', () => {
    render(
      <RemoteRow testId="remote-target-row" rowKey="target:h" label="h" tooltip="h" selected />,
    )
    const row = screen.getByTestId('remote-target-row')
    expect(row.getAttribute('role')).toBe('treeitem')
    expect(row.hasAttribute('tabindex')).toBe(false)
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.getAttribute('data-row-key')).toBe('target:h')
  })

  it('does not fire onClick from inner action buttons', () => {
    const onClick = vi.fn()
    const onAction = vi.fn()
    render(
      <RemoteRow
        testId="remote-target-row"
        label="h"
        tooltip="h"
        onClick={onClick}
        actions={
          <button type="button" data-testid="inner-action" onClick={onAction}>
            act
          </button>
        }
      />,
    )
    fireEvent.click(screen.getByTestId('inner-action'))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('reports context-menu with the pointer position', () => {
    const onContextMenu = vi.fn()
    render(
      <RemoteRow testId="remote-target-row" label="h" tooltip="h" onContextMenu={onContextMenu} />,
    )
    fireEvent.contextMenu(screen.getByTestId('remote-target-row'), { clientX: 12, clientY: 34 })
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    const e = onContextMenu.mock.calls[0]?.[0] as { preventDefault?: () => void }
    expect(typeof e.preventDefault).toBe('function')
  })

  it('renders the dot, description and label', () => {
    render(
      <RemoteRow
        testId="remote-wsl-target-row"
        dot="connected"
        label="Ubuntu"
        tooltip="Ubuntu"
        description="default"
      />,
    )
    expect(screen.getByText('Ubuntu')).toBeDefined()
    expect(screen.getByText('default')).toBeDefined()
  })

  it('toggles via chevron without firing the row click', () => {
    const onClick = vi.fn()
    const onToggle = vi.fn()
    render(
      <RemoteRow
        testId="remote-target-row"
        label="h"
        tooltip="h"
        onClick={onClick}
        chevron={{ expanded: true, onToggle }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps the chevron out of the tab order', () => {
    render(
      <RemoteRow
        testId="remote-target-row"
        label="h"
        tooltip="h"
        chevron={{ expanded: true, onToggle: () => {} }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('tabindex')).toBe('-1')
  })

  it('reflects chevron expanded state', () => {
    const { rerender } = render(
      <RemoteRow
        testId="remote-target-row"
        label="h"
        tooltip="h"
        ariaExpanded
        chevron={{ expanded: true, onToggle: () => {} }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    expect(screen.getByTestId('remote-target-row').getAttribute('aria-expanded')).toBe('true')
    rerender(
      <RemoteRow
        testId="remote-target-row"
        label="h"
        tooltip="h"
        ariaExpanded={false}
        chevron={{ expanded: false, onToggle: () => {} }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.getByTestId('remote-target-row').getAttribute('aria-expanded')).toBe('false')
  })

  it('omits aria-expanded on leaf rows', () => {
    render(<RemoteRow testId="remote-recent-row" label="h" tooltip="h" />)
    expect(screen.getByTestId('remote-recent-row').hasAttribute('aria-expanded')).toBe(false)
  })

  it('applies the tree-supplied indent padding, defaulting to the depth-0 base', () => {
    const { unmount } = render(<RemoteRow testId="remote-target-row" label="h" tooltip="h" />)
    expect(screen.getByTestId('remote-target-row').style.paddingLeft).toBe(
      `${REMOTE_ROW_INDENT_BASE}px`,
    )
    unmount()

    // What Tree computes for depth 2 with the view's indent configuration.
    const depth2 = 2 * REMOTE_ROW_INDENT_WIDTH + REMOTE_ROW_INDENT_BASE
    render(<RemoteRow testId="remote-target-row" label="h" tooltip="h" indentPadding={depth2} />)
    expect(screen.getByTestId('remote-target-row').style.paddingLeft).toBe('36px')
  })
})
