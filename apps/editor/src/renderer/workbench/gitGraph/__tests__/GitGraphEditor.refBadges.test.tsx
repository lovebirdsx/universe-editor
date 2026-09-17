/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Ref badge hover tooltips in the Git Graph editor: every pill (branch / tag / remote)
 *  names its own kind plus the full ref — the fallback a badge squeezed into an
 *  ellipsis (long name, narrow row) still reads from.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
const LONG_BRANCH = 'testuser/long-branch-name'

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
        heads: [LONG_BRANCH],
        tags: [{ name: 'v1.0.0', annotated: true }],
        remotes: [{ name: 'origin/develop', remote: 'origin' }],
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

function makeCommandService(): ICommandService {
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
  return {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: () => ({ dispose: () => {} }),
    onDidExecuteCommand: () => ({ dispose: () => {} }),
  } as unknown as ICommandService
}

function renderEditor(): void {
  const services = new ServiceCollection()
  services.set(ICommandService, makeCommandService())
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
  render(
    <ServicesContext.Provider value={instantiation}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
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

function tooltipOf(text: string): string | null {
  return screen.getByText(text).getAttribute('data-tooltip')
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

describe('GitGraphEditor ref badge tooltips', () => {
  it('names the ref kind and the full name on every pill', async () => {
    gitGraphViewState.result = makeResult()
    renderEditor()
    await flush()

    expect(tooltipOf(LONG_BRANCH)).toBe(`Branch ${LONG_BRANCH}`)
    expect(tooltipOf('v1.0.0')).toBe('Tag v1.0.0')
    expect(tooltipOf('origin/develop')).toBe('Remote origin/develop')
  })
})
