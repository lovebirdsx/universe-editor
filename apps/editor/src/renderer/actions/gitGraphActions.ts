/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Git Graph actions.
 *--------------------------------------------------------------------------------------------*/

import { Action2, IEditorService, type ServicesAccessor } from '@universe-editor/platform'
import { GitGraphEditorInput } from '../services/editor/GitGraphEditorInput.js'

export class ViewGitGraphAction extends Action2 {
  static readonly ID = 'git-graph.view'

  constructor() {
    super({
      id: ViewGitGraphAction.ID,
      title: 'View Git Graph',
      category: 'Git Graph',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IEditorService).openEditor(new GitGraphEditorInput())
  }
}
