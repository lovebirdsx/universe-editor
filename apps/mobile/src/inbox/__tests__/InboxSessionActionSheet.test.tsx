import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { sessionSummary } from '../../test/protocolFixtures.js'
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
    const onCompleted = vi.fn()
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
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('closed'))
    expect(client.closeSession).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' }))
    expect(screen.queryByTestId('inbox-session-close-sheet')).toBeNull()
    expect(onDismiss).toHaveBeenCalled()
  })

  it('confirms before closing a working session', async () => {
    const client = createClient()
    const onCompleted = vi.fn()
    render(
      <InboxSessionActionSheet
        client={client}
        session={sessionSummary('s1')}
        initialView="close"
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
        onCompleted={onCompleted}
      />,
    )

    expect(screen.getByTestId('inbox-session-close-sheet')).toBeTruthy()
    fireEvent.click(screen.getByTestId('inbox-session-close-sheet-confirm'))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('closed'))
    expect(client.closeSession).toHaveBeenCalledTimes(1)
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
        onCompleted={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-close'))
    expect(screen.getByTestId('inbox-session-close-sheet')).toBeTruthy()
    expect(client.closeSession).not.toHaveBeenCalled()
  })

  it('always confirms removal', async () => {
    const client = createClient()
    const onCompleted = vi.fn()
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
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(screen.getByTestId('inbox-session-remove'))
    expect(screen.getByTestId('inbox-session-remove-sheet')).toBeTruthy()
    fireEvent.click(screen.getByTestId('inbox-session-remove-sheet-confirm'))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('removed'))
    expect(client.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' }))
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
        onCompleted={vi.fn()}
      />,
    )

    expect((screen.getByTestId('inbox-session-close') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('inbox-session-remove') as HTMLButtonElement).disabled).toBe(true)
  })
})
