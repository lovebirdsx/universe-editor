/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Feeds the Activity Bar badges from live data sources:
 *  - DirtyEditorsActivityContribution → unsaved file count on the Explorer.
 *  - ScmActivityContribution → changed file count on Source Control.
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
  autorun,
  toDisposable,
  type IDisposable,
  type IEditorInput,
} from '@universe-editor/platform'
import { IScmService } from '../services/extensions/ScmService.js'
import { IActivityService } from '../services/activity/ActivityService.js'

const EXPLORER_CONTAINER_ID = 'workbench.view.explorer'
const SCM_CONTAINER_ID = 'workbench.view.scm'

export class DirtyEditorsActivityContribution extends Disposable implements IWorkbenchContribution {
  private readonly _dirtyListeners = this._register(new DisposableStore())
  private _badgeHandle: IDisposable | undefined

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
    this._register(toDisposable(() => this._badgeHandle?.dispose()))
  }

  private _update(inputs: readonly IEditorInput[]): void {
    const dirty = new Set<string>()
    for (const input of inputs) {
      if (input.isDirty) dirty.add(input.id)
    }
    this._badgeHandle?.dispose()
    this._badgeHandle =
      dirty.size > 0
        ? this._activityService.showActivity(EXPLORER_CONTAINER_ID, { count: dirty.size })
        : undefined
  }
}

export class ScmActivityContribution extends Disposable implements IWorkbenchContribution {
  private _badgeHandle: IDisposable | undefined

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
    this._register(toDisposable(() => this._badgeHandle?.dispose()))
  }

  private _update(total: number): void {
    this._badgeHandle?.dispose()
    this._badgeHandle =
      total > 0 ? this._activityService.showActivity(SCM_CONTAINER_ID, { count: total }) : undefined
  }
}
