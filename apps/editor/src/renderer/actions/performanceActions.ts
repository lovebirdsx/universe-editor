/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Developer actions for performance diagnostics.
 *--------------------------------------------------------------------------------------------*/

import { Action2, localize2, type ServicesAccessor } from '@universe-editor/platform'
import { StartupPerformanceInput } from '../services/editor/StartupPerformanceInput.js'
import { InteractionPerformanceInput } from '../services/editor/InteractionPerformanceInput.js'
import { invocationOpenTarget } from '../services/editor/openTarget.js'
import {
  openPinnedSingletonEditor,
  openTargetServicesFrom,
} from '../services/editor/openWithTarget.js'

export class ShowStartupPerformanceAction extends Action2 {
  static readonly ID = 'workbench.action.showStartupPerformance'

  constructor() {
    super({
      id: ShowStartupPerformanceAction.ID,
      title: localize2('action.showStartupPerformance.title', 'Startup Performance'),
      category: localize2('command.category.developer', 'Developer'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): Promise<boolean> {
    return openPinnedSingletonEditor(
      openTargetServicesFrom(accessor),
      invocationOpenTarget(),
      () => new StartupPerformanceInput(),
    )
  }
}

export class ShowInteractionPerformanceAction extends Action2 {
  static readonly ID = 'workbench.action.showInteractionPerformance'

  constructor() {
    super({
      id: ShowInteractionPerformanceAction.ID,
      title: localize2('action.showInteractionPerformance.title', 'Interaction Performance'),
      category: localize2('command.category.developer', 'Developer'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): Promise<boolean> {
    return openPinnedSingletonEditor(
      openTargetServicesFrom(accessor),
      invocationOpenTarget(),
      () => new InteractionPerformanceInput(),
    )
  }
}
