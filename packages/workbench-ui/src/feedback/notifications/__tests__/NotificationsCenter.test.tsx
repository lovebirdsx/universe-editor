/*---------------------------------------------------------------------------------------------
 *  NotificationsCenter presentational contract: the host owns the Vim cursor and
 *  passes it in; the panel paints it, reports clicks, and forwards Delete to the
 *  focused row. No DI, no portal.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Severity, type INotification } from '@universe-editor/platform'
import { NotificationsCenter } from '../NotificationsCenter.js'

function notification(id: string, message: string): INotification {
  return {
    id,
    severity: Severity.Info,
    message,
    sticky: true,
    timestamp: Date.now(),
    read: false,
    dismissed: false,
  }
}

function renderCenter(focusedIndex: number) {
  const onFocusChange = vi.fn()
  const onDismiss = vi.fn()
  render(
    <NotificationsCenter
      notifications={[notification('old', 'older'), notification('new', 'newest')]}
      focusedIndex={focusedIndex}
      onFocusChange={onFocusChange}
      autoFocus
      onDismiss={onDismiss}
      onCancelProgress={() => {}}
      onClearAll={() => {}}
      onClose={() => {}}
    />,
  )
  return { onFocusChange, onDismiss }
}

afterEach(cleanup)

describe('NotificationsCenter focus contract', () => {
  it('paints the host cursor in newest-first order', () => {
    renderCenter(0)
    const items = screen.getAllByTestId('notification-center-item')
    expect(items[0]?.textContent).toContain('newest')
    expect(items[0]?.getAttribute('aria-selected')).toBe('true')
    expect(items[1]?.getAttribute('aria-selected')).toBe('false')
  })

  it('reports a row click as a focus change', () => {
    const { onFocusChange } = renderCenter(0)
    fireEvent.click(screen.getAllByTestId('notification-center-item')[1]!)
    expect(onFocusChange).toHaveBeenCalledWith(1)
  })

  it('Delete dismisses the focused notification', () => {
    const { onDismiss } = renderCenter(1)
    fireEvent.keyDown(screen.getByTestId('notifications-center'), { key: 'Delete' })
    expect(onDismiss).toHaveBeenCalledWith('old')
  })

  it('takes DOM focus on mount so the overlay surface can own the keys', () => {
    renderCenter(0)
    expect(document.activeElement).toBe(screen.getByTestId('notifications-center'))
  })
})
