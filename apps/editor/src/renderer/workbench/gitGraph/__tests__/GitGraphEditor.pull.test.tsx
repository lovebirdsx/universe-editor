/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pull entries in the Git Graph branch context menu: all three SCM variants are
 *  offered for any local branch, forwarding the branch name and pull mode to the
 *  extension-side `git-graph.pull` command.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  CommandsRegistry,
  ICommandService,
  IDialogService,
  IProgressService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type IDisposable,
  type IProgressOptions,
} from '@universe-editor/platform'
import { GitGraphCommands, type GitGraphLoadResult } from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

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
        heads: ['feature'],
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

function renderEditor() {
  const { service: commandService, executeCommand } = makeCommandService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed: true }),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService)
  services.set(IProgressService, {
    _serviceBrand: undefined,
    withProgress: vi.fn(async (_options: IProgressOptions, task: () => Promise<unknown>) => task()),
  } as unknown as IProgressService)
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
  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, ...utils }
}

async function flush(): Promise<void> {
  // Same multi-round settle as the worktree tests: storage-read → restore →
  // selection → payload-fetch schedule one render per step.
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
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

function openBranchMenu(): HTMLElement {
  fireEvent.contextMenu(screen.getByText('feature'))
  return screen.getByRole('menu')
}

describe('GitGraphEditor branch pull menu', () => {
  it('offers all three SCM pull variants between rename and push', async () => {
    gitGraphViewState.result = makeResult()
    renderEditor()
    await flush()

    const menu = openBranchMenu()
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)

    expect(labels).toContain('Pull')
    expect(labels).toContain('Pull (Rebase)')
    expect(labels).toContain('Pull (Autostash)')
    const renameAt = labels.indexOf('Rename…')
    const pushAt = labels.indexOf('Push…')
    expect(renameAt).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Pull')).toBeGreaterThan(renameAt)
    expect(labels.indexOf('Pull (Autostash)')).toBeLessThan(pushAt)
  })

  it.each([
    ['Pull', 'default'],
    ['Pull (Rebase)', 'rebase'],
    ['Pull (Autostash)', 'autostash'],
  ] as const)('runs git-graph.pull in %s mode', async (label, mode) => {
    gitGraphViewState.result = makeResult()
    const { executeCommand } = renderEditor()
    await flush()

    const menu = openBranchMenu()
    fireEvent.click(within(menu).getByText(label))

    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.pull, 'feature', mode)
  })
})
