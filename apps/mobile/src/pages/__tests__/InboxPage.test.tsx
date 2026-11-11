import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StoredCredentials } from '../../credentials.js'
import { sessionSummary } from '../../test/protocolFixtures.js'
import { Store } from '../../state/store.js'
import type { MobileClient } from '../../state/mobileClient.js'
import {
  setSessionCloseConfirmEnabled,
  setSessionRemoveConfirmEnabled,
} from '../../session/sessionConfirm.js'
import { InboxPage } from '../InboxPage.js'

const credentials: StoredCredentials = {
  deviceId: 'device-1',
  token: 'token-1',
  pcName: 'PC-A',
  deviceName: 'Phone',
  platform: 'other',
  protocolVersion: 5,
}

function createClient(sessions: readonly MobileSessionSummary[]) {
  const inboxStore = new Store({ sessions, seq: 1, hasSnapshot: true })
  const socketStore = new Store<'connected'>('connected')
  const diagnosisStore = new Store<undefined>(undefined)
  return {
    getInboxStore: () => inboxStore,
    getSocketStateStore: () => socketStore,
    getConnectionDiagnosisStore: () => diagnosisStore,
    listWorkspaces: vi.fn(async () => []),
    retryDiagnosis: vi.fn(),
    retryConnection: vi.fn(),
    closeSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  } as unknown as MobileClient
}

function renderPage(client: MobileClient): void {
  render(
    <InboxPage
      client={client}
      credentials={credentials}
      onDismissNotice={vi.fn()}
      onNotice={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenSessions={vi.fn()}
      onNewSession={vi.fn()}
      onUnpair={vi.fn()}
    />,
  )
}

function swipeRow(): void {
  const row = screen.getByTestId('inbox-session-row')
  fireEvent.pointerDown(row, { clientX: 240, clientY: 20, button: 0, pointerId: 1 })
  fireEvent.pointerMove(row, { clientX: 100, clientY: 22, pointerId: 1 })
  fireEvent.pointerUp(row, { clientX: 100, clientY: 22, pointerId: 1 })
}

describe('InboxPage session confirmations', () => {
  it('confirms removal from the swipe action by default', () => {
    const client = createClient([sessionSummary('s1')])
    renderPage(client)

    swipeRow()
    fireEvent.click(screen.getByTestId('inbox-session-remove-action'))

    expect(screen.getByTestId('inbox-session-remove-sheet')).toBeTruthy()
    expect(client.deleteSession).not.toHaveBeenCalled()
  })

  it('removes directly from the swipe action once the preference is off', async () => {
    setSessionRemoveConfirmEnabled(false)
    const client = createClient([sessionSummary('s1')])
    renderPage(client)

    swipeRow()
    fireEvent.click(screen.getByTestId('inbox-session-remove-action'))

    expect(screen.queryByTestId('inbox-session-remove-sheet')).toBeNull()
    await waitFor(() =>
      expect(client.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' })),
    )
  })

  it('closes a working session directly from the swipe action once the preference is off', async () => {
    setSessionCloseConfirmEnabled(false)
    const client = createClient([sessionSummary('s1')])
    renderPage(client)

    swipeRow()
    fireEvent.click(screen.getByTestId('inbox-session-close-action'))

    expect(screen.queryByTestId('inbox-session-close-sheet')).toBeNull()
    await waitFor(() =>
      expect(client.closeSession).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' })),
    )
  })
})
