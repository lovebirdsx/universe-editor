/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Feeds the Activity Bar badges from live data sources:
 *  - DirtyEditorsActivityContribution → unsaved file count on the Explorer.
 *  - ScmActivityContribution → changed file count on Source Control.
 *  - SwarmActivityContribution → "Needs My Action" review count on Swarm Reviews.
 *
 *  Both push into IActivityService; the ActivityBar subscribes per container id,
 *  so neither knows about the other or about the rendering layer.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  EditorInput,
  IEditorService,
  IWorkbenchContribution,
  MutableDisposable,
  autorun,
  type IDisposable,
  type IEditorInput,
} from '@universe-editor/platform'
import { IScmService } from '../services/extensions/ScmService.js'
import { IActivityService } from '../services/activity/ActivityService.js'
import { swarmNeedsActionCount } from '../services/swarm/swarmViewState.js'

const EXPLORER_CONTAINER_ID = 'workbench.view.explorer'
const SCM_CONTAINER_ID = 'workbench.view.scm'
const SWARM_CONTAINER_ID = 'workbench.view.swarm'

export class DirtyEditorsActivityContribution extends Disposable implements IWorkbenchContribution {
  private readonly _dirtyListeners = this._register(new DisposableStore())
  private readonly _badge = this._register(new MutableDisposable<IDisposable>())

  constructor(
    @IEditorService editorService: IEditorService,
    @IActivityService private readonly _activityService: IActivityService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const inputs = editorService.openEditors.read(r)
        // Re-subscribe to each input's dirty flag; the list itself only changes
        // on open/close, but dirty flips need their own listener.
        this._dirtyListeners.clear()
        for (const input of inputs) {
          if (input instanceof EditorInput) {
            this._dirtyListeners.add(input.onDidChangeDirty(() => this._update(inputs)))
          }
        }
        this._update(inputs)
      }),
    )
  }

  private _update(inputs: readonly IEditorInput[]): void {
    const dirty = new Set<string>()
    for (const input of inputs) {
      if (input.isDirty) dirty.add(input.id)
    }
    this._badge.value =
      dirty.size > 0
        ? this._activityService.showActivity(EXPLORER_CONTAINER_ID, { count: dirty.size })
        : undefined
  }
}

export class ScmActivityContribution extends Disposable implements IWorkbenchContribution {
  private readonly _badge = this._register(new MutableDisposable<IDisposable>())

  constructor(
    @IScmService scmService: IScmService,
    @IActivityService private readonly _activityService: IActivityService,
  ) {
    super()

    this._register(
      autorun((r) => {
        let total = 0
        for (const sc of scmService.sourceControls.read(r)) total += sc.count.read(r) ?? 0
        this._update(total)
      }),
    )
  }

  private _update(total: number): void {
    this._badge.value =
      total > 0 ? this._activityService.showActivity(SCM_CONTAINER_ID, { count: total }) : undefined
  }
}

/** Mirrors the shared needs-action count (written by the Swarm view while open
 *  and by the background notification poll otherwise) onto the Swarm container. */
export class SwarmActivityContribution extends Disposable implements IWorkbenchContribution {
  private readonly _badge = this._register(new MutableDisposable<IDisposable>())

  constructor(@IActivityService private readonly _activityService: IActivityService) {
    super()

    this._register(
      autorun((r) => {
        const count = swarmNeedsActionCount.observable.read(r)
        this._badge.value =
          count > 0 ? this._activityService.showActivity(SWARM_CONTAINER_ID, { count }) : undefined
      }),
    )
  }
}
