/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Repro for "command not found id=git-graph.getCommits / getRepos" at startup: a
 *  session-restored Git Graph tab mounts before the git extension has activated
 *  and registered its commands. The editor must wait for registration instead of
 *  executing into the void (and misreading the undefined result as "unavailable").
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
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
  type GitGraphLoadResult,
  type GitGraphRepoDto,
} from '@universe-editor/extensions-common'
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

function renderEditor() {
  const executeCommand = vi.fn(async (id: string) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return makeResult()
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
  // Several macro rounds: the storage-read → restore-decision →
  // default-selection → payload-fetch chain schedules one React render per step, and each
  // render is flushed on its own macrotask.
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

afterEach(() => {
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

describe('GitGraphEditor command-registration gate', () => {
  it('issues no git-graph queries while the commands are unregistered, loads once they appear', async () => {
    const { executeCommand } = renderEditor()
    await flush()

    // Extension not activated yet: the startup mount must stay quiet.
    expect(executeCommand).not.toHaveBeenCalled()

    // The extension host finishes activating and the commands appear.
    const stub = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
    await flush()

    const ids = executeCommand.mock.calls.map((c) => c[0])
    expect(ids).toContain(GitGraphCommands.getCommits)
    expect(ids).toContain(GitGraphCommands.getRepos)
    stub.dispose()
  })
})
