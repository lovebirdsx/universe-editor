/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard navigation for the Git Graph editor: the scroll container is
 *  focusable, ArrowUp/ArrowDown/Home/End/PageUp/PageDown move the selection
 *  through the same entry point as mouse clicks (so the Commit Changes bridge
 *  and latest-wins sequencing still apply), and Ctrl+Enter opens the row's
 *  context menu — disambiguating through a QuickPick when the row carries
 *  several menu targets (commit + branch/tag/…). The menu itself is fully
 *  keyboard-operable (arrows move, Enter runs, Escape closes).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import {
  CommandsRegistry,
  Event,
  ICommandService,
  IDialogService,
  IQuickInputService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type IDisposable,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphCommitDetailsDto,
  type GitGraphCommitDto,
  type GitGraphLoadResult,
  type GitGraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { _clearGraphPayloadCacheForTests } from '../../scm/commitChanges/graphPayloadCache.js'
import { ServicesContext } from '../../useService.js'
import { ShowCommitChangesAction } from '../../../actions/commitChangesActions.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const HASH_A = 'b2c4079fd07dfa7c73fee004e5a0736ff4a2dd80'
const HASH_B = 'a1b3079fd07dfa7c73fee004e5a0736ff4a2dd70'
const HASH_C = 'c5d5079fd07dfa7c73fee004e5a0736ff4a2dd90'
const REPO: GitGraphRepoDto = { root: 'G:/repo/main', name: 'main' }

function makeCommit(overrides: Partial<GitGraphCommitDto> = {}): GitGraphCommitDto {
  return {
    hash: HASH_A,
    parents: [],
    author: 'tester',
    email: 't@example.com',
    date: 1,
    message: 'change file',
    heads: [],
    tags: [],
    remotes: [],
    stash: null,
    worktrees: [],
    ...overrides,
  }
}

function makeDetails(hash = HASH_A): GitGraphCommitDetailsDto {
  return {
    hash,
    parents: [],
    author: 'tester',
    authorEmail: 't@example.com',
    authorDate: 1700000000,
    committer: 'tester',
    committerEmail: 't@example.com',
    committerDate: 1700000000,
    body: '',
    files: [{ status: 'M', path: 'src/a.ts', oldPath: null }],
  }
}

function makeResult(withUncommitted = false): GitGraphLoadResult {
  return {
    commits: [
      makeCommit(),
      makeCommit({ hash: HASH_B, message: 'older commit' }),
      makeCommit({ hash: HASH_C, message: 'oldest commit' }),
    ],
    head: HASH_A,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: withUncommitted ? 2 : 0,
  }
}

interface PickItem {
  id: string
  label: string
  context: { open: () => void }
}

function renderEditor(withUncommitted = false, overrides: { commits?: GitGraphCommitDto[] } = {}) {
  const executeCommand = vi.fn(async (id: string, arg?: unknown) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return overrides.commits
          ? { ...makeResult(withUncommitted), commits: overrides.commits }
          : makeResult(withUncommitted)
      case GitGraphCommands.getRepos:
        return [REPO]
      case GitGraphCommands.getCommitDetails:
        return makeDetails(arg as string)
      default:
        return undefined
    }
  })
  const openViewContainer = vi.fn()
  const setViewCollapsed = vi.fn()
  const pick = vi.fn(async (_items: readonly PickItem[]) => undefined as PickItem | undefined)
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService)
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed: false }),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: Event.None,
  } as unknown as IStorageService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer,
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed,
  } as unknown as IViewDescriptorService)
  services.set(IQuickInputService, {
    _serviceBrand: undefined,
    pick,
  } as unknown as IQuickInputService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, openViewContainer, setViewCollapsed, pick, ...utils }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let graphCommandStub: IDisposable
beforeEach(() => {
  graphCommandStub = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
})

afterEach(() => {
  graphCommandStub.dispose()
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  gitGraphViewState.searchQuery = ''
  scmViewState.setSelectedRepo(undefined)
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

function scrollBody(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="gitGraph-scrollBody"]')!
}

function bridgeCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === ShowCommitChangesAction.ID)
}

function openMenu(): HTMLElement | null {
  return document.querySelector('[role="menu"]')
}

function menuLabels(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
}

describe('GitGraphEditor keyboard navigation', () => {
  it('ArrowDown with no selection selects the first row and shows its changes', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    fireEvent.keyDown(scrollBody(container), { key: 'ArrowDown' })
    await flush()

    expect(gitGraphViewState.selection).toEqual([HASH_A])
    expect(bridgeCalls(executeCommand)).toHaveLength(1)
  })

  it('ArrowDown/ArrowUp move the selection between rows', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_B])

    fireEvent.keyDown(body, { key: 'ArrowUp' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_A])
    // Every move goes through the selection bridge.
    expect(bridgeCalls(executeCommand)).toHaveLength(3)
  })

  it('ArrowDown from the uncommitted node moves to the first commit', async () => {
    const { container, openViewContainer } = renderEditor(true)
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual(['*'])
    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.scm')

    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_A])
  })

  it('End selects the last loaded row, Home the first', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'End' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_C])

    fireEvent.keyDown(body, { key: 'Home' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_A])
  })

  it('PageDown/PageUp move the selection by the visible row count', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    // Two full rows per "page".
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 48 })
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_A])

    fireEvent.keyDown(body, { key: 'PageDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_C])

    fireEvent.keyDown(body, { key: 'PageUp' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_A])
  })

  it('does not swallow plain character keys', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    const notPrevented = fireEvent.keyDown(body, { key: 'a' })
    expect(notPrevented).toBe(true)
    expect(gitGraphViewState.selection).toEqual([])
  })
})

describe('GitGraphEditor Ctrl+Enter context menu', () => {
  it('opens the commit menu directly when the row has a single menu target', async () => {
    const { container, pick } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    expect(pick).not.toHaveBeenCalled()
    expect(menuLabels()).toContain('Checkout this commit…')
  })

  it('asks via QuickPick when the row carries several menu targets', async () => {
    const { container, pick } = renderEditor(false, {
      commits: [
        makeCommit({
          heads: ['main'],
          tags: [{ name: 'v1.0', annotated: true }],
        }),
        makeCommit({ hash: HASH_B }),
      ],
    })
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    expect(pick).toHaveBeenCalledTimes(1)
    const labels = pick.mock.calls[0]![0].map((i) => i.label)
    expect(labels).toEqual(['Commit b2c4079', 'Branch main', 'Tag v1.0'])
    // Nothing opened yet — the pick is still pending.
    expect(openMenu()).toBeNull()

    // Picking the branch target opens the branch menu.
    const items = pick.mock.calls[0]![0]
    items.find((i) => i.label === 'Branch main')!.context.open()
    await flush()
    expect(menuLabels()).toContain('Copy branch name')
  })

  it('opens the commit menu from the pick when the commit target is chosen', async () => {
    const { container, pick } = renderEditor(false, {
      commits: [makeCommit({ heads: ['main'] }), makeCommit({ hash: HASH_B })],
    })
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    const items = pick.mock.calls[0]![0]
    items[0]!.context.open()
    await flush()
    expect(menuLabels()).toContain('Cherry-pick…')
  })
})

describe('GitGraphContextMenu keyboard operation', () => {
  it('highlights the first item on open, arrows move, Enter runs the item', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    const menu = openMenu()!
    expect(menu).not.toBeNull()
    // First actionable item is highlighted on open.
    expect(menu.querySelector('[data-active]')?.textContent).toBe('Checkout this commit…')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(menu.querySelector('[data-active]')?.textContent).toBe('Cherry-pick…')

    fireEvent.keyDown(menu, { key: 'Enter' })
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.cherrypick, HASH_A)
    // The menu closed after running the item.
    expect(openMenu()).toBeNull()
  })

  it('ArrowUp/Down skip separators and wrap around', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    const menu = openMenu()!
    const labels = menuLabels()
    // ArrowUp from the first item wraps to the last (skipping separators).
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(menu.querySelector('[data-active]')?.textContent).toBe(labels[labels.length - 1])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(menu.querySelector('[data-active]')?.textContent).toBe(labels[0])
  })

  it('Escape closes the menu', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()
    expect(openMenu()).not.toBeNull()

    fireEvent.keyDown(openMenu()!, { key: 'Escape' })
    await flush()
    expect(openMenu()).toBeNull()
  })
})
