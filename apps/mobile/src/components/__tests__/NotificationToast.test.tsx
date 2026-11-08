import type { NotificationFrame } from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NotificationToast } from '../NotificationToast.js'
import { Store } from '../../state/store.js'
import type { MobileClient } from '../../state/mobileClient.js'

function makeClient(frame: NotificationFrame | undefined): {
  client: MobileClient
  store: Store<NotificationFrame | undefined>
  dismiss: ReturnType<typeof vi.fn>
} {
  const store = new Store<NotificationFrame | undefined>(frame)
  const dismiss = vi.fn(() => store.setState(undefined))
  const client = {
    getNotificationStore: () => store,
    dismissNotification: dismiss,
  } as unknown as MobileClient
  return { client, store, dismiss }
}

const PERMISSION: NotificationFrame = {
  type: 'notification',
  id: 'n1',
  kind: 'permission',
  ref: { windowId: 2, localId: 'local-1', durableId: 'durable-1' },
  title: 'Fix the parser',
  body: '等待审批：Run shell command',
  at: 1,
}

describe('NotificationToast', () => {
  it('renders title and body and opens the session with pending focus', () => {
    const { client, dismiss } = makeClient(PERMISSION)
    const onOpen = vi.fn()
    render(<NotificationToast client={client} onOpen={onOpen} />)

    expect(screen.getByTestId('notification-toast')).toBeTruthy()
    fireEvent.click(screen.getByText('Fix the parser'))

    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('durable-1', true)
  })

  it('routes completion notifications without pending focus', () => {
    const { client } = makeClient({ ...PERMISSION, kind: 'completed', body: '已完成' })
    const onOpen = vi.fn()
    render(<NotificationToast client={client} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('Fix the parser'))
    expect(onOpen).toHaveBeenCalledWith('durable-1', false)
  })

  it('falls back to the window-local route key', () => {
    const { client } = makeClient({
      ...PERMISSION,
      ref: { windowId: 2, localId: 'local-1' },
      kind: 'question',
    })
    const onOpen = vi.fn()
    render(<NotificationToast client={client} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('Fix the parser'))
    expect(onOpen).toHaveBeenCalledWith('2:local-1', false)
  })

  it('dismisses through the button', () => {
    const { client, store, dismiss } = makeClient(PERMISSION)
    render(<NotificationToast client={client} onOpen={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('知道了'))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(store.getState()).toBeUndefined()
  })

  it('renders nothing without a notification', () => {
    const { client } = makeClient(undefined)
    const { container } = render(<NotificationToast client={client} onOpen={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('auto-dismisses after five seconds', () => {
    vi.useFakeTimers()
    try {
      const { client, store, dismiss } = makeClient(PERMISSION)
      render(<NotificationToast client={client} onOpen={vi.fn()} />)

      act(() => {
        vi.advanceTimersByTime(4_999)
      })
      expect(dismiss).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(dismiss).toHaveBeenCalledTimes(1)
      expect(store.getState()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
