import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Severity,
  getInvocationModifiers,
  type IInvocationModifiers,
  type INotification,
} from '@universe-editor/platform'
import { NotificationsCenter } from '../feedback/notifications/NotificationsCenter.js'
import { NotificationsToast } from '../feedback/notifications/NotificationsToast.js'

afterEach(cleanup)

// Notification buttons often run editor-opening commands (e.g. "Show Log"):
// Ctrl/Alt on the click must reach the command like any other button.
function notification(seen: Array<IInvocationModifiers | undefined>): INotification {
  return {
    id: 'n1',
    severity: Severity.Info,
    message: 'hello',
    sticky: true,
    timestamp: Date.now(),
    read: false,
    dismissed: false,
    actions: [{ label: 'Show Log', run: () => void seen.push(getInvocationModifiers()) }],
  }
}

const noop = (): void => undefined

describe.each([
  [
    'NotificationsToast',
    (n: INotification) => (
      <NotificationsToast notifications={[n]} onDismiss={noop} onCancelProgress={noop} />
    ),
  ],
  [
    'NotificationsCenter',
    (n: INotification) => (
      <NotificationsCenter
        notifications={[n]}
        onDismiss={noop}
        onCancelProgress={noop}
        onClearAll={noop}
        onClose={noop}
      />
    ),
  ],
] as const)('%s action buttons', (_name, renderWith) => {
  it('forward the click modifiers to the action', () => {
    const seen: Array<IInvocationModifiers | undefined> = []
    render(renderWith(notification(seen)))

    fireEvent.click(screen.getByText('Show Log'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Show Log'), { altKey: true })

    expect(seen[0]?.ctrlKey).toBe(true)
    expect(seen[1]?.altKey).toBe(true)
  })
})
