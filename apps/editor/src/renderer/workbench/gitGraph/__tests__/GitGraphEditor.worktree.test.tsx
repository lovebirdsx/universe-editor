/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Worktree badges in the Git Graph editor: a linked worktree is drawn on the
 *  commit its HEAD points at, the currently-open one is marked, and right-clicking
 *  a badge opens a menu whose items depend on whether it is the current / main tree.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  ICommandService,
  IDialogService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphLoadResult,
  type GitGraphWorktreeDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const HASH = '1111111111111111111111111111111111111111'

const mainWt: GitGraphWorktreeDto = {
  path: '/repo',
  name: 'repo',
  branch: 'main',
  isCurrent: true,
  isMain: true,
}
const featureWt: GitGraphWorktreeDto = {
  path: '/repo.worktrees/feature',
  name: 'feature',
  branch: 'feature',
  isCurrent: false,
  isMain: false,
}

function makeResult(worktrees: GitGraphWorktreeDto[]): GitGraphLoadResult {
  return {
    commits: [
      {
        hash: HASH,
        parents: [],
        author: 'tester',
        email: 't@example.com',
        date: 1,
        message: 'first',
        heads: [],
        tags: [],
        remotes: [],
        stash: null,
        worktrees,
      },
    ],
    head: HASH,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: 0,
  }
}

function makeCommandService(): {
  service: ICommandService
  executeCommand: ReturnType<typeof vi.fn>
} {
  const executeCommand = vi.fn(async (id: string) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return gitGraphViewState.result
      case GitGraphCommands.getRepos:
        return []
      default:
        return undefined
    }
  })
  const service = {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: () => ({ dispose: () => {} }),
    onDidExecuteCommand: () => ({ dispose: () => {} }),
  } as unknown as ICommandService
  return { service, executeCommand }
}

function makeScmService(): IScmService {
  return {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService
}

function makeDialog(confirmed: boolean): IDialogService {
  return {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed }),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService
}

function renderEditor(confirmed = true) {
  const { service: commandService, executeCommand } = makeCommandService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, makeScmService())
  services.set(IDialogService, makeDialog(confirmed))
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, ...utils }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

describe('GitGraphEditor worktree badges', () => {
  it('renders a badge per worktree, marking the current one', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    renderEditor()
    await flush()

    expect(screen.getByText('✓ repo')).toBeTruthy()
    expect(screen.getByText('feature')).toBeTruthy()
  })

  it('current worktree menu offers new-window + copy but no open/delete', async () => {
    gitGraphViewState.result = makeResult([mainWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const menu = screen.getByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toContain('Open worktree in new window')
    expect(labels).toContain('Copy worktree path')
    expect(labels).not.toContain('Open worktree')
    expect(labels).not.toContain('Delete worktree…')
  })

  it('non-current worktree menu can open and delete, invoking the right commands', async () => {
    gitGraphViewState.result = makeResult([featureWt])
    const { executeCommand } = renderEditor(true)
    await flush()

    fireEvent.contextMenu(screen.getByText('feature'))
    const menu = screen.getByRole('menu')

    fireEvent.click(within(menu).getByText('Open worktree'))
    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.openWorktree,
      featureWt.path,
      false,
    )

    fireEvent.contextMenu(screen.getByText('feature'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Delete worktree…'))
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.deleteWorktree, featureWt.path)
  })

  it('does not delete when the confirm dialog is dismissed', async () => {
    gitGraphViewState.result = makeResult([featureWt])
    const { executeCommand } = renderEditor(false)
    await flush()

    fireEvent.contextMenu(screen.getByText('feature'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Delete worktree…'))
    await flush()
    expect(executeCommand).not.toHaveBeenCalledWith(GitGraphCommands.deleteWorktree, featureWt.path)
  })
})

describe('GitGraphEditor worktree sync', () => {
  const detachedWt: GitGraphWorktreeDto = {
    path: '/repo.worktrees/wip',
    name: 'wip',
    branch: null,
    isCurrent: false,
    isMain: false,
  }

  it('offers the sync item when the target has a branch and others exist', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toContain('Sync worktrees to main…')
  })

  it('hides the sync item for a detached target', async () => {
    gitGraphViewState.result = makeResult([mainWt, detachedWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('wip'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels.some((l) => l?.startsWith('Sync worktrees'))).toBe(false)
  })

  it('hides the sync item when no other worktree exists', async () => {
    gitGraphViewState.result = makeResult([mainWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels.some((l) => l?.startsWith('Sync worktrees'))).toBe(false)
  })

  it('syncs the picked worktrees to the target branch on confirm', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand } = renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Sync worktrees to main…'))

    // Picker opens preselected with all candidates — confirm immediately.
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByText(/^Sync \(/))
    await flush()

    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.syncWorktrees, 'main', [
      { path: featureWt.path, name: featureWt.name },
    ])
  })

  it('does not sync when the picker is cancelled', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand } = renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Sync worktrees to main…'))
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'))
    await flush()

    expect(executeCommand).not.toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      expect.anything(),
      expect.anything(),
    )
  })

  it('lists the candidate worktrees in alphabetical order', async () => {
    const zebra: GitGraphWorktreeDto = {
      path: '/repo.worktrees/zebra',
      name: 'zebra',
      branch: 'br/zebra',
      isCurrent: false,
      isMain: false,
    }
    const apple: GitGraphWorktreeDto = {
      path: '/repo.worktrees/apple',
      name: 'apple',
      branch: 'br/apple',
      isCurrent: false,
      isMain: false,
    }
    // Feed them out of order; the picker must still render apple before zebra.
    gitGraphViewState.result = makeResult([mainWt, zebra, apple])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Sync worktrees to main…'))

    const dialog = screen.getByRole('dialog')
    const names = within(dialog)
      .getAllByText(/^(apple|zebra)$/)
      .map((el) => el.textContent)
    expect(names).toEqual(['apple', 'zebra'])
  })
})

describe('GitGraphEditor ref overflow folding', () => {
  function makeRefResult(over: Partial<GitGraphLoadResult['commits'][number]>): GitGraphLoadResult {
    return {
      commits: [
        {
          hash: HASH,
          parents: [],
          author: 'tester',
          email: 't@example.com',
          date: 1,
          message: 'first',
          heads: [],
          tags: [],
          remotes: [],
          stash: null,
          worktrees: [],
          ...over,
        },
      ],
      head: HASH,
      headName: 'main',
      moreAvailable: false,
      uncommittedChanges: 0,
    }
  }

  it('shows all refs when they fit within the budget (no overflow badge)', async () => {
    gitGraphViewState.result = makeRefResult({ heads: ['main', 'a', 'b', 'c'] })
    renderEditor()
    await flush()

    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('c')).toBeTruthy()
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('folds refs beyond the budget into a +N badge', async () => {
    gitGraphViewState.result = makeRefResult({ heads: ['main', 'a', 'b', 'c', 'd'] })
    renderEditor()
    await flush()

    // 5 refs > budget → show 3, fold 2.
    expect(screen.getByText('+2')).toBeTruthy()
  })

  it('keeps the HEAD branch visible and folds lower-priority refs', async () => {
    gitGraphViewState.result = makeRefResult({
      heads: ['main', 'a', 'b'],
      tags: [
        { name: 'v1', annotated: false },
        { name: 'v2', annotated: false },
      ],
    })
    renderEditor()
    await flush()

    // HEAD branch (main) outranks tags, so it stays inline; tags fold.
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.queryByText('v1')).toBeNull()
  })

  it('opens a menu listing the folded refs, each dispatching its kind', async () => {
    gitGraphViewState.result = makeRefResult({
      heads: ['main', 'a', 'b'],
      tags: [
        { name: 'v1', annotated: false },
        { name: 'v2', annotated: false },
      ],
    })
    const { executeCommand } = renderEditor()
    await flush()

    fireEvent.click(screen.getByText('+2'))
    const menu = screen.getByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toContain('Tag v1')
    expect(labels).toContain('Tag v2')

    // Picking a folded tag opens that tag's own menu (push-tag dispatches its command).
    fireEvent.click(within(menu).getByText('Tag v1'))
    const tagMenu = screen.getByRole('menu')
    fireEvent.click(within(tagMenu).getByText(/Push tag/))
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.pushTag, 'v1', 'origin')
  })
})
