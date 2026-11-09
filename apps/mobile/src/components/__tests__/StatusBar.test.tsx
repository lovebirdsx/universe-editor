import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusBar, statusText } from '../StatusBar.js'
import { strings } from '../../strings.js'

describe('StatusBar', () => {
  it('exposes the sessions entry and settings actions', () => {
    const onOpenSessions = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <StatusBar
        pcName="PC-A"
        state="connected"
        onOpenSessions={onOpenSessions}
        onOpenSettings={onOpenSettings}
      />,
    )

    expect(screen.getByText('PC-A')).toBeTruthy()
    expect(screen.getByText(strings.statusConnected)).toBeTruthy()
    fireEvent.click(screen.getByTestId('open-sessions'))
    expect(onOpenSessions).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: strings.settings }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('maps socket states to readable labels', () => {
    expect(statusText('connected')).toBe(strings.statusConnected)
    expect(statusText('reconnecting')).toBe(strings.statusReconnecting)
    expect(statusText('protocol_mismatch')).toBe(strings.statusVersionMismatch)
    expect(statusText('connecting')).toBe(strings.statusConnecting)
  })
})
