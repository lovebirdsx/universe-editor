/*---------------------------------------------------------------------------------------------
 *  Regression test for the Activity Bar badge leak: the handle returned by
 *  IActivityService.showActivity must join the contribution's disposable tree
 *  (via MutableDisposable). The contributions live under the singleton
 *  workbenchStore and are never disposed, so a handle held only by a closure —
 *  without a real parent link — is reported as a leak on unload.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  DisposableStore,
  DisposableTracker,
  markAsSingleton,
  observableValue,
  setDisposableTracker,
  type IObservable,
} from '@universe-editor/platform'
import { ActivityService } from '../../services/activity/ActivityService.js'
import type { IScmService, IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { ScmActivityContribution } from '../ActivityBarBadgeContributions.js'

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
