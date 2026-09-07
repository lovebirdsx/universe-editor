/*---------------------------------------------------------------------------------------------
 *  Tests for ScmSelectedRepoContribution — the SCM view's selected repo is
 *  persisted per workspace, but the restore must NOT depend on the ScmView
 *  component mounting: dirty-diff/blame arbitration consumes the selection even
 *  when the user never opens the SCM panel (closing the workspace with the panel
 *  hidden used to leave arbitration on the longest-prefix fallback, e.g. git
 *  blame showing for a p4-selected workspace until the panel got focus).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { ScmSelectedRepoContribution } from '../ScmSelectedRepoContribution.js'

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

function setup(stored?: string, initial: IWorkspace | null = null) {
  const store = new Map<string, unknown>()
  if (stored !== undefined) store.set('scm.selectedRepo', stored)
  const storage = {
    _serviceBrand: undefined,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
  } as unknown as IStorageService

  const workspaceStub = makeWorkspaceStub(initial)
  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  services.set(IWorkspaceService, workspaceStub)
  const inst = new InstantiationService(services)
  return { inst, store, workspaceStub }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('ScmSelectedRepoContribution', () => {
  afterEach(() => {
    scmViewState.setSelectedRepo(undefined)
  })

  it('hydrates the persisted selection without any view mounting', async () => {
    const { inst } = setup('/ws')
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()
    expect(scmViewState.selectedRepo.get()).toBe('/ws')
  })

  it('does not clobber an in-memory selection made before hydration landed', async () => {
    const { inst } = setup('/ws')
    scmViewState.setSelectedRepo('/other')
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()
    expect(scmViewState.selectedRepo.get()).toBe('/other')
  })

  it('persists later selection changes back to workspace storage', async () => {
    const { inst, store } = setup()
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()

    scmViewState.setSelectedRepo('/ws/p4')
    await flushMicrotasks()
    expect(store.get('scm.selectedRepo')).toBe('/ws/p4')
  })

  it('never writes before hydration completes, then persists the current value', async () => {
    const { inst, store } = setup('/ws')
    inst.createInstance(ScmSelectedRepoContribution)
    // A change racing the in-flight hydrate: nothing is written yet (the write
    // back autorun only registers once hydration settles), and the in-memory
    // choice wins over the stale stored value.
    scmViewState.setSelectedRepo('/other')
    expect(store.get('scm.selectedRepo')).toBe('/ws')
    await flushMicrotasks()
    expect(scmViewState.selectedRepo.get()).toBe('/other')
    expect(store.get('scm.selectedRepo')).toBe('/other')
  })

  it('clears the in-memory selection when the workspace root changes', async () => {
    const { inst, workspaceStub } = setup(undefined, workspace('/ws/a'))
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()

    scmViewState.setSelectedRepo('/ws/a/repo')
    workspaceStub.fireWorkspaceChange(workspace('/ws/b'))

    expect(scmViewState.selectedRepo.get()).toBeUndefined()
  })

  it('does not clear on the first observed workspace (startup hydration)', async () => {
    const { inst, workspaceStub } = setup(undefined, null)
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()

    scmViewState.setSelectedRepo('/ws/a/repo')
    workspaceStub.fireWorkspaceChange(workspace('/ws/a'))

    expect(scmViewState.selectedRepo.get()).toBe('/ws/a/repo')
  })

  it('does not clear when the event carries the same root again', async () => {
    const { inst, workspaceStub } = setup(undefined, workspace('/ws/a'))
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()

    scmViewState.setSelectedRepo('/ws/a/repo')
    workspaceStub.fireWorkspaceChange(workspace('/ws/a'))

    expect(scmViewState.selectedRepo.get()).toBe('/ws/a/repo')
  })
})
