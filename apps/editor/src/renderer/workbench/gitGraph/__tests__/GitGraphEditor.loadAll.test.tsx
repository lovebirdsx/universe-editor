/*---------------------------------------------------------------------------------------------
 *  Coverage for the streaming "Load all commits" flow: normal batch merge, the
 *  pre-stream tail kept until the stream reaches it, the large-repo confirm /
 *  cap, cancel, and the shallow refresh used once the list is fully loaded.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import {
  CommandsRegistry,
  ICommandService,
  IDialogService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphCommitBatchDto,
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

function commit(hash: string, message: string, date: number): GitGraphCommitDto {
  return {
    hash,
    parents: [],
    author: 'tester',
    email: 't@example.com',
    date,
    message,
    heads: [],
    tags: [],
    remotes: [],
    stash: null,
    worktrees: [],
  }
}

const C1 = commit('1111111111111111111111111111111111111111', 'one', 300)
const C2 = commit('2222222222222222222222222222222222222222', 'two', 200)
const C3 = commit('3333333333333333333333333333333333333333', 'three', 100)

function resultWith(commits: GitGraphCommitDto[], moreAvailable: boolean): GitGraphLoadResult {
  return {
    commits,
    head: commits[0]?.hash ?? null,
    headName: 'main',
    moreAvailable,
    uncommittedChanges: 0,
  }
}

function batch(
  streamId: string,
  commits: GitGraphCommitDto[],
  terminal: { done?: boolean; moreAvailable?: boolean } = {},
): GitGraphCommitBatchDto {
  return { streamId, seq: 0, commits, logCount: commits.length, ...terminal }
}

function renderEditor(options: {
  getCommits: (options: { maxCommits?: number }) => GitGraphLoadResult | undefined
  count?: number
  confirm?: (opts: unknown) => Promise<{ confirmed: boolean }>
}) {
  const executeCommand = vi.fn(async (id: string, arg?: unknown) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return options.getCommits((arg ?? {}) as { maxCommits?: number })
      case GitGraphCommands.getRepos:
        return [{ root: '/repo', name: 'repo' }] as GitGraphRepoDto[]
      case GitGraphCommands.countCommits:
        return options.count ?? 3
      case GitGraphCommands.startCommitStream:
        return true
      case GitGraphCommands.cancelCommitStream:
        return true
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
    confirm: vi.fn(options.confirm ?? (() => Promise.resolve({ confirmed: false }))),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
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
  return { executeCommand, ...utils }
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  }
}

async function feed(batchDto: GitGraphCommitBatchDto): Promise<void> {
  await act(async () => {
    await gitGraphViewState.commitBatch?.(batchDto)
  })
}

function streamStartArgs(executeCommand: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = executeCommand.mock.calls.find((c) => c[0] === GitGraphCommands.startCommitStream)
  return (call?.[1] ?? {}) as Record<string, unknown>
}

function streamIdOf(executeCommand: ReturnType<typeof vi.fn>): string {
  return String(streamStartArgs(executeCommand)['streamId'])
}

let gates: Array<{ dispose(): void }> = []

beforeEach(() => {
  gates = [
    CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined),
    CommandsRegistry.registerCommand(GitGraphCommands.countCommits, () => undefined),
    CommandsRegistry.registerCommand(GitGraphCommands.startCommitStream, () => undefined),
    CommandsRegistry.registerCommand(GitGraphCommands.cancelCommitStream, () => undefined),
  ]
  gitGraphViewState._resetForTests()
})

afterEach(() => {
  for (const gate of gates) gate.dispose()
  gitGraphViewState._resetForTests()
  scmViewState.setSelectedRepo(undefined)
  vi.restoreAllMocks()
})

describe('GitGraphEditor load all', () => {
  it('shows Load more and Load all for a paged list', async () => {
    const { getByTestId } = renderEditor({ getCommits: () => resultWith([C1, C2, C3], true) })
    await flush()
    expect(getByTestId('gitGraph-loadMore')).toBeTruthy()
    expect(getByTestId('gitGraph-loadAll')).toBeTruthy()
  })

  it('merges batches onto the current list and keeps the untouched tail', async () => {
    const { executeCommand } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
    })
    await flush()

    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.countCommits,
      expect.objectContaining({ includeRemotes: true, order: 'date' }),
    )
    const streamId = streamIdOf(executeCommand)
    expect(streamId).not.toBe('undefined')
    // The cap is always sent: a failed preflight count must not disable it.
    expect(streamStartArgs(executeCommand)['maxCommits']).toBe(50_000)

    // First (non-terminal) batch only carries the newest commit: the old tail
    // stays visible so the list does not shrink during the stream.
    await feed(batch(streamId, [C1]))
    expect(gitGraphViewState.result?.commits.map((c) => c.hash)).toEqual([
      C1.hash,
      C2.hash,
      C3.hash,
    ])

    await feed(batch(streamId, [C2]))
    expect(gitGraphViewState.result?.commits.map((c) => c.hash)).toEqual([
      C1.hash,
      C2.hash,
      C3.hash,
    ])

    await feed(batch(streamId, [C3], { done: true }))
    expect(gitGraphViewState.result?.commits.map((c) => c.hash)).toEqual([
      C1.hash,
      C2.hash,
      C3.hash,
    ])
    expect(gitGraphViewState.result?.moreAvailable).toBe(false)
    expect(gitGraphViewState.loadMode).toBe('full')
    // Load all never touches the paged limit.
    expect(gitGraphViewState.limit).toBe(GIT_GRAPH_PAGE_SIZE)
  })

  it('drops the pre-stream tail at completion when history was rewritten', async () => {
    const { executeCommand } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    const rebased = commit('4444444444444444444444444444444444444444', 'rewritten', 250)
    await feed(batch(streamIdOf(executeCommand), [C1, rebased], { done: true }))
    expect(gitGraphViewState.result?.commits.map((c) => c.hash)).toEqual([C1.hash, rebased.hash])
  })

  it('asks before streaming a very large repository and does nothing when declined', async () => {
    const confirm = vi.fn().mockResolvedValue({ confirmed: false })
    const { executeCommand } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
      count: 25_000,
      confirm,
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    expect(confirm).toHaveBeenCalled()
    expect(executeCommand.mock.calls.some((c) => c[0] === GitGraphCommands.startCommitStream)).toBe(
      false,
    )
  })

  it('caps the stream at the safety limit and reports it instead of Load more', async () => {
    const confirm = vi.fn().mockResolvedValue({ confirmed: true })
    const { executeCommand, queryByTestId, getByTestId } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
      count: 60_000,
      confirm,
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    expect(streamStartArgs(executeCommand)['maxCommits']).toBe(50_000)

    await feed(batch(streamIdOf(executeCommand), [C1, C2], { done: true, moreAvailable: true }))
    expect(gitGraphViewState.loadMode).toBe('partial')
    expect(getByTestId('gitGraph-loadAllCapped').textContent).toContain('50,000')
    expect(queryByTestId('gitGraph-loadMore')).toBeNull()
    expect(queryByTestId('gitGraph-loadAll')).toBeNull()
  })

  it('cancel keeps the received commits and offers Load all again', async () => {
    const { executeCommand, getByTestId } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    const streamId = streamIdOf(executeCommand)

    fireEvent.click(getByTestId('gitGraph-cancelLoadAll'))
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.cancelCommitStream, streamId)
    expect(gitGraphViewState.loadMode).toBe('partial')
    expect(getByTestId('gitGraph-loadAll')).toBeTruthy()
  })

  it('ignores refresh while the stream owns the list', async () => {
    const { executeCommand } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    const getCommitsCount = (): number =>
      executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.getCommits).length
    const before = getCommitsCount()

    await act(async () => {
      gitGraphViewState.refresh?.()
    })
    await flush()
    expect(getCommitsCount()).toBe(before)
  })

  it('does not page in a reveal after Load all (the streamed list is authoritative)', async () => {
    const { executeCommand, queryByTestId } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    const streamId = streamIdOf(executeCommand)
    await feed(batch(streamId, [C1, C2], { done: true }))
    const getCommitsCount = (): number =>
      executeCommand.mock.calls.filter((c) => c[0] === GitGraphCommands.getCommits).length
    const before = getCommitsCount()
    const commitsBefore = gitGraphViewState.result?.commits.map((c) => c.hash)

    await act(async () => {
      gitGraphViewState.revealCommit?.('9999999999999999999999999999999999999999')
    })
    await flush()

    expect(getCommitsCount()).toBe(before)
    expect(gitGraphViewState.result?.commits.map((c) => c.hash)).toEqual(commitsBefore)
    expect(queryByTestId('gitGraph-loadAll')).toBeNull()
  })

  it('keeps the paged HEAD when the stream metadata lookup failed', async () => {
    const { executeCommand } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    await feed({
      ...batch(streamIdOf(executeCommand), [C1]),
      meta: { head: null, headName: null, uncommittedChanges: 0 },
    })
    expect(gitGraphViewState.result?.head).toBe(C1.hash)
    expect(gitGraphViewState.result?.headName).toBe('main')
  })

  it('resets a finished capped stream on cancel so the next repo offers Load all', async () => {
    const confirm = vi.fn().mockResolvedValue({ confirmed: true })
    const { executeCommand, queryByTestId, getByTestId } = renderEditor({
      getCommits: () => resultWith([C1, C2, C3], true),
      count: 60_000,
      confirm,
    })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    await feed(batch(streamIdOf(executeCommand), [C1, C2], { done: true, moreAvailable: true }))
    expect(getByTestId('gitGraph-loadAllCapped')).toBeTruthy()

    // Repo switch / settings reset while no stream is running.
    await act(async () => {
      gitGraphViewState.cancelLoadAll?.()
    })
    await flush()
    expect(queryByTestId('gitGraph-loadAllCapped')).toBeNull()
    expect(getByTestId('gitGraph-loadAll')).toBeTruthy()
  })

  it('shallow-refreshes a fully loaded list instead of dropping the tail', async () => {
    let fresh = resultWith([C1, C2, C3], true)
    const { executeCommand } = renderEditor({ getCommits: () => fresh })
    await flush()
    await act(async () => {
      gitGraphViewState.loadAll?.()
    })
    await flush()
    await feed(batch(streamIdOf(executeCommand), [C1, C2, C3], { done: true }))
    expect(gitGraphViewState.loadMode).toBe('full')

    // A background refresh only fetches the first page; older commits survive.
    fresh = resultWith([C1], false)
    await act(async () => {
      gitGraphViewState.refresh?.()
    })
    await flush()

    const getCommitsCalls = executeCommand.mock.calls.filter(
      (c) => c[0] === GitGraphCommands.getCommits,
    )
    expect((getCommitsCalls.at(-1)?.[1] as { maxCommits?: number }).maxCommits).toBe(
      GIT_GRAPH_PAGE_SIZE,
    )
    expect(gitGraphViewState.result?.commits.map((c) => c.hash)).toEqual([
      C1.hash,
      C2.hash,
      C3.hash,
    ])
  })
})
