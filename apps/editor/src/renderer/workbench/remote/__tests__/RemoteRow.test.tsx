/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/remote/RemoteRow.tsx
 *--------------------------------------------------------------------------------------------*/

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RemoteRow } from '../RemoteRow.js'

describe('RemoteRow', () => {
  it('fires onActivate on row click', () => {
    const onActivate = vi.fn()
    render(
      <RemoteRow
        testId="remote-target-row"
        label="alice@host"
        tooltip="alice@host"
        onActivate={onActivate}
      />,
    )
    fireEvent.click(screen.getByTestId('remote-target-row'))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('marks the row as a focusable button only when activatable', () => {
    const { unmount } = render(
      <RemoteRow testId="remote-target-row" label="h" tooltip="h" onActivate={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'h' })).toBeDefined()
    unmount()
    render(<RemoteRow testId="remote-target-row" label="h" tooltip="h" />)
    expect(screen.queryByRole('button', { name: 'h' })).toBeNull()
  })

  it('activates on Enter and Space', () => {
    const onActivate = vi.fn()
    render(<RemoteRow testId="remote-target-row" label="h" tooltip="h" onActivate={onActivate} />)
    const row = screen.getByTestId('remote-target-row')
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    fireEvent.keyDown(row, { key: 'x' })
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it('does not trigger onActivate from inner action buttons', () => {
    const onActivate = vi.fn()
    const onAction = vi.fn()
    render(
      <RemoteRow
        testId="remote-target-row"
        label="h"
        tooltip="h"
        onActivate={onActivate}
        actions={
          <button type="button" data-testid="inner-action" onClick={onAction}>
            act
          </button>
        }
      />,
    )
    fireEvent.click(screen.getByTestId('inner-action'))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
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
})
