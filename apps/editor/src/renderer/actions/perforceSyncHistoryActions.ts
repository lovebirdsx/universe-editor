/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Perforce Sync History action.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { PerforceSyncHistoryEditorInput } from '../services/editor/PerforceSyncHistoryEditorInput.js'

export class ViewPerforceSyncHistoryAction extends Action2 {
  static readonly ID = 'perforce-sync-history.view'

  constructor() {
    super({
      id: ViewPerforceSyncHistoryAction.ID,
      title: localize2('action.perforceSyncHistory.view', 'View Sync History'),
      // The extension's own commands all sit under "Perforce", and this page is
      // about the same thing they are — grouping it with the graph would file a
      // record of every get under a name that says "graph".
      category: localize2('command.category.perforce', 'Perforce'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IEditorService).openEditor(new PerforceSyncHistoryEditorInput())
  }
}
