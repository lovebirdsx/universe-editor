/*---------------------------------------------------------------------------------------------
 *  Tests for GitGraphViewResetContribution — switching workspaces (or closing
 *  the folder) must clear the Git Graph editor's module-level state, most
 *  importantly `selectedRepo`: a stale repo root from the previous workspace is
 *  otherwise re-asserted onto the freshly restarted git extension via
 *  `git-graph.setRepo`, silently pointing graph mutations (e.g. Reset current
 *  branch) at the OLD workspace's checkout. The first observation (startup
 *  hydration, opening the first folder) must not clear.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import type { GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphViewResetContribution } from '../GitGraphViewResetContribution.js'
import { gitGraphViewState } from '../../services/gitGraph/gitGraphViewState.js'

function makeWorkspaceStub(initial: IWorkspace | null = null): IWorkspaceServiceType & {
  fireWorkspaceChange(workspace: IWorkspace | null): void
} {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: wsEmitter.event,
    get recent() {
      return []
    },
    onDidChangeRecent: recentEmitter.event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {
      current = null
    },
    async clearRecent() {},
    async removeRecent() {},
    fireWorkspaceChange(workspace: IWorkspace | null) {
      current = workspace
      wsEmitter.fire(workspace)
    },
  }
}

function workspace(folder: string): IWorkspace {
  return { folder: URI.file(folder), name: folder }
}

function fakeResult(): GitGraphLoadResult {
  return {
    commits: [],
    head: 'a1b2c3d',
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: 0,
  }
}

/** Simulate a Git Graph session on the previous workspace: a non-default repo
 *  was selected and commits were loaded. */
function seedPreviousWorkspaceState(): void {
  gitGraphViewState.selectedRepo = '/ws/main-repo'
  gitGraphViewState.repos = [{ root: '/ws/main-repo', name: 'main-repo' }]
  gitGraphViewState.result = fakeResult()
  gitGraphViewState.selection = ['a1b2c3d']
  gitGraphViewState.scrollTop = 120
  gitGraphViewState.searchQuery = 'fix'
  gitGraphViewState.limit = 1000
  gitGraphViewState.pendingReveal.set('a1b2c3d', undefined)
}

function setup(initial: IWorkspace | null = null) {
  const workspaceStub = makeWorkspaceStub(initial)
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspaceStub)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(GitGraphViewResetContribution)
  return { workspaceStub, contribution }
}

describe('GitGraphViewResetContribution', () => {
  afterEach(() => {
    gitGraphViewState._resetForTests()
  })

  it('clears the per-workspace state when the workspace root changes', () => {
    const { workspaceStub } = setup(workspace('/ws/a'))
    seedPreviousWorkspaceState()

    workspaceStub.fireWorkspaceChange(workspace('/ws/b'))

    expect(gitGraphViewState.selectedRepo).toBeNull()
    expect(gitGraphViewState.repos).toEqual([])
    expect(gitGraphViewState.result).toBeNull()
    expect(gitGraphViewState.selection).toEqual([])
    expect(gitGraphViewState.scrollTop).toBe(0)
    expect(gitGraphViewState.searchQuery).toBe('')
    expect(gitGraphViewState.pendingReveal.get()).toBeNull()
  })

  it('clears the state when the folder is closed', () => {
    const { workspaceStub } = setup(workspace('/ws/a'))
    seedPreviousWorkspaceState()

    workspaceStub.fireWorkspaceChange(null)

    expect(gitGraphViewState.selectedRepo).toBeNull()
    expect(gitGraphViewState.result).toBeNull()
  })

  it('does not clear on the first observed workspace (startup hydration)', () => {
    const { workspaceStub } = setup(null)
    seedPreviousWorkspaceState()

    workspaceStub.fireWorkspaceChange(workspace('/ws/a'))

    expect(gitGraphViewState.selectedRepo).toBe('/ws/main-repo')
    expect(gitGraphViewState.result).not.toBeNull()
  })

  it('does not clear when the event carries the same root again', () => {
    const { workspaceStub } = setup(workspace('/ws/a'))
    seedPreviousWorkspaceState()

    workspaceStub.fireWorkspaceChange(workspace('/ws/a'))

    expect(gitGraphViewState.selectedRepo).toBe('/ws/main-repo')
    expect(gitGraphViewState.result).not.toBeNull()
  })
})
