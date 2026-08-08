/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Clicking a commit row pushes the commit's changes into the Commit Changes
 *  sidebar view via the `_workbench.showCommitChanges` bridge; Ctrl/Cmd-clicking
 *  a second row shows the two-commit comparison; clicking the uncommitted node
 *  reveals the SCM main view. Re-clicking the selected row only deselects and
 *  must not touch the sidebar.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
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
  type GitGraphFileChangeDto,
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
    parents: [HASH_B],
    author: 'tester',
    authorEmail: 't@example.com',
    authorDate: 1700000000,
    committer: 'tester',
    committerEmail: 't@example.com',
    committerDate: 1700000000,
    body: 'change file\n\nmore context',
    files: [
      { status: 'M', path: 'src/a.ts', oldPath: null },
      { status: 'R', path: 'src/b.ts', oldPath: 'src/old-b.ts' },
    ],
  }
}

function makeCompareFiles(): GitGraphFileChangeDto[] {
  return [{ status: 'M', path: 'src/a.ts', oldPath: null }]
}

function makeResult(withUncommitted = false): GitGraphLoadResult {
  return {
    commits: [makeCommit(), makeCommit({ hash: HASH_B, message: 'older commit' })],
    head: HASH_A,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: withUncommitted ? 2 : 0,
  }
}

function renderEditor(
  withUncommitted = false,
  overrides: {
    getCommitDetails?: (hash: string) => Promise<GitGraphCommitDetailsDto | null>
  } = {},
) {
  const executeCommand = vi.fn(async (id: string, arg?: unknown) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return makeResult(withUncommitted)
      case GitGraphCommands.getRepos:
        return [REPO]
      case GitGraphCommands.getCommitDetails:
        return overrides.getCommitDetails
          ? overrides.getCommitDetails(arg as string)
          : makeDetails(arg as string)
      case GitGraphCommands.compareCommits:
        return makeCompareFiles()
      default:
        return undefined
    }
  })
  const openViewContainer = vi.fn()
  const setViewCollapsed = vi.fn()
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
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, openViewContainer, setViewCollapsed, ...utils }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

// The editor gates its initial queries on the git-graph commands being
// registered (they arrive asynchronously from the extension host at runtime).
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
  scmViewState.setSelectedRepo(undefined)
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

function bridgeCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === ShowCommitChangesAction.ID)
}

function detailFetches(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.getCommitDetails)
}

describe('GitGraphEditor commit click → Commit Changes view', () => {
  it('shows the clicked commit in the Commit Changes view', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)
    await flush()

    expect(gitGraphViewState.selection).toEqual([HASH_A])
    const calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(1)
    const payload = calls[0]![1] as Record<string, unknown>
    expect(payload.providerId).toBe('git')
    expect(payload.title).toBe('b2c4079 — change file')
    expect(payload.commitRef).toBe(HASH_A)
    expect(payload.openExternalCommand).toBe('git-graph.openFileDiff')
    expect(payload.metadata).toEqual({
      author: 'tester',
      authorDate: 1700000000,
      message: 'change file\n\nmore context',
      parents: [HASH_B],
    })
    const files = payload.files as { path: string; args: Record<string, unknown> }[]
    expect(files).toHaveLength(2)
    expect(files[0]!.args).toEqual({
      root: REPO.root,
      fromHash: HASH_B,
      toHash: HASH_A,
      path: 'src/a.ts',
      status: 'M',
    })
    expect(files[1]!.args.oldPath).toBe('src/old-b.ts')
  })

  it('Ctrl+clicking a second row shows the two-commit comparison', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)
    await flush()
    fireEvent.click(container.querySelector(`[data-hash="${HASH_B}"]`)!, { ctrlKey: true })
    await flush()

    expect(gitGraphViewState.selection).toEqual([HASH_A, HASH_B])
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.compareCommits, HASH_A, HASH_B)
    const calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(2)
    const payload = calls[1]![1] as Record<string, unknown>
    expect(payload.title).toBe('b2c4079 ↔ a1b3079')
    expect(payload.commitRef).toBe(`${HASH_A}..${HASH_B}`)
    expect(payload.metadata).toEqual({ compareRefs: { from: HASH_A, to: HASH_B } })
    const files = payload.files as { args: Record<string, unknown> }[]
    expect(files[0]!.args).toMatchObject({ root: REPO.root, fromHash: HASH_A, toHash: HASH_B })
  })

  it('re-clicking the selected row deselects without touching the sidebar', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    const row = container.querySelector(`[data-hash="${HASH_A}"]`)!
    fireEvent.click(row)
    await flush()
    expect(bridgeCalls(executeCommand)).toHaveLength(1)

    fireEvent.click(row)
    await flush()
    expect(gitGraphViewState.selection).toEqual([])
    expect(bridgeCalls(executeCommand)).toHaveLength(1)
  })

  it('clicking the uncommitted node reveals the SCM main view', async () => {
    const { container, executeCommand, openViewContainer, setViewCollapsed } = renderEditor(true)
    await flush()

    fireEvent.click(container.querySelector('[data-hash="*"]')!)
    await flush()

    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.scm')
    expect(setViewCollapsed).toHaveBeenCalledWith('workbench.view.scm.main', false)
    expect(bridgeCalls(executeCommand)).toHaveLength(0)
  })
})

describe('GitGraphEditor click responsiveness', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('updates the selection immediately, without waiting for the details fetch', async () => {
    const pending = deferred<GitGraphCommitDetailsDto>()
    const { container, executeCommand } = renderEditor(false, {
      getCommitDetails: () => pending.promise,
    })
    await flush()

    // The details fetch never resolves within this assertion window: the
    // selection (and thus the row highlight) must not wait for it.
    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)

    expect(gitGraphViewState.selection).toEqual([HASH_A])
    expect(bridgeCalls(executeCommand)).toHaveLength(0)

    pending.resolve(makeDetails())
    await flush()
    expect(bridgeCalls(executeCommand)).toHaveLength(1)
  })

  it('applies only the latest click when details resolve out of order', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<GitGraphCommitDetailsDto>>>()
    const { container, executeCommand } = renderEditor(false, {
      getCommitDetails: (hash) => {
        const entry = deferred<GitGraphCommitDetailsDto>()
        pending.set(hash, entry)
        return entry.promise
      },
    })
    await flush()

    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)
    fireEvent.click(container.querySelector(`[data-hash="${HASH_B}"]`)!)
    expect(gitGraphViewState.selection).toEqual([HASH_B])
    // Let both detail fetches get issued (they stay pending afterwards).
    await flush()
    expect(detailFetches(executeCommand)).toHaveLength(2)

    // The older click resolves last — it must NOT clobber the newer one.
    pending.get(HASH_B)!.resolve(makeDetails(HASH_B))
    await flush()
    let calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(1)
    expect((calls[0]![1] as Record<string, unknown>).commitRef).toBe(HASH_B)

    pending.get(HASH_A)!.resolve(makeDetails(HASH_A))
    await flush()
    calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(1)
    expect(gitGraphViewState.selection).toEqual([HASH_B])
  })

  it('serves repeat clicks from the payload cache without refetching details', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)
    await flush()
    fireEvent.click(container.querySelector(`[data-hash="${HASH_B}"]`)!)
    await flush()
    expect(detailFetches(executeCommand)).toHaveLength(2)
    expect(bridgeCalls(executeCommand)).toHaveLength(2)

    // Back to the first commit: the payload is cached, so no new details
    // fetch, but the bridge still fires (re-click reveals the view again).
    fireEvent.click(container.querySelector(`[data-hash="${HASH_A}"]`)!)
    await flush()
    expect(detailFetches(executeCommand)).toHaveLength(2)
    const calls = bridgeCalls(executeCommand)
    expect(calls).toHaveLength(3)
    expect((calls[2]![1] as Record<string, unknown>).commitRef).toBe(HASH_A)
  })
})
