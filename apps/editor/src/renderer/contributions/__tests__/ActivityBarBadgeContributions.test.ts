/*---------------------------------------------------------------------------------------------
 *  Regression test for the Activity Bar badge leak: the handle returned by
 *  IActivityService.showActivity must join the contribution's disposable tree
 *  (via MutableDisposable). The contributions live under the singleton
 *  workbenchStore and are never disposed, so a handle held only by a closure —
 *  without a real parent link — is reported as a leak on unload.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  DisposableStore,
  DisposableTracker,
  markAsSingleton,
  observableValue,
  setDisposableTracker,
  type ICommandService,
  type ISettableObservable,
} from '@universe-editor/platform'
import { SwarmCommands } from '@universe-editor/extensions-common'
import { ActivityService } from '../../services/activity/ActivityService.js'
import type { IScmService, IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { swarmNeedsActionCount } from '../../services/swarm/swarmViewState.js'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import {
  ScmActivityContribution,
  SwarmActivityContribution,
} from '../ActivityBarBadgeContributions.js'

function makeFakeScm(rootUris: readonly string[]): {
  service: IScmService
  setCount: (index: number, count: number | undefined) => void
  addRepo: (rootUri: string) => void
  removeRepo: (rootUri: string) => void
} {
  interface FakeEntry {
    readonly rootUri: string
    readonly count: ISettableObservable<number | undefined>
    readonly model: IScmSourceControlModel
  }
  const entries: FakeEntry[] = []
  const sourceControls = observableValue<readonly IScmSourceControlModel[]>('sourceControls', [])
  const syncSourceControls = () =>
    sourceControls.set(
      entries.map((e) => e.model),
      undefined,
    )
  const addRepo = (rootUri: string) => {
    const count = observableValue<number | undefined>(`count${entries.length}`, undefined)
    const model = { rootUri, count } as unknown as IScmSourceControlModel
    entries.push({ rootUri, count, model })
    syncSourceControls()
  }
  for (const rootUri of rootUris) addRepo(rootUri)
  const service: IScmService = {
    _serviceBrand: undefined,
    sourceControls,
    onDidPublishWorkingTreeScan: () => ({ dispose() {} }),
    changeInputBoxValue() {},
    setExtHost() {},
    resetSourceControls() {},
  }
  return {
    service,
    setCount: (index, c) => entries[index]?.count.set(c, undefined),
    addRepo,
    removeRepo: (rootUri) => {
      const i = entries.findIndex((e) => e.rootUri === rootUri)
      if (i >= 0) {
        entries.splice(i, 1)
        syncSourceControls()
      }
    },
  }
}

describe('ScmActivityContribution', () => {
  afterEach(() => {
    // Module-level observable — reset so the next test re-hydrates cleanly.
    scmViewState.setSelectedRepo(undefined)
    setDisposableTracker(null)
  })

  it('follows the selected repo instead of summing the workspace', () => {
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    const scm = makeFakeScm(['repo-a', 'repo-b'])
    store.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(0, 3)
    scm.setCount(1, 7)

    // No selection → falls back to the first repo.
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(3)

    scmViewState.setSelectedRepo('repo-b')
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(7)

    scmViewState.setSelectedRepo('repo-a')
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(3)

    store.dispose()
  })

  it('falls back to the first repo when selectedRepo points at nothing', () => {
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    const scm = makeFakeScm(['repo-a', 'repo-b'])
    store.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(0, 2)
    scm.setCount(1, 9)

    scmViewState.setSelectedRepo('does-not-exist')
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(2)

    store.dispose()
  })

  it('hides the badge when the selected repo has no count, even if others do', () => {
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    const scm = makeFakeScm(['repo-a', 'repo-b'])
    store.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(0, 5)
    scmViewState.setSelectedRepo('repo-b')
    expect(activityService.getBadge('workbench.view.scm').get()).toBeUndefined()

    // Setting the selected repo's count brings the badge back.
    scm.setCount(1, 4)
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(4)

    store.dispose()
  })

  it('re-resolves when sourceControls registers late (restored selection)', () => {
    // Restore-from-storage race: selectedRepo hydrates before the owning
    // extension activates, so the badge must fall back first and re-arbitrate
    // once the target repo registers.
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    const scm = makeFakeScm(['repo-a'])
    store.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(0, 3)
    scmViewState.setSelectedRepo('repo-b')
    // repo-b not yet registered → falls back to first (repo-a).
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(3)

    // The owning extension activates and registers repo-b with its own count.
    scm.addRepo('repo-b')
    // The new repo's count is undefined initially → badge hides, doesn't fall back.
    expect(activityService.getBadge('workbench.view.scm').get()).toBeUndefined()

    scm.setCount(1, 8)
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(8)

    store.dispose()
  })

  it('falls back when the selected repo is unregistered', () => {
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    const scm = makeFakeScm(['repo-a', 'repo-b'])
    store.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(0, 2)
    scm.setCount(1, 9)
    scmViewState.setSelectedRepo('repo-b')
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(9)

    // Selected repo disappears → badge falls back to first.
    scm.removeRepo('repo-b')
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(2)

    store.dispose()
  })

  it('does not leak the badge handle while living under the singleton store', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    // Mirror main.tsx: root services + contributions hang off a singleton store
    // and are never disposed on unload.
    const workbenchStore = markAsSingleton(new DisposableStore())
    const activityService = workbenchStore.add(new ActivityService())
    const scm = makeFakeScm(['repo-a'])
    workbenchStore.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(0, 5)
    expect(activityService.getBadge('workbench.view.scm').get()?.count).toBe(5)

    // The contribution is intentionally NOT disposed here. With the badge handle
    // parented into the contribution's tree, its root is the singleton store, so
    // it must not be reported as a leak.
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })
})

describe('SwarmActivityContribution', () => {
  afterEach(() => {
    // Module-level singleton shared across tests — reset so counts don't leak.
    swarmNeedsActionCount.set(0)
    setDisposableTracker(null)
  })

  function makeCommands(executeCommand = vi.fn(async () => undefined)): ICommandService {
    return { _serviceBrand: undefined, executeCommand } as unknown as ICommandService
  }

  it('mirrors the needs-action count onto the swarm container badge', () => {
    // Dispose at the end: the count is a module-singleton observable, so a live
    // contribution from this test would keep reacting (and creating badge handles)
    // inside the leak-checking test below.
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    store.add(new SwarmActivityContribution(activityService, makeCommands()))

    const badge = activityService.getBadge('workbench.view.swarm')
    expect(badge.get()).toBeUndefined()

    swarmNeedsActionCount.set(3)
    expect(badge.get()?.count).toBe(3)

    swarmNeedsActionCount.set(0)
    expect(badge.get()).toBeUndefined()

    store.dispose()
  })

  it('pushes the group-scope count to the host status bar command', () => {
    const executeCommand = vi.fn(async () => undefined)
    const store = new DisposableStore()
    // The push is gated on the command being registered (perforce extension present).
    store.add(CommandsRegistry.registerCommand(SwarmCommands.setStatusCount, () => undefined))
    const activityService = store.add(new ActivityService())
    store.add(new SwarmActivityContribution(activityService, makeCommands(executeCommand)))

    // autorun fires immediately with the initial count.
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.setStatusCount, 0)

    swarmNeedsActionCount.set(3)
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.setStatusCount, 3)

    swarmNeedsActionCount.set(0)
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.setStatusCount, 0)

    store.dispose()
  })

  it('does not push while setStatusCount is unregistered (perforce extension absent)', () => {
    const executeCommand = vi.fn(async () => undefined)
    const store = new DisposableStore()
    const activityService = store.add(new ActivityService())
    store.add(new SwarmActivityContribution(activityService, makeCommands(executeCommand)))

    // No throw, badge still mirrors, and no command-not-found warn spam.
    swarmNeedsActionCount.set(2)
    expect(activityService.getBadge('workbench.view.swarm').get()?.count).toBe(2)
    expect(executeCommand).not.toHaveBeenCalled()

    store.dispose()
  })

  it('does not leak the badge handle while living under the singleton store', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    const workbenchStore = markAsSingleton(new DisposableStore())
    const activityService = workbenchStore.add(new ActivityService())
    workbenchStore.add(new SwarmActivityContribution(activityService, makeCommands()))

    swarmNeedsActionCount.set(5)
    expect(activityService.getBadge('workbench.view.swarm').get()?.count).toBe(5)
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })
})
