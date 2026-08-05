/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the reveal bridge (`_workbench.openGitGraph` → viewState):
 *  an already-loaded commit is selected in place; an unloaded one pages in
 *  older history (bounded by the reveal page cap); a reveal requested while
 *  the tab was unmounted is consumed from pendingReveal after the first load.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  CommandsRegistry,
  ICommandService,
  IDialogService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphCommitDto,
  type GitGraphLoadResult,
  type GitGraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../../scm/scmViewState.js'
import {
  GIT_GRAPH_PAGE_SIZE,
  gitGraphViewState,
} from '../../../services/gitGraph/gitGraphViewState.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const PAGE1_HASH = '1111111111111111111111111111111111111111'
const PAGE2_HASH = '2222222222222222222222222222222222222222'
const MISSING_HASH = 'ffffffffffffffffffffffffffffffffffffffff'

function commit(hash: string, message: string): GitGraphCommitDto {
  return {
    hash,
    parents: [],
    author: 'tester',
    email: 't@example.com',
    date: 1,
    message,
    heads: [],
    tags: [],
    remotes: [],
    stash: null,
    worktrees: [],
  }
}

function resultWith(commits: GitGraphCommitDto[], moreAvailable: boolean): GitGraphLoadResult {
  return {
    commits,
    head: commits[0]?.hash ?? null,
    headName: 'main',
    moreAvailable,
    uncommittedChanges: 0,
  }
}

function renderEditor(
  getCommits: (options: { maxCommits?: number }) => GitGraphLoadResult | undefined,
) {
  const executeCommand = vi.fn(async (id: string, arg?: { maxCommits?: number }) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return getCommits(arg ?? {})
      case GitGraphCommands.getRepos:
        return [{ root: '/repo', name: 'repo' }] as GitGraphRepoDto[]
      default:
        return undefined
    }
  })
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: () => ({ dispose: () => {} }),
    onDidExecuteCommand: () => ({ dispose: () => {} }),
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
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, ...utils }
}

// Wrapped in act: exiting act flushes React's passive effects, which is what
// re-registers viewState.revealCommit with a fresh result/limit closure after
// the initial load (a bare setTimeout flush races the scheduler).
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function resetViewState(): void {
  gitGraphViewState.revealCommit = null
  gitGraphViewState.pendingReveal = null
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.details = null
  gitGraphViewState.compareFiles = null
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  gitGraphViewState.searchQuery = ''
  gitGraphViewState.limit = GIT_GRAPH_PAGE_SIZE
}

let scrollIntoViewSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoViewSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoViewSpy
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

afterEach(() => {
  resetViewState()
  scmViewState.setSelectedRepo(undefined)
  vi.restoreAllMocks()
})

describe('GitGraphEditor reveal', () => {
  it('selects an already-loaded commit in place without paging', async () => {
    const gate = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
    try {
      const { executeCommand } = renderEditor(() =>
        resultWith([commit(PAGE1_HASH, 'first')], false),
      )
      await flush()

      await act(async () => {
        gitGraphViewState.revealCommit?.(PAGE1_HASH)
        await flush()
      })

      expect(gitGraphViewState.selection).toEqual([PAGE1_HASH])
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'center' })
      const getCommitsCalls = executeCommand.mock.calls.filter(
        (c) => c[0] === GitGraphCommands.getCommits,
      )
      // Initial load only — no extra pages were pulled for the reveal.
      expect(
        getCommitsCalls.every(
          (c) => (c[1] as { maxCommits?: number })?.maxCommits === GIT_GRAPH_PAGE_SIZE,
        ),
      ).toBe(true)
    } finally {
      gate.dispose()
    }
  })

  it('pages in older history with a growing maxCommits until the commit is loaded', async () => {
    const gate = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
    try {
      const { executeCommand } = renderEditor((options) =>
        (options.maxCommits ?? 0) > GIT_GRAPH_PAGE_SIZE
          ? resultWith([commit(PAGE1_HASH, 'first'), commit(PAGE2_HASH, 'older')], true)
          : resultWith([commit(PAGE1_HASH, 'first')], true),
      )
      await flush()

      await act(async () => {
        gitGraphViewState.revealCommit?.(PAGE2_HASH)
        await flush()
      })

      expect(gitGraphViewState.selection).toEqual([PAGE2_HASH])
      expect(gitGraphViewState.limit).toBe(GIT_GRAPH_PAGE_SIZE * 2)
      const pagedLimits = executeCommand.mock.calls
        .filter((c) => c[0] === GitGraphCommands.getCommits)
        .map((c) => (c[1] as { maxCommits?: number })?.maxCommits)
      expect(pagedLimits).toContain(GIT_GRAPH_PAGE_SIZE * 2)
    } finally {
      gate.dispose()
    }
  })

  it('stops paging at the reveal page cap and leaves the selection untouched', async () => {
    const gate = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
    try {
      const { executeCommand } = renderEditor(() => resultWith([commit(PAGE1_HASH, 'first')], true))
      await flush()

      await act(async () => {
        gitGraphViewState.revealCommit?.(MISSING_HASH)
        await flush()
      })

      expect(gitGraphViewState.selection).toEqual([])
      const pagedLimits = executeCommand.mock.calls
        .filter((c) => c[0] === GitGraphCommands.getCommits)
        .map((c) => (c[1] as { maxCommits?: number })?.maxCommits)
        .filter((n): n is number => typeof n === 'number' && n > GIT_GRAPH_PAGE_SIZE)
      expect(pagedLimits).toHaveLength(20)
      expect(Math.max(...pagedLimits)).toBe(GIT_GRAPH_PAGE_SIZE * 21)
    } finally {
      gate.dispose()
    }
  })

  it('consumes pendingReveal once the mounted editor finishes its first load', async () => {
    const gate = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
    try {
      gitGraphViewState.pendingReveal = PAGE1_HASH
      renderEditor(() => resultWith([commit(PAGE1_HASH, 'first')], false))
      await flush()
      await act(async () => {
        await flush()
      })

      expect(gitGraphViewState.pendingReveal).toBeNull()
      expect(gitGraphViewState.selection).toEqual([PAGE1_HASH])
    } finally {
      gate.dispose()
    }
  })
})
