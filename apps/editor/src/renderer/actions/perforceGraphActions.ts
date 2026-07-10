/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Perforce Graph actions.
 *--------------------------------------------------------------------------------------------*/

import { Action2, IEditorService, type ServicesAccessor } from '@universe-editor/platform'
import { PerforceGraphEditorInput } from '../services/editor/PerforceGraphEditorInput.js'
import { perforceGraphViewState } from '../services/perforceGraph/perforceGraphViewState.js'

export class ViewPerforceGraphAction extends Action2 {
  static readonly ID = 'perforce-graph.view'

  constructor() {
    super({
      id: ViewPerforceGraphAction.ID,
      title: 'View Perforce Graph',
      category: 'Perforce Graph',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IEditorService).openEditor(new PerforceGraphEditorInput())
  }
}

export class PerforceGraphFocusSearchAction extends Action2 {
  static readonly ID = 'perforce-graph.focusSearch'

  constructor() {
    super({
      id: PerforceGraphFocusSearchAction.ID,
      title: 'Focus Search',
      category: 'Perforce Graph',
      keybinding: { primary: 'ctrl+f', when: "activeEditorId == 'universe:/perforceGraph'" },
      precondition: "activeEditorId == 'universe:/perforceGraph'",
      f1: true,
    })
  }

  override run(): void {
    perforceGraphViewState.focusSearch?.()
  }
}
