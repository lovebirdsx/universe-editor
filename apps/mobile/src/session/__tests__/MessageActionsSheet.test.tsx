import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { commandErrorText, strings } from '../../strings.js'
import { MessageActionsSheet } from '../MessageActionsSheet.js'

function renderSheet(overrides: Partial<Parameters<typeof MessageActionsSheet>[0]> = {}) {
  const onRewind = vi.fn()
  const onFork = vi.fn(async () => undefined)
  const onSideTask = vi.fn(async () => undefined)
  const onClose = vi.fn()
  const onNotice = vi.fn()
  render(
    <MessageActionsSheet
      canRewind
      canFork
      canCreateSideTask
      online
      running={false}
      onRewind={onRewind}
      onFork={onFork}
      onSideTask={onSideTask}
      onClose={onClose}
      onNotice={onNotice}
      {...overrides}
    />,
  )
  return { onRewind, onFork, onSideTask, onClose, onNotice }
}

describe('MessageActionsSheet', () => {
  it('offers rewind, fork and side task when allowed', () => {
    renderSheet()
    expect(screen.getByTestId('message-action-rewind')).toBeTruthy()
    expect(screen.getByTestId('message-action-fork')).toBeTruthy()
    expect(screen.getByTestId('message-action-side-task')).toBeTruthy()
  })

  it('hides disallowed actions', () => {
    renderSheet({ canRewind: false, canFork: false, canCreateSideTask: true })
    expect(screen.queryByTestId('message-action-rewind')).toBeNull()
    expect(screen.queryByTestId('message-action-fork')).toBeNull()
    expect(screen.getByTestId('message-action-side-task')).toBeTruthy()
  })

  it('disables fork while the session is running and explains why', () => {
    renderSheet({ running: true })
    const fork = screen.getByTestId('message-action-fork') as HTMLButtonElement
    expect(fork.disabled).toBe(true)
    expect(fork.title).toBe(strings.forkBusy)
  })

  it('invokes the selected action and closes on cancel', async () => {
    const { onRewind, onFork, onSideTask, onClose } = renderSheet()
    fireEvent.click(screen.getByTestId('message-action-rewind'))
    expect(onRewind).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('message-action-fork'))
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('message-action-side-task'))
    await waitFor(() => expect(onSideTask).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: strings.pendingCancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports async action failures through the toast channel', async () => {
    const failure = Object.assign(new Error('busy'), { code: 'session_busy' })
    const { onNotice } = renderSheet({ onFork: () => Promise.reject(failure) })
    fireEvent.click(screen.getByTestId('message-action-fork'))
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(commandErrorText('session_busy')))
  })
})
