/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Developer actions for performance diagnostics.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { StartupPerformanceInput } from '../services/editor/StartupPerformanceInput.js'

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

  override run(accessor: ServicesAccessor): void {
    accessor
      .get(IEditorGroupsService)
      .activeGroup.openEditor(new StartupPerformanceInput(), { activate: true, pinned: true })
  }
}
