/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression test for the SCM → Git Graph repo sync. Re-mounting the Git Graph
 *  editor (e.g. switching back to its tab) must NOT trigger a full reload when the
 *  SCM-selected repo already matches the graph's current repo — doing so would
 *  reset the cached selection / scroll / details. See commit 65dd7e9.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
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
  type GitGraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const repoA: GitGraphRepoDto = { root: '/repo/a', name: 'a' }
const repoB: GitGraphRepoDto = { root: '/repo/b', name: 'b' }

const HASH = '1111111111111111111111111111111111111111'

function makeResult(): GitGraphLoadResult {
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
        return makeResult()
      case GitGraphCommands.getRepos:
        return [repoA, repoB]
      default:
        return undefined
    }
  })
  const service: ICommandService = {
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

function makeDialog(): IDialogService {
  return {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed: false }),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService
}

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function renderEditor() {
  const { service: commandService, executeCommand } = makeCommandService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, makeScmService())
  services.set(IDialogService, makeDialog())
  services.set(IStorageService, makeStorage())
  const instantiation = new InstantiationService(services)

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, ...utils }
}

/** Let queued microtasks (effect promises) and a macrotask flush. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.details = null
  gitGraphViewState.compareFiles = null
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

describe('GitGraphEditor SCM repo sync', () => {
  it('does not reload (or clear selection) when re-mounting on the same repo SCM already selected', async () => {
    // Simulate a cached tab being re-activated: state mirrored into the module
    // store, graph already on repoA, SCM also pointing at repoA.
    gitGraphViewState.result = makeResult()
    gitGraphViewState.selection = [HASH]
    gitGraphViewState.repos = [repoA, repoB]
    gitGraphViewState.selectedRepo = repoA.root
    scmViewState.setSelectedRepo(repoA.root)

    const { executeCommand } = renderEditor()
    await flush()

    // The bug: the sync effect calls onSelectRepo → load(), which clears the
    // selection. After the fix it stays put because the SCM repo already matches.
    expect(gitGraphViewState.selection).toEqual([HASH])
    // And no second setRepo beyond the initial repo restore is issued.
    const setRepoCalls = executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.setRepo)
    expect(setRepoCalls.length).toBeLessThanOrEqual(1)
  })

  it('syncs to the SCM-selected repo when it differs from the graph repo', async () => {
    gitGraphViewState.result = makeResult()
    gitGraphViewState.selection = [HASH]
    gitGraphViewState.repos = [repoA, repoB]
    gitGraphViewState.selectedRepo = repoA.root
    scmViewState.setSelectedRepo(repoB.root)

    const { executeCommand } = renderEditor()
    await flush()

    const setRepoCalls = executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.setRepo)
    expect(setRepoCalls.some((c) => c[1] === repoB.root)).toBe(true)
  })

  it('does not double-load on first open when SCM selects the default (first) repo', async () => {
    // First open: nothing cached, graph selectedRepo is null (extension default =
    // the first discovered repo). The SCM view then restores its persisted repo
    // pointing at that same default. The graph must not reload a second time.
    gitGraphViewState.repos = [repoA, repoB]
    scmViewState.setSelectedRepo(repoA.root)

    const { executeCommand } = renderEditor()
    await flush()

    const getCommitsCalls = executeCommand.mock.calls.filter(
      (c) => c[0] === GitGraphCommands.getCommits,
    )
    expect(getCommitsCalls.length).toBe(1)
    // The graph adopts the default repo as its selection without re-targeting it.
    expect(gitGraphViewState.selectedRepo).toBe(repoA.root)
    const setRepoCalls = executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.setRepo)
    expect(setRepoCalls.length).toBe(0)
  })
})
