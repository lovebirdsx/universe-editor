import {
  parentWorkspaceRelativePath,
  type MobileAgentCandidate,
  type MobileDirectoryListing,
  type MobileWorkspaceCandidate,
} from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function makeListing(relativePath: string, entries: readonly string[]): MobileDirectoryListing {
  return {
    relativePath,
    ...(relativePath !== ''
      ? { parentRelativePath: parentWorkspaceRelativePath(relativePath) ?? '' }
      : {}),
    entries: entries.map((name) => ({
      name,
      relativePath: relativePath === '' ? name : `${relativePath}/${name}`,
    })),
  }
}

function createClient(
  options: {
    readonly online?: boolean
    readonly agents?: MobileAgentCandidate[]
    readonly workspaces?: MobileWorkspaceCandidate[]
    readonly createError?: { readonly code: string }
    readonly listDirectory?: (relativePath: string) => MobileDirectoryListing
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
  const listDirectory = vi.fn(
    async (_workspace: unknown, relativePath?: string): Promise<MobileDirectoryListing> =>
      options.listDirectory?.(relativePath ?? '') ?? makeListing(relativePath ?? '', []),
  )
  const client: NewSessionClient = {
    getSocketStateStore: () => socketState,
    listAgents: vi.fn(async () => options.agents ?? agents),
    listWorkspaces: vi.fn(async () => options.workspaces ?? workspaces),
    listDirectory,
    newSession,
  }
  return { client, newSession, listDirectory, socketState }
}

function directoryEntry(relativePath: string): HTMLElement {
  const entry = screen
    .getAllByTestId('new-session-directory-entry')
    .find((element) => element.getAttribute('data-relative-path') === relativePath)
  if (entry === undefined) throw new Error(`missing directory entry: ${relativePath}`)
  return entry
}

function workspaceOption(folder: string): HTMLElement {
  const option = screen
    .getAllByTestId('new-session-workspace')
    .find((element) => element.getAttribute('data-folder') === folder)
  if (option === undefined) throw new Error(`missing workspace option: ${folder}`)
  return option
}

async function renderLoaded(client: NewSessionClient): Promise<void> {
  render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={vi.fn()} />)
  await waitFor(() => expect(screen.getByTestId('new-session-agent-trigger')).toBeTruthy())
}

describe('NewSessionPage', () => {
  it('shows summary rows with the defaults and creates a session', async () => {
    const { client, newSession } = createClient()
    const onCreated = vi.fn()
    render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={onCreated} />)

    await waitFor(() => expect(screen.getByTestId('new-session-agent-trigger')).toBeTruthy())
    expect(screen.getByTestId('new-session-agent-trigger').textContent).toContain('Echo')
    const workspaceTrigger = screen.getByTestId('new-session-workspace-trigger')
    expect(workspaceTrigger.textContent).toContain('open')
    expect(workspaceTrigger.textContent).toContain(strings.newSessionWorkspaceOpen)
    expect(screen.queryByTestId('new-session-agent')).toBeNull()
    expect(screen.queryByTestId('new-session-workspace')).toBeNull()

    fireEvent.click(screen.getByTestId('new-session-submit'))

    await waitFor(() => expect(newSession).toHaveBeenCalledWith('echo', { folder: 'file:///open' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('1:s9'))
  })

  it('replaces the new-session entry so back returns to the inbox', async () => {
    const { client } = createClient()
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const pushState = vi.spyOn(window.history, 'pushState')
    try {
      render(<NewSessionPage client={client} onBack={vi.fn()} onCreated={vi.fn()} />)
      await waitFor(() => expect(screen.getByTestId('new-session-submit')).toBeTruthy())

      fireEvent.click(screen.getByTestId('new-session-submit'))

      await waitFor(() => expect(replaceState).toHaveBeenCalledTimes(1))
      expect(replaceState.mock.calls[0]?.[2]).toBe('/s/1%3As9')
      expect(pushState).not.toHaveBeenCalled()
    } finally {
      replaceState.mockRestore()
      pushState.mockRestore()
    }
  })

  it('picks an agent from the overlay sheet and closes it', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-agent-trigger'))
    expect(screen.getByTestId('new-session-agent-sheet')).toBeTruthy()

    fireEvent.click(screen.getByText('Claude'))

    expect(screen.queryByTestId('new-session-agent-sheet')).toBeNull()
    expect(screen.getByTestId('new-session-agent-trigger').textContent).toContain('Claude')
  })

  it('passes the chosen agent and workspace', async () => {
    const { client, newSession } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-agent-trigger'))
    fireEvent.click(screen.getByText('Claude'))
    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.click(screen.getByText('recent'))
    fireEvent.click(screen.getByTestId('new-session-submit'))

    await waitFor(() =>
      expect(newSession).toHaveBeenCalledWith('claude', { folder: 'file:///recent' }),
    )
  })

  it('warns before opening a workspace that is not open on the PC', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    expect(screen.queryByTestId('new-session-open-hint')).toBeNull()

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.click(screen.getByText('recent'))

    expect(screen.getByTestId('new-session-open-hint').textContent).toContain(
      strings.newSessionWorkspaceWillOpen,
    )
  })

  it('filters workspaces by name and folder path case-insensitively', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    const search = screen.getByTestId('new-session-workspace-search')

    fireEvent.change(search, { target: { value: 'BUILD-HOST' } })
    expect(
      screen.getAllByTestId('new-session-workspace').map((el) => el.getAttribute('data-folder')),
    ).toEqual(['remote-ssh://build-host/work'])
    expect(screen.getByTestId('new-session-workspace-group-open')).toBeTruthy()
    expect(screen.queryByTestId('new-session-workspace-group-recent')).toBeNull()

    fireEvent.change(search, { target: { value: 'recent' } })
    expect(
      screen.getAllByTestId('new-session-workspace').map((el) => el.getAttribute('data-folder')),
    ).toEqual(['file:///recent'])
    expect(screen.queryByTestId('new-session-workspace-group-open')).toBeNull()
    expect(screen.getByTestId('new-session-workspace-group-recent')).toBeTruthy()
  })

  it('shows an empty state when no workspace matches the search', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.change(screen.getByTestId('new-session-workspace-search'), {
      target: { value: 'zzz' },
    })

    expect(screen.getByTestId('new-session-workspace-empty').textContent).toContain(
      strings.newSessionNoMatch,
    )
    expect(screen.queryAllByTestId('new-session-workspace')).toHaveLength(0)
  })

  it('groups open workspaces above recent ones and marks the current selection', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))

    expect(
      screen.getAllByTestId('new-session-workspace').map((el) => el.getAttribute('data-folder')),
    ).toEqual(['file:///open', 'remote-ssh://build-host/work', 'file:///recent'])
    expect(workspaceOption('file:///open').getAttribute('aria-selected')).toBe('true')
    expect(workspaceOption('file:///recent').getAttribute('aria-selected')).toBe('false')
  })

  it('marks workspaces with uncommitted changes', async () => {
    const { client } = createClient({
      workspaces: [
        { folder: 'file:///dirty', name: 'dirty', isOpen: true, gitDirty: true },
        { folder: 'file:///clean', name: 'clean', isOpen: true, gitDirty: false },
      ],
    })
    await renderLoaded(client)

    expect(screen.getByTestId('new-session-workspace-trigger').textContent).toContain(
      strings.badgeWorkspaceDirty,
    )

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    expect(workspaceOption('file:///dirty').textContent).toContain(strings.badgeWorkspaceDirty)
    expect(workspaceOption('file:///clean').textContent).not.toContain(strings.badgeWorkspaceDirty)
  })

  it('keeps the server order of recent workspaces (newest first)', async () => {
    const { client } = createClient({
      workspaces: [
        { folder: 'file:///zeta', name: 'zeta', isOpen: false },
        { folder: 'file:///open', name: 'open', isOpen: true },
        { folder: 'file:///alpha', name: 'alpha', isOpen: false },
      ],
    })
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))

    expect(
      screen.getAllByTestId('new-session-workspace').map((el) => el.getAttribute('data-folder')),
    ).toEqual(['file:///open', 'file:///zeta', 'file:///alpha'])
  })

  it('closes the picker when the current option is tapped', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.click(workspaceOption('file:///open'))

    expect(screen.queryByTestId('new-session-workspace-sheet')).toBeNull()
  })

  it('dismisses the picker with Escape', async () => {
    const { client } = createClient()
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-agent-trigger'))
    expect(screen.getByTestId('new-session-agent-sheet')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByTestId('new-session-agent-sheet')).toBeNull()
  })

  it('maps workspace_not_open to a Chinese error', async () => {
    const { client } = createClient({ createError: { code: 'workspace_not_open' } })
    await renderLoaded(client)

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

  it('disables the pickers when the connection drops', async () => {
    const { client, socketState } = createClient()
    await renderLoaded(client)

    act(() => socketState.setState('reconnecting'))

    await waitFor(() => {
      expect((screen.getByTestId('new-session-agent-trigger') as HTMLButtonElement).disabled).toBe(
        true,
      )
      expect(
        (screen.getByTestId('new-session-workspace-trigger') as HTMLButtonElement).disabled,
      ).toBe(true)
      expect((screen.getByTestId('new-session-submit') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('falls back to another workspace when the selected one disappears after a reload', async () => {
    const first = createClient()
    const { rerender } = render(
      <NewSessionPage client={first.client} onBack={vi.fn()} onCreated={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByTestId('new-session-workspace-trigger')).toBeTruthy())

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.click(screen.getByText('recent'))
    expect(screen.getByTestId('new-session-workspace-trigger').textContent).toContain('recent')

    const second = createClient({
      workspaces: [{ folder: 'file:///other', name: 'other', isOpen: true }],
    })
    rerender(<NewSessionPage client={second.client} onBack={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByTestId('new-session-workspace-trigger').textContent).toContain('other'),
    )

    fireEvent.click(screen.getByTestId('new-session-submit'))
    await waitFor(() =>
      expect(second.newSession).toHaveBeenCalledWith('echo', { folder: 'file:///other' }),
    )
  })

  it('creates the session in the chosen workspace subdirectory', async () => {
    const { client, newSession, listDirectory } = createClient({
      listDirectory: (relativePath) => {
        if (relativePath === '') return makeListing('', ['packages', 'src'])
        if (relativePath === 'packages') return makeListing('packages', ['demo'])
        return makeListing(relativePath, [])
      },
    })
    await renderLoaded(client)

    expect(screen.getByTestId('new-session-directory-trigger').textContent).toContain(
      strings.newSessionDirectoryRoot,
    )
    fireEvent.click(screen.getByTestId('new-session-directory-trigger'))
    await waitFor(() => expect(directoryEntry('packages')).toBeTruthy())
    expect(listDirectory).toHaveBeenCalledWith({ folder: 'file:///open' }, undefined)

    fireEvent.click(directoryEntry('packages'))
    await waitFor(() =>
      expect(listDirectory).toHaveBeenCalledWith({ folder: 'file:///open' }, 'packages'),
    )
    await waitFor(() => expect(directoryEntry('packages/demo')).toBeTruthy())

    fireEvent.click(screen.getByTestId('new-session-directory-select'))
    expect(screen.queryByTestId('new-session-directory-sheet')).toBeNull()
    expect(screen.getByTestId('new-session-directory-trigger').textContent).toContain('packages')

    fireEvent.click(screen.getByTestId('new-session-submit'))
    await waitFor(() =>
      expect(newSession).toHaveBeenCalledWith('echo', {
        folder: 'file:///open',
        relativePath: 'packages',
      }),
    )
  })

  it('resets the chosen directory when the workspace changes', async () => {
    const { client } = createClient({
      listDirectory: (relativePath) =>
        relativePath === '' ? makeListing('', ['packages']) : makeListing(relativePath, []),
    })
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-directory-trigger'))
    await waitFor(() => expect(directoryEntry('packages')).toBeTruthy())
    fireEvent.click(directoryEntry('packages'))
    await waitFor(() =>
      expect(
        (screen.getByTestId('new-session-directory-select') as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByTestId('new-session-directory-select'))
    expect(screen.getByTestId('new-session-directory-trigger').textContent).toContain('packages')

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.click(screen.getByText('recent'))

    expect(screen.getByTestId('new-session-directory-trigger').textContent).toContain(
      strings.newSessionDirectoryRoot,
    )
  })

  it('forwards the remote authority while browsing directories', async () => {
    const { client, listDirectory } = createClient({
      listDirectory: (relativePath) => makeListing(relativePath, []),
    })
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-workspace-trigger'))
    fireEvent.click(screen.getByText('work'))
    fireEvent.click(screen.getByTestId('new-session-directory-trigger'))

    await waitFor(() =>
      expect(listDirectory).toHaveBeenCalledWith(
        { folder: 'remote-ssh://build-host/work', authority: 'build-host' },
        undefined,
      ),
    )
  })

  it('explains an invalid chosen directory on submit', async () => {
    const { client } = createClient({
      createError: { code: 'bad_request' },
      listDirectory: (relativePath) =>
        relativePath === '' ? makeListing('', ['packages']) : makeListing(relativePath, []),
    })
    await renderLoaded(client)

    fireEvent.click(screen.getByTestId('new-session-directory-trigger'))
    await waitFor(() => expect(directoryEntry('packages')).toBeTruthy())
    fireEvent.click(directoryEntry('packages'))
    await waitFor(() =>
      expect(
        (screen.getByTestId('new-session-directory-select') as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByTestId('new-session-directory-select'))
    fireEvent.click(screen.getByTestId('new-session-submit'))

    await waitFor(() =>
      expect(screen.getByTestId('new-session-error').textContent).toContain(
        strings.newSessionDirectoryInvalid,
      ),
    )
  })
})
