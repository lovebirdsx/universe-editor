/*---------------------------------------------------------------------------------------------
 *  Tests for CommitChangesViewResetContribution — switching workspaces (or
 *  closing the folder) must clear the Commit Changes view's leftover payload;
 *  the first observation (startup hydration, opening the first folder) must not.
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
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import { CommitChangesViewResetContribution } from '../CommitChangesViewResetContribution.js'
import { commitChangesViewState } from '../../workbench/scm/commitChanges/viewState.js'

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

function fakePayload(): ShowCommitChangesPayload {
  return {
    providerId: 'git',
    title: 'a1b2c3d — fix crash',
    commitRef: 'a1b2c3d',
    openExternalCommand: 'git-graph.openFileDiff',
    files: [],
  }
}

function setup(initial: IWorkspace | null = null) {
  const workspaceStub = makeWorkspaceStub(initial)
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspaceStub)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(CommitChangesViewResetContribution)
  return { workspaceStub, contribution }
}

describe('CommitChangesViewResetContribution', () => {
  afterEach(() => {
    commitChangesViewState._resetForTests()
  })

  it('clears the payload when the workspace root changes', () => {
    const { workspaceStub } = setup(workspace('/ws/a'))
    commitChangesViewState.show(fakePayload())

    workspaceStub.fireWorkspaceChange(workspace('/ws/b'))

    expect(commitChangesViewState.payload.get()).toBeNull()
  })

  it('clears the payload when the folder is closed', () => {
    const { workspaceStub } = setup(workspace('/ws/a'))
    commitChangesViewState.show(fakePayload())

    workspaceStub.fireWorkspaceChange(null)

    expect(commitChangesViewState.payload.get()).toBeNull()
  })

  it('does not clear on the first observed workspace (startup hydration)', () => {
    const { workspaceStub } = setup(null)
    commitChangesViewState.show(fakePayload())

    workspaceStub.fireWorkspaceChange(workspace('/ws/a'))

    expect(commitChangesViewState.payload.get()).not.toBeNull()
  })

  it('does not clear when the event carries the same root again', () => {
    const { workspaceStub } = setup(workspace('/ws/a'))
    commitChangesViewState.show(fakePayload())

    workspaceStub.fireWorkspaceChange(workspace('/ws/a'))

    expect(commitChangesViewState.payload.get()).not.toBeNull()
  })
})
