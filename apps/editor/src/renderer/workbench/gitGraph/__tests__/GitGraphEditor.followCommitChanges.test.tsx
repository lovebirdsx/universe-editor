/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the reveal → Commit Changes silent follow: revealing a commit
 *  (the `_workbench.openGitGraph` path) pushes its changes into the Commit
 *  Changes view with `silent: true` when the view is already in use, fetches
 *  nothing while the view is untouched, and never refetches the commit the
 *  view already shows.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  CommandsRegistry,
  Event,
  ICommandService,
  IDialogService,
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
  type ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { commitChangesViewState } from '../../scm/commitChanges/viewState.js'
import { _clearGraphPayloadCacheForTests } from '../../scm/commitChanges/graphPayloadCache.js'
import { ServicesContext } from '../../useService.js'
import { ShowCommitChangesAction } from '../../../actions/commitChangesActions.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const HASH_A = 'b2c4079fd07dfa7c73fee004e5a0736ff4a2dd80'
const HASH_B = 'a1b3079fd07dfa7c73fee004e5a0736ff4a2dd70'
const REPO: GitGraphRepoDto = { root: 'G:/repo/main', name: 'main' }

function makeCommit(hash: string, message: string): GitGraphCommitDto {
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

function makeDetails(hash: string): GitGraphCommitDetailsDto {
  return {
    hash,
    parents: [],
    author: 'tester',
    authorEmail: 't@example.com',
    authorDate: 1700000000,
    committer: 'tester',
    committerEmail: 't@example.com',
    committerDate: 1700000000,
    body: `subject of ${hash.slice(0, 7)}`,
    files: [{ status: 'M', path: 'src/a.ts', oldPath: null }],
  }
}

function makeResult(): GitGraphLoadResult {
  return {
    commits: [makeCommit(HASH_A, 'newer'), makeCommit(HASH_B, 'older')],
    head: HASH_A,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: 0,
  }
}

function existingPayload(commitRef: string, providerId = 'git'): ShowCommitChangesPayload {
  return {
    providerId,
    title: commitRef,
    commitRef,
    openExternalCommand: 'git-graph.openFileDiff',
    files: [],
  }
}

function renderEditor() {
  const executeCommand = vi.fn(async (id: string, arg?: unknown) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return makeResult()
      case GitGraphCommands.getRepos:
        return [REPO]
      case GitGraphCommands.getCommitDetails:
        return makeDetails(arg as string)
      default:
        return undefined
    }
  })
  const openViewContainer = vi.fn()
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
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, openViewContainer, ...utils }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

let graphCommandStub: IDisposable
beforeEach(() => {
  graphCommandStub = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  graphCommandStub.dispose()
  gitGraphViewState.revealCommit = null
  gitGraphViewState.pendingReveal.set(null, undefined)
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  commitChangesViewState._resetForTests()
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

function bridgeCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === ShowCommitChangesAction.ID)
}

function detailFetches(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.getCommitDetails)
}

describe('GitGraphEditor reveal → Commit Changes follow', () => {
  it('silently pushes the revealed commit into an in-use Commit Changes view', async () => {
    commitChangesViewState.show(existingPayload(HASH_A))
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      gitGraphViewState.pendingReveal.set(HASH_B, undefined)
      await flush()
    })

    expect(gitGraphViewState.selection).toEqual([HASH_B])
    const calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(1)
    const payload = calls[0]![1] as Record<string, unknown>
    expect(payload.commitRef).toBe(HASH_B)
    expect(payload.silent).toBe(true)
  })

  it('fetches nothing while the Commit Changes view has never been used', async () => {
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      gitGraphViewState.pendingReveal.set(HASH_B, undefined)
      await flush()
    })

    expect(gitGraphViewState.selection).toEqual([HASH_B])
    expect(detailFetches(executeCommand)).toHaveLength(0)
    expect(bridgeCalls(executeCommand)).toHaveLength(0)
  })

  it('does not refetch the commit the view already shows', async () => {
    commitChangesViewState.show(existingPayload(HASH_B))
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      gitGraphViewState.pendingReveal.set(HASH_B, undefined)
      await flush()
    })

    expect(gitGraphViewState.selection).toEqual([HASH_B])
    expect(detailFetches(executeCommand)).toHaveLength(0)
    expect(bridgeCalls(executeCommand)).toHaveLength(0)
  })

  it('follows when the view shows another provider', async () => {
    commitChangesViewState.show(existingPayload('4521', 'perforce'))
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      gitGraphViewState.pendingReveal.set(HASH_B, undefined)
      await flush()
    })

    const calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(1)
    expect((calls[0]![1] as Record<string, unknown>).commitRef).toBe(HASH_B)
  })
})
