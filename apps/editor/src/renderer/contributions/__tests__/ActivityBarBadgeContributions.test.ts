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
  type IObservable,
} from '@universe-editor/platform'
import { SwarmCommands } from '@universe-editor/extensions-common'
import { ActivityService } from '../../services/activity/ActivityService.js'
import type { IScmService, IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { swarmNeedsActionCount } from '../../services/swarm/swarmViewState.js'
import {
  ScmActivityContribution,
  SwarmActivityContribution,
} from '../ActivityBarBadgeContributions.js'

function makeFakeScm(): { service: IScmService; setCount: (count: number | undefined) => void } {
  const count = observableValue<number | undefined>('count', undefined)
  const sc = { count } as unknown as IScmSourceControlModel
  const sourceControls: IObservable<readonly IScmSourceControlModel[]> = observableValue<
    readonly IScmSourceControlModel[]
  >('sourceControls', [sc])
  const service: IScmService = {
    _serviceBrand: undefined,
    sourceControls,
    changeInputBoxValue() {},
    setExtHost() {},
    resetSourceControls() {},
  }
  return { service, setCount: (c) => count.set(c, undefined) }
}

describe('ScmActivityContribution', () => {
  afterEach(() => {
    setDisposableTracker(null)
  })

  it('does not leak the badge handle while living under the singleton store', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    // Mirror main.tsx: root services + contributions hang off a singleton store
    // and are never disposed on unload.
    const workbenchStore = markAsSingleton(new DisposableStore())
    const activityService = workbenchStore.add(new ActivityService())
    const scm = makeFakeScm()
    workbenchStore.add(new ScmActivityContribution(scm.service, activityService))

    scm.setCount(5)
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
