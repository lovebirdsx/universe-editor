/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Git Graph actions.
 *--------------------------------------------------------------------------------------------*/

import { Action2, IEditorService, type ServicesAccessor } from '@universe-editor/platform'
import { GitGraphEditorInput } from '../services/editor/GitGraphEditorInput.js'
import { gitGraphViewState } from '../services/gitGraph/gitGraphViewState.js'

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

export class GitGraphFocusSearchAction extends Action2 {
  static readonly ID = 'git-graph.focusSearch'

  constructor() {
    super({
      id: GitGraphFocusSearchAction.ID,
      title: 'Focus Search',
      category: 'Git Graph',
      keybinding: { primary: 'ctrl+f', when: "activeEditorId == 'universe:/gitGraph'" },
      precondition: "activeEditorId == 'universe:/gitGraph'",
      f1: true,
    })
  }

  override run(): void {
    gitGraphViewState.focusSearch?.()
  }
}

export class GitGraphToggleRemoteBranchesAction extends Action2 {
  static readonly ID = 'git-graph.toggleRemoteBranches'

  constructor() {
    super({
      id: GitGraphToggleRemoteBranchesAction.ID,
      title: 'Toggle Remote Branches',
      category: 'Git Graph',
      f1: true,
    })
  }

  override run(): void {
    gitGraphViewState.toggleRemoteBranches?.()
  }
}
