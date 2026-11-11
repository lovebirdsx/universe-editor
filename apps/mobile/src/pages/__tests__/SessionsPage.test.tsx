import type { MobileSessionHistoryEntry, MobileSessionRef } from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionsPage, type SessionsClient } from '../SessionsPage.js'
import { InboxStore } from '../../state/inboxStore.js'
import { Store } from '../../state/store.js'
import type { SocketState } from '../../socket/mobileSocket.js'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'
import { commandErrorText, strings } from '../../strings.js'

function historyRow(overrides: Partial<MobileSessionHistoryEntry> = {}): MobileSessionHistoryEntry {
  return {
    durableId: 'durable-1',
    windowId: 1,
    agentId: 'echo',
    agentName: 'Echo',
    title: 'Closed session',
    firstPrompt: 'Fix the parser',
    workspaceName: 'demo-workspace',
    createdAt: 1_000,
    lastUsedAt: 2_000,
    ...overrides,
  }
}

interface Harness {
  readonly client: SessionsClient
  readonly inbox: InboxStore
  readonly socketState: Store<SocketState>
  readonly listSessionHistory: ReturnType<typeof vi.fn>
  readonly resumeSession: ReturnType<typeof vi.fn>
  readonly onOpenSessionRef: ReturnType<typeof vi.fn>
}

function createHarness(
  options: {
    readonly history?: readonly MobileSessionHistoryEntry[]
    readonly socket?: SocketState
    readonly historyError?: unknown
  } = {},
): Harness {
  const inbox = new InboxStore()
  const socketState = new Store<SocketState>(options.socket ?? 'connected')
  const onOpenSessionRef = vi.fn()
  const listSessionHistory = vi.fn(async () => {
    if (options.historyError !== undefined) throw options.historyError
    return options.history ?? [historyRow()]
  })
  const resumeSession = vi.fn(async () => ({
    ref: sessionRef('s9', 1, 'durable-1'),
  }))
  const client: SessionsClient = {
    getInboxStore: () => inbox,
    getSocketStateStore: () => socketState,
    listSessionHistory,
    resumeSession,
  }
  return { client, inbox, socketState, listSessionHistory, resumeSession, onOpenSessionRef }
}

function renderPage(harness: Harness, active?: boolean): ReturnType<typeof render> {
  return render(
    <SessionsPage
      client={harness.client}
      active={active}
      onBack={vi.fn()}
      onOpenSessionRef={harness.onOpenSessionRef}
    />,
  )
}

describe('SessionsPage', () => {
  it('merges live inbox rows with history and opens a closed row by resuming it', async () => {
    const harness = createHarness()
    harness.inbox.applySnapshot({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [
        sessionSummary('s1', {
          ref: sessionRef('s1', 1, 'durable-1'),
          title: 'Live session',
          bucket: 'in_progress',
          updatedAt: 3_000,
        }),
      ],
    })
    renderPage(harness)

    await waitFor(() => expect(screen.getAllByTestId('sessions-row')).toHaveLength(1))
    const row = screen.getByTestId('sessions-row')
    expect(row.textContent).toContain('Live session')
    expect(row.textContent).toContain(strings.sessionsLiveBadge)
    fireEvent.click(row)
    expect(harness.onOpenSessionRef).toHaveBeenCalledWith(sessionRef('s1', 1, 'durable-1'))
    expect(harness.resumeSession).not.toHaveBeenCalled()
  })

  it('resumes a history-only row with its window hint and opens the returned ref', async () => {
    const harness = createHarness()
    renderPage(harness)

    await waitFor(() => expect(screen.getByTestId('sessions-row')).toBeTruthy())
    expect(screen.getByTestId('sessions-row').textContent).toContain('Fix the parser')
    fireEvent.click(screen.getByTestId('sessions-row'))

    await waitFor(() =>
      expect(harness.onOpenSessionRef).toHaveBeenCalledWith(sessionRef('s9', 1, 'durable-1')),
    )
    expect(harness.resumeSession).toHaveBeenCalledWith('durable-1', 1, undefined, undefined)
  })

  it('resumes a closed workspace row with its folder and shows the PC-open hint', async () => {
    const folder = 'remote-ssh://devhost/home/dev/project'
    const closed: MobileSessionHistoryEntry = {
      durableId: 'durable-remote',
      agentId: 'echo',
      agentName: 'Echo',
      title: 'Remote session',
      workspaceName: 'remote-project',
      folder,
      authority: 'devhost',
      createdAt: 1_000,
      lastUsedAt: 2_000,
    }
    const harness = createHarness({ history: [closed] })
    renderPage(harness)

    await waitFor(() => expect(screen.getByTestId('sessions-row')).toBeTruthy())
    expect(screen.getByTestId('sessions-row-open-hint').textContent).toContain(
      strings.sessionsWillOpenWorkspace,
    )

    fireEvent.click(screen.getByTestId('sessions-row'))
    await waitFor(() =>
      expect(harness.onOpenSessionRef).toHaveBeenCalledWith(sessionRef('s9', 1, 'durable-1'), {
        folder,
        authority: 'devhost',
      }),
    )
    expect(harness.resumeSession).toHaveBeenCalledWith(
      'durable-remote',
      undefined,
      folder,
      'devhost',
    )
  })

  it('searches and filters rows locally', async () => {
    const harness = createHarness({
      history: [
        historyRow(),
        historyRow({
          durableId: 'durable-2',
          title: 'Rename the parser',
          firstPrompt: 'rename it',
          workspaceName: 'backend',
          lastUsedAt: 4_000,
        }),
      ],
    })
    renderPage(harness)
    await waitFor(() => expect(screen.getAllByTestId('sessions-row')).toHaveLength(2))

    fireEvent.change(screen.getByTestId('sessions-search'), { target: { value: 'backend' } })
    expect(screen.getAllByTestId('sessions-row')).toHaveLength(1)
    expect(screen.getByTestId('sessions-row').textContent).toContain('Rename the parser')

    fireEvent.change(screen.getByTestId('sessions-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('sessions-filter-live'))
    expect(screen.queryAllByTestId('sessions-row')).toHaveLength(0)
    expect(screen.getByTestId('sessions-no-match')).toBeTruthy()

    fireEvent.click(screen.getByTestId('sessions-filter-closed'))
    expect(screen.getAllByTestId('sessions-row')).toHaveLength(2)
  })

  it('waits for the connection before fetching and reloads after it comes back', async () => {
    const harness = createHarness({ socket: 'reconnecting' })
    renderPage(harness)

    expect(screen.getByTestId('sessions-offline')).toBeTruthy()
    expect(harness.listSessionHistory).not.toHaveBeenCalled()

    act(() => harness.socketState.setState('connected'))
    await waitFor(() => expect(screen.getByTestId('sessions-row')).toBeTruthy())
    expect(harness.listSessionHistory).toHaveBeenCalledTimes(1)
  })

  it('shows a retry state when the catalog cannot be read', async () => {
    const harness = createHarness({
      historyError: Object.assign(new Error('failed'), { code: 'timeout' }),
    })
    renderPage(harness)

    await waitFor(() => expect(screen.getByTestId('sessions-error')).toBeTruthy())
    expect(screen.getByTestId('sessions-error').textContent).toContain(strings.sessionRetry)
  })

  it('shows the command error and clears the opening state when resume fails', async () => {
    const harness = createHarness()
    harness.resumeSession.mockRejectedValueOnce(
      Object.assign(new Error('failed'), { code: 'session_not_found' }),
    )
    renderPage(harness)
    await waitFor(() => expect(screen.getByTestId('sessions-row')).toBeTruthy())

    fireEvent.click(screen.getByTestId('sessions-row'))

    await waitFor(() =>
      expect(screen.getByText(commandErrorText('session_not_found'))).toBeTruthy(),
    )
    expect(screen.getByTestId('sessions-row').getAttribute('aria-busy')).toBeNull()
  })

  it('does not navigate when the page unmounts during a resume', async () => {
    const harness = createHarness()
    let release!: (value: { ref: MobileSessionRef }) => void
    harness.resumeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const view = renderPage(harness)
    await waitFor(() => expect(screen.getByTestId('sessions-row')).toBeTruthy())

    fireEvent.click(screen.getByTestId('sessions-row'))
    view.unmount()
    release({ ref: sessionRef('s9', 1, 'durable-1') })
    await waitFor(() => expect(harness.onOpenSessionRef).not.toHaveBeenCalled())
  })

  it('does not fetch while kept mounted behind a session', () => {
    const harness = createHarness()
    renderPage(harness, false)
    expect(harness.listSessionHistory).not.toHaveBeenCalled()
  })

  it('renders and dismisses the page-level notice while inactive', () => {
    const harness = createHarness()
    const onDismissNotice = vi.fn()
    render(
      <SessionsPage
        client={harness.client}
        active={false}
        notice={strings.credentialsInvalid}
        onDismissNotice={onDismissNotice}
        onBack={vi.fn()}
        onOpenSessionRef={harness.onOpenSessionRef}
      />,
    )

    expect(screen.getByText(strings.credentialsInvalid)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: strings.noticeDismiss }))
    expect(onDismissNotice).toHaveBeenCalledTimes(1)
  })
})
