/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Git Graph actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { GitGraphEditorInput } from '../services/editor/GitGraphEditorInput.js'
import { gitGraphViewState } from '../services/gitGraph/gitGraphViewState.js'

const CATEGORY = localize2('command.category.gitGraph', 'Git Graph')

export class ViewGitGraphAction extends Action2 {
  static readonly ID = 'git-graph.view'

  constructor() {
    super({
      id: ViewGitGraphAction.ID,
      title: localize2('action.gitGraph.view', 'View Git Graph'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IEditorService).openEditor(new GitGraphEditorInput())
  }
}

/**
 * Bridge for extension-host / cross-feature callers (MainThreadCommands only
 * lets `_workbench.*` through): open the Git Graph and reveal the given commit.
 * Never declare this id in an extension manifest — it would shadow the
 * renderer handler.
 */
export class OpenGitGraphFromExtensionAction extends Action2 {
  static readonly ID = '_workbench.openGitGraph'

  constructor() {
    super({
      id: OpenGitGraphFromExtensionAction.ID,
      title: localize2('action.gitGraph.open', 'Open Git Graph'),
    })
  }

  override async run(accessor: ServicesAccessor, hash?: unknown): Promise<void> {
    await accessor.get(IEditorService).openEditor(new GitGraphEditorInput())
    if (typeof hash !== 'string' || hash === '') return
    // Always route through the observable pendingReveal, never a directly
    // registered revealCommit: openEditor resolves before React commits the
    // tab switch, so a registered callback could still belong to the
    // about-to-unmount editor instance — its selection/scroll would die with
    // it (the "reveal shows no highlight" bug). The mounted editor consumes
    // pendingReveal reactively, with a fresh closure.
    gitGraphViewState.pendingReveal.set(hash, undefined)
  }
}

export class GitGraphFocusSearchAction extends Action2 {
  static readonly ID = 'git-graph.focusSearch'

  constructor() {
    super({
      id: GitGraphFocusSearchAction.ID,
      title: localize2('action.gitGraph.focusSearch', 'Focus Search'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+f', when: "activeEditorId == 'universe:/gitGraph'" },
      precondition: "activeEditorId == 'universe:/gitGraph'",
      f1: true,
    })
  }

  override run(): void {
    gitGraphViewState.focusSearch?.()
  }
}

export class GitGraphRefreshAction extends Action2 {
  static readonly ID = 'git-graph.refresh'

  constructor() {
    super({
      id: GitGraphRefreshAction.ID,
      title: localize2('action.gitGraph.refresh', 'Refresh'),
      category: CATEGORY,
      // Scoped refresh binding; plain ctrl+r stays with Go to Symbol in Editor
      // (unscoped) so the graph's commit list is reachable through it.
      keybinding: {
        primary: 'ctrl+shift+r',
        when: "activeEditorId == 'universe:/gitGraph'",
        weight: KeybindingWeight.WorkbenchContrib + 50,
      },
      precondition: "activeEditorId == 'universe:/gitGraph'",
      f1: true,
    })
  }

  override run(): void {
    gitGraphViewState.refresh?.()
  }
}

export class GitGraphToggleRemoteBranchesAction extends Action2 {
  static readonly ID = 'git-graph.toggleRemoteBranches'

  constructor() {
    super({
      id: GitGraphToggleRemoteBranchesAction.ID,
      title: localize2('action.gitGraph.toggleRemoteBranches', 'Toggle Remote Branches'),
      category: CATEGORY,
      f1: true,
    })
  }

  override run(): void {
    gitGraphViewState.toggleRemoteBranches?.()
  }
}
