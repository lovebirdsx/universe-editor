/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard navigation for the Git Graph editor: the scroll container is
 *  focusable, ArrowUp/ArrowDown/Home/End/PageUp/PageDown move the selection
 *  through the same entry point as mouse clicks (so the Commit Changes bridge
 *  and latest-wins sequencing still apply), and the ContextMenu key / Shift+F10
 *  (with Ctrl+Enter as an alias) opens the row's context menu — disambiguating
 *  through a QuickPick when the row carries several menu targets (commit +
 *  branch/tag/…). The menu itself is fully keyboard-operable (arrows move, Enter
 *  runs, Escape closes) and navigates by virtual focus, so the graph keeps DOM
 *  focus throughout.
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
import {
  FocusCommitChangesAction,
  ShowCommitChangesAction,
} from '../../../actions/commitChangesActions.js'
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
  // Several macro rounds: the storage-read → restore-decision →
  // default-selection → payload-fetch chain schedules one React render per
  // step, and each render is flushed on its own macrotask.
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
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

/** Label of the virtually focused row (`data-active`), if any. */
function activeLabel(): string | undefined {
  return document.querySelector('[role="menuitem"][data-active]')?.textContent ?? undefined
}

describe('GitGraphEditor keyboard navigation', () => {
  it('selects the first row on open and shows its changes', async () => {
    const { executeCommand } = renderEditor()
    await flush()

    // No arrow key needed: the first row is selected right after the load.
    expect(gitGraphViewState.selection).toEqual([HASH_A])
    expect(bridgeCalls(executeCommand)).toHaveLength(1)
  })

  it('ArrowDown/ArrowUp move the selection between rows', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_B])

    fireEvent.keyDown(body, { key: 'ArrowUp' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_A])
    // Every move goes through the selection bridge (default + 2 moves).
    expect(bridgeCalls(executeCommand)).toHaveLength(3)
  })

  it('the uncommitted node is skipped: the first commit is selected on open', async () => {
    const { container, executeCommand } = renderEditor(true)
    await flush()

    expect(gitGraphViewState.selection).toEqual([HASH_A])
    expect(bridgeCalls(executeCommand)).toHaveLength(1)

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(gitGraphViewState.selection).toEqual([HASH_B])
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
    expect(gitGraphViewState.selection).toEqual([HASH_A])
  })
})

describe('GitGraphEditor Enter focuses Commit Changes', () => {
  it('plain Enter on the selected row runs the focus command without opening the menu', async () => {
    const { container, executeCommand, pick } = renderEditor()
    await flush()

    // The first row is already selected on open — Enter acts on it directly.
    fireEvent.keyDown(scrollBody(container), { key: 'Enter' })
    await flush()

    expect(executeCommand).toHaveBeenCalledWith(FocusCommitChangesAction.ID)
    expect(openMenu()).toBeNull()
    expect(pick).not.toHaveBeenCalled()
  })

  it('Enter with no selection bubbles up untouched', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    // Clicking the selected row again deselects it.
    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)
    await flush()
    expect(gitGraphViewState.selection).toEqual([])

    const notPrevented = fireEvent.keyDown(scrollBody(container), { key: 'Enter' })
    expect(notPrevented).toBe(true)
    expect(executeCommand).not.toHaveBeenCalledWith(FocusCommitChangesAction.ID)
  })
})

describe('GitGraphEditor Ctrl+Enter context menu', () => {
  it('opens the commit menu directly when the row has a single menu target', async () => {
    const { container, pick } = renderEditor()
    await flush()

    // The open-selected first row is the menu target.
    fireEvent.keyDown(scrollBody(container), { key: 'Enter', ctrlKey: true })
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

    fireEvent.keyDown(scrollBody(container), { key: 'Enter', ctrlKey: true })
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

    fireEvent.keyDown(scrollBody(container), { key: 'Enter', ctrlKey: true })
    await flush()

    const items = pick.mock.calls[0]![0]
    items[0]!.context.open()
    await flush()
    expect(menuLabels()).toContain('Cherry-pick…')
    // Menu opened from the pick is keyboard-driven too: first row highlighted,
    // and it never grabs DOM focus (navigation is virtual).
    expect(activeLabel()).toBe('Checkout this commit…')
    expect(document.activeElement).not.toBe(openMenu())
  })
})

describe('GitGraphContextMenu opening', () => {
  // A real browser dispatches keydown to document.activeElement, so the whole
  // flow is driven through it (instead of aiming fireEvent at a known node) —
  // that is what makes a broken raise path observable.
  function pressKey(key: string, init: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init })
  }

  it('the ContextMenu key opens the menu with the first row highlighted', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    body.focus()
    // The first row is already selected on open.
    expect(gitGraphViewState.selection).toEqual([HASH_A])

    pressKey('ContextMenu')
    await flush()

    expect(openMenu()).not.toBeNull()
    expect(activeLabel()).toBe('Checkout this commit…')
  })

  it('Shift+F10 opens the menu as well', async () => {
    const { container } = renderEditor()
    await flush()

    scrollBody(container).focus()
    pressKey('F10', { shiftKey: true })
    await flush()

    expect(openMenu()).not.toBeNull()
    expect(activeLabel()).toBe('Checkout this commit…')
  })

  it('Ctrl+Enter stays as an alias', async () => {
    const { container } = renderEditor()
    await flush()

    scrollBody(container).focus()
    pressKey('Enter', { ctrlKey: true })
    await flush()

    expect(openMenu()).not.toBeNull()
    expect(activeLabel()).toBe('Checkout this commit…')
  })

  it('the graph keeps DOM focus; arrows operate the menu, not the graph', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    body.focus()
    pressKey('ContextMenu')
    await flush()

    // Virtual focus: the menu drives the keyboard while the graph keeps its own
    // focus ring and selection — that is the point of the shared menu layer.
    expect(document.activeElement).toBe(body)

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(activeLabel()).toBe('Cherry-pick…')
    expect(gitGraphViewState.selection).toEqual([HASH_A])
  })

  it('a mouse right-click opens the menu with no row highlighted', async () => {
    const { container } = renderEditor()
    await flush()

    const row = container.querySelector(`[data-hash="${HASH_A}"]`)!
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 })
    await flush()

    expect(openMenu()).not.toBeNull()
    expect(activeLabel()).toBeUndefined()
  })
})

describe('GitGraphContextMenu keyboard operation', () => {
  function openRowMenu(container: HTMLElement): void {
    scrollBody(container).focus()
    fireEvent.keyDown(scrollBody(container), { key: 'ContextMenu' })
  }

  it('arrows move the highlight and Enter runs the item', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    openRowMenu(container)
    await flush()
    expect(activeLabel()).toBe('Checkout this commit…')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(activeLabel()).toBe('Cherry-pick…')

    fireEvent.keyDown(window, { key: 'Enter' })
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.cherrypick, HASH_A)
    // The menu closed after running the item.
    expect(openMenu()).toBeNull()
  })

  it('ArrowUp/Down skip separators and wrap around', async () => {
    const { container } = renderEditor()
    await flush()

    openRowMenu(container)
    await flush()

    const labels = menuLabels()
    // ArrowUp from the first item wraps to the last (skipping separators).
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(activeLabel()).toBe(labels[labels.length - 1])
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(activeLabel()).toBe(labels[0])
  })

  it('Escape closes the menu', async () => {
    const { container } = renderEditor()
    await flush()

    openRowMenu(container)
    await flush()
    expect(openMenu()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(openMenu()).toBeNull()
  })
})
