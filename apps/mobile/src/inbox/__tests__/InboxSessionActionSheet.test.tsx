import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { sessionSummary } from '../../test/protocolFixtures.js'
import {
  SESSION_CLOSE_CONFIRM_STORAGE_KEY,
  SESSION_REMOVE_CONFIRM_STORAGE_KEY,
  setSessionCloseConfirmEnabled,
  setSessionRemoveConfirmEnabled,
} from '../../session/sessionConfirm.js'
import { InboxSessionActionSheet } from '../InboxSessionActionSheet.js'

function createClient() {
  return {
    closeSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  }
}

describe('InboxSessionActionSheet', () => {
  it('closes an idle session directly from the long-press menu', async () => {
    const client = createClient()
    const onDismiss = vi.fn()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1', {
          status: 'idle',
          displayStatus: 'idle',
          bucket: 'completed',
        })}
        initialView="menu"
        online
        onDismiss={onDismiss}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))
    await waitFor(() => expect(onDismiss).toHaveBeenCalled())
    expect(client.closeSession).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' }))
    expect(screen.queryByTestId('inbox-session-close-sheet')).toBeNull()
  })

  it('confirms before closing a working session', async () => {
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1')}
        initialView="close"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    expect(screen.getByTestId('inbox-session-close-sheet')).toBeTruthy()
    fireEvent.click(screen.getByTestId('inbox-session-close-sheet-confirm'))
    await waitFor(() => expect(client.closeSession).toHaveBeenCalledTimes(1))
  })

  it('confirms when only a background task is still running', () => {
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1', {
          status: 'idle',
          displayStatus: 'idle',
          bucket: 'completed',
          backgroundTaskCount: 2,
        })}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))
    expect(screen.getByTestId('inbox-session-close-sheet')).toBeTruthy()
    expect(client.closeSession).not.toHaveBeenCalled()
  })

  it('always confirms removal', async () => {
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1', {
          status: 'idle',
          displayStatus: 'idle',
          bucket: 'completed',
        })}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-remove'))
    expect(screen.getByTestId('inbox-session-remove-sheet')).toBeTruthy()
    fireEvent.click(screen.getByTestId('inbox-session-remove-sheet-confirm'))
    await waitFor(() =>
      expect(client.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' })),
    )
  })

  it('disables actions while the PC is offline', () => {
    render(
      <InboxSessionActionSheet
        client={createClient()}
        session={sessionSummary('s1')}
        initialView="menu"
        online={false}
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    expect((screen.getByTestId('inbox-session-close') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('inbox-session-remove') as HTMLButtonElement).disabled).toBe(true)
  })

  it('remembers never-ask after closing a working session', async () => {
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1')}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))
    fireEvent.click(screen.getByTestId('inbox-session-close-sheet-never-ask'))
    fireEvent.click(screen.getByTestId('inbox-session-close-sheet-confirm'))

    await waitFor(() => expect(client.closeSession).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('never')
  })

  it('remembers never-ask when removing', async () => {
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1')}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-remove'))
    fireEvent.click(screen.getByTestId('inbox-session-remove-sheet-never-ask'))
    fireEvent.click(screen.getByTestId('inbox-session-remove-sheet-confirm'))

    await waitFor(() => expect(client.deleteSession).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY)).toBe('never')
  })

  it('closes a working session directly once the close preference is off', async () => {
    setSessionCloseConfirmEnabled(false)
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1')}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))

    expect(screen.queryByTestId('inbox-session-close-sheet')).toBeNull()
    await waitFor(() => expect(client.closeSession).toHaveBeenCalledTimes(1))
  })

  it('removes directly once the remove preference is off', async () => {
    setSessionRemoveConfirmEnabled(false)
    const client = createClient()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1')}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-remove'))

    expect(screen.queryByTestId('inbox-session-remove-sheet')).toBeNull()
    await waitFor(() => expect(client.deleteSession).toHaveBeenCalledTimes(1))
  })

  it('keeps close confirmation when only the remove preference is off', () => {
    setSessionRemoveConfirmEnabled(false)
    render(
      <InboxSessionActionSheet
        client={createClient()}
        session={sessionSummary('s1')}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))

    expect(screen.getByTestId('inbox-session-close-sheet')).toBeTruthy()
  })

  it('keeps remove confirmation when only the close preference is off', () => {
    setSessionCloseConfirmEnabled(false)
    render(
      <InboxSessionActionSheet
        client={createClient()}
        session={sessionSummary('s1')}
        initialView="menu"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-remove'))

    expect(screen.getByTestId('inbox-session-remove-sheet')).toBeTruthy()
  })

  it('does not persist the preference when the user cancels', () => {
    render(
      <InboxSessionActionSheet
        client={createClient()}
        session={sessionSummary('s1')}
        initialView="remove"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-remove-sheet-never-ask'))
    fireEvent.click(screen.getByTestId('inbox-session-remove-sheet-cancel'))

    expect(localStorage.getItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY)).toBeNull()
  })
})
