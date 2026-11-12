import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryAlertToast } from '../DeliveryAlertToast.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('DeliveryAlertToast', () => {
  it('renders the delivery alert and opens the inbox on click', () => {
    const onOpenInbox = vi.fn()
    render(
      <DeliveryAlertToast
        title="交付待确认推送"
        body="「Session s1」的交付已准备就绪，确认后推送。"
        tone="info"
        onDismiss={vi.fn()}
        onOpenInbox={onOpenInbox}
      />,
    )

    expect(screen.getByTestId('delivery-notice-toast').textContent).toContain('交付待确认推送')
    fireEvent.click(screen.getByText('交付待确认推送'))
    expect(onOpenInbox).toHaveBeenCalledTimes(1)
  })

  it('auto-dismisses after five seconds', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(
      <DeliveryAlertToast
        title="交付失败"
        body="「Session s1」的交付失败。"
        tone="danger"
        onDismiss={onDismiss}
        onOpenInbox={vi.fn()}
      />,
    )

    expect(screen.getByTestId('delivery-notice-toast').className).toContain(
      'delivery-toast--danger',
    )
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not restart the timer when the parent re-renders', () => {
    vi.useFakeTimers()
    const firstDismiss = vi.fn()
    const { rerender } = render(
      <DeliveryAlertToast
        title="交付待确认推送"
        body="「Session s1」的交付已准备就绪，确认后推送。"
        tone="info"
        onDismiss={firstDismiss}
        onOpenInbox={vi.fn()}
      />,
    )

    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    const latestDismiss = vi.fn()
    rerender(
      <DeliveryAlertToast
        title="交付待确认推送"
        body="「Session s1」的交付已准备就绪，确认后推送。"
        tone="info"
        onDismiss={latestDismiss}
        onOpenInbox={vi.fn()}
      />,
    )
    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(firstDismiss).not.toHaveBeenCalled()
    expect(latestDismiss).toHaveBeenCalledTimes(1)
  })
})
