import type {
  MobileAgentCandidate,
  MobileWorkspaceCandidate,
} from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NewSessionPage, type NewSessionClient } from '../NewSessionPage.js'
import type { SocketState } from '../../socket/mobileSocket.js'
import { Store } from '../../state/store.js'
import { strings } from '../../strings.js'

const agents: MobileAgentCandidate[] = [
  { id: 'echo', name: 'Echo', isDefault: true },
  { id: 'claude', name: 'Claude', isDefault: false },
]

const workspaces: MobileWorkspaceCandidate[] = [
  { folder: 'file:///recent', name: 'recent', isOpen: false },
  { folder: 'file:///open', name: 'open', isOpen: true },
  {
    folder: 'remote-ssh://build-host/work',
    name: 'work',
    authority: 'build-host',
    isOpen: true,
  },
]

function createClient(
  options: {
    readonly online?: boolean
    readonly agents?: MobileAgentCandidate[]
    readonly workspaces?: MobileWorkspaceCandidate[]
    readonly createError?: { readonly code: string }
  } = {},
) {
  const socketState = new Store<SocketState>(
    options.online === false ? 'reconnecting' : 'connected',
  )
  const newSession = vi.fn(async () => {
    if (options.createError !== undefined) {
      throw Object.assign(new Error('failed'), options.createError)
    }
    return { ref: { windowId: 1, localId: 's9' } }
  })
  const client: NewSessionClient = {
    getSocketStateStore: () => socketState,
    listAgents: vi.fn(async () => options.agents ?? agents),
    listWorkspaces: vi.fn(async () => options.workspaces ?? workspaces),
    newSession,
  }
  return { client, newSession, socketState }
}

describe('NewSessionPage', () => {
  it('loads agents / workspaces, preselects the defaults and creates a session', async () => {
    const { client, newSession } = createClient()
    const onCreated = vi.fn()
    render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={onCreated} />)

    await waitFor(() => expect(screen.getByText('Echo')).toBeTruthy())
    expect(screen.getAllByText(strings.newSessionWorkspaceOpen).length).toBeGreaterThan(0)
    expect(screen.getAllByText(strings.newSessionWorkspaceRemote).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('new-session-submit'))

    await waitFor(() =>
      expect(newSession).toHaveBeenCalledWith('echo', { folder: 'file:///open' }, undefined),
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('1:s9'))
  })

  it('passes the chosen agent, workspace and initial prompt', async () => {
    const { client, newSession } = createClient()
    render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Claude')).toBeTruthy())
    fireEvent.click(screen.getByText('Claude'))
    fireEvent.change(screen.getByTestId('new-session-prompt'), {
      target: { value: 'fix the build' },
    })
    fireEvent.click(screen.getByTestId('new-session-submit'))

    await waitFor(() =>
      expect(newSession).toHaveBeenCalledWith(
        'claude',
        { folder: 'file:///open' },
        'fix the build',
      ),
    )
  })

  it('warns before opening a workspace that is not open on the PC', async () => {
    const { client } = createClient()
    render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('recent')).toBeTruthy())
    fireEvent.click(screen.getByText('recent'))
    expect(screen.getByTestId('new-session-open-hint').textContent).toContain(
      strings.newSessionWorkspaceWillOpen,
    )
  })

  it('maps workspace_not_open to a Chinese error', async () => {
    const { client } = createClient({ createError: { code: 'workspace_not_open' } })
    render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Echo')).toBeTruthy())
    fireEvent.click(screen.getByTestId('new-session-submit'))

    await waitFor(() =>
      expect(screen.getByTestId('new-session-error').textContent).toContain('工作区'),
    )
  })

  it('disables submitting while offline', async () => {
    const { client } = createClient({ online: false })
    render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() =>
      expect((screen.getByTestId('new-session-submit') as HTMLButtonElement).disabled).toBe(true),
    )
  })
})
