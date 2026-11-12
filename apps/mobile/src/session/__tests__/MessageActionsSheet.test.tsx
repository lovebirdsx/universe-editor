import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { commandErrorText, strings } from '../../strings.js'
import { MessageActionsSheet } from '../MessageActionsSheet.js'

function renderSheet(overrides: Partial<Parameters<typeof MessageActionsSheet>[0]> = {}) {
  const onCopyText = vi.fn(async () => undefined)
  const onCopyImage = vi.fn(async () => undefined)
  const onRewind = vi.fn()
  const onFork = vi.fn(async () => undefined)
  const onSideTask = vi.fn(async () => undefined)
  const onClose = vi.fn()
  const onNotice = vi.fn()
  render(
    <MessageActionsSheet
      canCopyText
      canCopyImage
      canRewind
      canFork
      canCreateSideTask
      online
      running={false}
      onCopyText={onCopyText}
      onCopyImage={onCopyImage}
      onRewind={onRewind}
      onFork={onFork}
      onSideTask={onSideTask}
      onClose={onClose}
      onNotice={onNotice}
      {...overrides}
    />,
  )
  return { onCopyText, onCopyImage, onRewind, onFork, onSideTask, onClose, onNotice }
}

describe('MessageActionsSheet', () => {
  it('offers copy text and copy image when allowed', () => {
    renderSheet()
    expect(screen.getByTestId('message-action-copy-text')).toBeTruthy()
    expect(screen.getByTestId('message-action-copy-image')).toBeTruthy()
    expect(screen.getByTestId('message-action-rewind')).toBeTruthy()
    expect(screen.getByTestId('message-action-fork')).toBeTruthy()
    expect(screen.getByTestId('message-action-side-task')).toBeTruthy()
  })

  it('hides disallowed actions', () => {
    renderSheet({
      canCopyText: false,
      canCopyImage: false,
      canRewind: false,
      canFork: false,
      canCreateSideTask: true,
    })
    expect(screen.queryByTestId('message-action-copy-text')).toBeNull()
    expect(screen.queryByTestId('message-action-copy-image')).toBeNull()
    expect(screen.queryByTestId('message-action-rewind')).toBeNull()
    expect(screen.queryByTestId('message-action-fork')).toBeNull()
    expect(screen.getByTestId('message-action-side-task')).toBeTruthy()
  })

  it('keeps copy actions available offline and while running', () => {
    renderSheet({ online: false, running: true })
    expect((screen.getByTestId('message-action-copy-text') as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect((screen.getByTestId('message-action-copy-image') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('invokes copy actions', async () => {
    const { onCopyText, onCopyImage } = renderSheet()
    fireEvent.click(screen.getByTestId('message-action-copy-text'))
    await waitFor(() => expect(onCopyText).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('message-action-copy-image'))
    await waitFor(() => expect(onCopyImage).toHaveBeenCalledTimes(1))
  })

  it('disables other actions and shows progress while copying', async () => {
    let resolveCopy: (() => void) | undefined
    renderSheet({
      onCopyImage: () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve
        }),
    })
    fireEvent.click(screen.getByTestId('message-action-copy-image'))
    const copyImage = screen.getByTestId('message-action-copy-image') as HTMLButtonElement
    expect(copyImage.textContent).toBe(strings.messageCopyImageBusy)
    expect(copyImage.disabled).toBe(true)
    expect((screen.getByTestId('message-action-fork') as HTMLButtonElement).disabled).toBe(true)

    resolveCopy?.()
    await waitFor(() => expect(copyImage.disabled).toBe(false))
    expect(copyImage.textContent).toBe(strings.messageActionCopyImage)
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
    await waitFor(() =>
      expect((screen.getByTestId('message-action-side-task') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )

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
