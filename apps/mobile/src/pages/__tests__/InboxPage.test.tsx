import type {
  MobileDeliveryDetail,
  MobileDeliveryPreview,
  MobileDeliverySummary,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
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

function deliverySummary(overrides: Partial<MobileDeliverySummary> = {}): MobileDeliverySummary {
  return {
    deliveryId: 'd-1',
    phase: 'awaiting_push',
    commitCount: 1,
    dirtySource: false,
    mainBranch: 'main',
    updatedAt: 2_000,
    canConfirmPush: true,
    canRetry: false,
    canUndo: true,
    sync: { synced: 0, upToDate: 0, skipped: 0, failed: 0 },
    ...overrides,
  }
}

const commit = {
  sha: 'abc12345',
  shortSha: 'abc12345',
  subject: 'feat: deliver this',
  author: 'testuser',
  authoredAt: '2026-01-01T00:00:00.000Z',
}

const previewFixture: MobileDeliveryPreview = {
  source: {
    worktreeName: 'feature',
    head: 'abc12345',
    dirty: false,
    changedFileCount: 0,
    untrackedCount: 0,
    isMainWorktree: false,
  },
  target: {
    mainWorktreeName: 'main',
    mainBranch: 'main',
    remote: 'origin',
    remoteBranch: 'main',
    upstreamRef: 'origin/main',
    baseSha: 'base1234',
    mainHead: 'main1234',
    upstreamHead: 'main1234',
    aheadOfUpstream: 0,
  },
  commits: [commit],
  blockers: [],
  warnings: [],
  forkSupported: true,
  expectation: {
    mainHead: 'main1234',
    mainBranch: 'main',
    targetBranch: 'main',
    remote: 'origin',
    remoteBranch: 'main',
    upstreamRef: 'origin/main',
    upstreamHead: 'main1234',
    sourceHead: 'abc12345',
    baseSha: 'base1234',
    commits: ['abc12345'],
  },
}

const detailFixture: MobileDeliveryDetail = {
  summary: deliverySummary(),
  source: { worktreeName: 'feature', head: 'abc12345', dirty: false },
  target: {
    mainWorktreeName: 'main',
    mainBranch: 'main',
    remote: 'origin',
    remoteBranch: 'main',
    upstreamRef: 'origin/main',
    baseSha: 'base1234',
    mainHead: 'main1234',
  },
  commits: [commit],
  conflictFiles: [],
  syncResults: [],
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
    previewDelivery: vi.fn(async () => previewFixture),
    startDelivery: vi.fn(async () => ({ deliveryId: 'd-1' })),
    getDelivery: vi.fn(async () => detailFixture),
    confirmDeliveryPush: vi.fn(async () => {}),
    retryDelivery: vi.fn(async () => {}),
    undoDelivery: vi.fn(async () => {}),
    openDeliveryMainWorktree: vi.fn(async () => {}),
  } as unknown as MobileClient
}

function renderPage(client: MobileClient, onOpenSession = vi.fn()): void {
  render(
    <InboxPage
      client={client}
      credentials={credentials}
      onDismissNotice={vi.fn()}
      onNotice={vi.fn()}
      onOpenSession={onOpenSession}
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

describe('InboxPage delivery', () => {
  it('opens the preview sheet from the row without opening the session', async () => {
    const client = createClient([sessionSummary('s1', { deliveryAvailable: true })])
    const onOpenSession = vi.fn()
    renderPage(client, onOpenSession)

    fireEvent.click(screen.getByTestId('inbox-delivery-action'))

    expect(onOpenSession).not.toHaveBeenCalled()
    expect(await screen.findByTestId('delivery-confirm-sheet')).toBeTruthy()
    expect(client.previewDelivery).toHaveBeenCalledWith(expect.objectContaining({ localId: 's1' }))
    expect(await screen.findByTestId('delivery-commits')).toBeTruthy()
  })

  it('opens the detail sheet from an existing delivery badge', async () => {
    const client = createClient([
      sessionSummary('s1', { delivery: deliverySummary(), deliveryAvailable: true }),
    ])
    const onOpenSession = vi.fn()
    renderPage(client, onOpenSession)

    fireEvent.click(screen.getByTestId('inbox-delivery-badge'))

    expect(onOpenSession).not.toHaveBeenCalled()
    expect(await screen.findByTestId('delivery-detail-sheet')).toBeTruthy()
    expect(client.getDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ localId: 's1' }),
      'd-1',
    )
  })

  it('shows the pushable count in the inbox summary bar', () => {
    const client = createClient([
      sessionSummary('s1', { delivery: deliverySummary() }),
      sessionSummary('s2', {
        delivery: deliverySummary({ deliveryId: 'd-2', phase: 'synced', canConfirmPush: false }),
      }),
    ])
    renderPage(client)

    const bar = screen.getByTestId('inbox-delivery-summary')
    expect(bar.textContent).toContain('1 条待推送')
  })
})
