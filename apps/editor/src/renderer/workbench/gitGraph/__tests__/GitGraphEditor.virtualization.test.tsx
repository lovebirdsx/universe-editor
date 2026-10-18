/*---------------------------------------------------------------------------------------------
 *  Windowed rendering coverage: above the threshold only the virtual window is
 *  mounted (rows and SVG nodes), keyboard navigation scrolls by index instead
 *  of looking rows up in the DOM, and reveal lands on the virtualizer.
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
  type GitGraphCommitDto,
  type GitGraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../../scm/scmViewState.js'
import {
  GIT_GRAPH_PAGE_SIZE,
  gitGraphViewState,
} from '../../../services/gitGraph/gitGraphViewState.js'
import { VIRTUALIZATION_THRESHOLD } from '../gitGraphLoadAll.js'

const { scrollToIndexMock } = vi.hoisted(() => ({ scrollToIndexMock: vi.fn() }))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 5) }, (_, index) => ({
        index,
        start: 24 + index * 24,
        size: 24,
      })),
    getTotalSize: () => count * 24,
    scrollToIndex: scrollToIndexMock,
  }),
}))

import { GitGraphEditor } from '../GitGraphEditor.js'

function makeCommits(count: number): GitGraphCommitDto[] {
  return Array.from({ length: count }, (_, i) => ({
    hash: i.toString(16).padStart(40, '0'),
    parents: [],
    author: 'tester',
    email: 't@example.com',
    date: 10_000 - i,
    message: `commit ${i}`,
    heads: [],
    tags: [],
    remotes: [],
    stash: null,
    worktrees: [],
  }))
}

function renderEditor(commits: GitGraphCommitDto[]) {
  const executeCommand = vi.fn(async (id: string) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return {
          commits,
          head: commits[0]?.hash ?? null,
          headName: 'main',
          moreAvailable: false,
          uncommittedChanges: 0,
        }
      case GitGraphCommands.getRepos:
        return [{ root: '/repo', name: 'repo' } as GitGraphRepoDto]
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
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService)
  return render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
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

let commandGate: { dispose(): void } | null = null

beforeEach(() => {
  gitGraphViewState._resetForTests()
  scrollToIndexMock.mockReset()
  commandGate = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
})

afterEach(() => {
  commandGate?.dispose()
  commandGate = null
  gitGraphViewState._resetForTests()
  scmViewState.setSelectedRepo(undefined)
  vi.restoreAllMocks()
})

describe('GitGraphEditor virtualization', () => {
  it('mounts only the virtual window above the threshold', async () => {
    const commits = makeCommits(VIRTUALIZATION_THRESHOLD + 50)
    const { getAllByRole, container } = renderEditor(commits)
    await flush()

    const rows = getAllByRole('option')
    expect(rows).toHaveLength(5)
    expect(rows[0]!.getAttribute('aria-posinset')).toBe('1')
    expect(rows[0]!.getAttribute('aria-setsize')).toBe(String(commits.length))
    // SVG nodes are windowed with the rows (5 plain commit nodes here).
    expect(container.querySelectorAll('svg circle')).toHaveLength(5)
  })

  it('renders every row at the threshold', async () => {
    const { getAllByRole } = renderEditor(makeCommits(VIRTUALIZATION_THRESHOLD))
    await flush()
    expect(getAllByRole('option')).toHaveLength(VIRTUALIZATION_THRESHOLD)
  })

  it('navigates by index instead of scrolling a DOM row', async () => {
    const commits = makeCommits(VIRTUALIZATION_THRESHOLD + 50)
    const { getByTestId } = renderEditor(commits)
    await flush()
    fireEvent.keyDown(getByTestId('gitGraph-scrollBody'), {
      key: 'End',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    })
    expect(scrollToIndexMock).toHaveBeenCalledWith(commits.length - 1, { align: 'auto' })
  })

  it('reveals an off-window commit through scrollToIndex', async () => {
    const commits = makeCommits(VIRTUALIZATION_THRESHOLD + 50)
    renderEditor(commits)
    await flush()

    await act(async () => {
      gitGraphViewState.revealCommit?.(commits[180]!.hash)
    })
    expect(gitGraphViewState.selection).toEqual([commits[180]!.hash])
    expect(scrollToIndexMock).toHaveBeenCalledWith(180, { align: 'center' })
    expect(gitGraphViewState.limit).toBe(GIT_GRAPH_PAGE_SIZE)
  })
})
