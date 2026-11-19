/*---------------------------------------------------------------------------------------------
 *  NotificationsCenter host focus contract: opening the center steals DOM focus
 *  into the panel (the overlay Vim surface needs `focus: within`), so closing it
 *  must hand focus back to whatever held it before. The panel is rendered under
 *  StrictMode exactly like `pnpm dev` — its dry-run effect pass must not consume
 *  the restore target.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { INotificationService, observableValue } from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { NotificationsCenter } from '../NotificationsCenter.js'

function makeService(initiallyVisible = false) {
  const centerVisible = observableValue('test.centerVisible', initiallyVisible)
  const notifications = observableValue<readonly unknown[]>('test.notifications', [])
  const notificationOrigins = observableValue('test.origins', new Map<string, Document>())
  const centerDocument = observableValue<Document | undefined>('test.centerDocument', undefined)
  const service = {
    centerVisible,
    notifications,
    notificationOrigins,
    centerDocument,
    toggleCenter: vi.fn(() => centerVisible.set(!centerVisible.get(), undefined)),
    dismiss: vi.fn(),
    cancelProgress: vi.fn(),
    clearAll: vi.fn(),
  }
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => (id === INotificationService ? service : undefined) }),
  }
  return { service, container, centerVisible }
}

function renderHost(container: unknown) {
  return render(
    <StrictMode>
      <ServicesContext.Provider value={container as never}>
        <NotificationsCenter />
      </ServicesContext.Provider>
    </StrictMode>,
  )
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('NotificationsCenter focus restore', () => {
  it('returns focus to the pre-open element after the center closes (StrictMode)', () => {
    const outside = document.createElement('button')
    outside.textContent = 'outside'
    document.body.appendChild(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    const { container, centerVisible } = makeService()
    renderHost(container)

    act(() => centerVisible.set(true, undefined))
    expect(document.activeElement).toBe(screen.getByTestId('notifications-center'))

    act(() => centerVisible.set(false, undefined))
    expect(screen.queryByTestId('notifications-center')).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it('leaves focus alone when the user moved it outside the center before closing', () => {
    const first = document.createElement('button')
    const second = document.createElement('button')
    document.body.append(first, second)
    first.focus()

    const { container, centerVisible } = makeService()
    renderHost(container)

    act(() => centerVisible.set(true, undefined))
    expect(document.activeElement).toBe(screen.getByTestId('notifications-center'))

    second.focus()
    act(() => centerVisible.set(false, undefined))
    expect(document.activeElement).toBe(second)
  })

  it('does not restore a target that was removed from the DOM', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    const { container, centerVisible } = makeService()
    renderHost(container)

    act(() => centerVisible.set(true, undefined))
    outside.remove()
    act(() => centerVisible.set(false, undefined))
    expect(document.activeElement).toBe(document.body)
  })
})
