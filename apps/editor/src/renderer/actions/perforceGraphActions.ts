/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Perforce Graph actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { PerforceGraphEditorInput } from '../services/editor/PerforceGraphEditorInput.js'
import { perforceGraphViewState } from '../services/perforceGraph/perforceGraphViewState.js'

const CATEGORY = localize2('command.category.perforceGraph', 'Perforce Graph')

export class ViewPerforceGraphAction extends Action2 {
  static readonly ID = 'perforce-graph.view'

  constructor() {
    super({
      id: ViewPerforceGraphAction.ID,
      title: localize2('action.perforceGraph.view', 'View Perforce Graph'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IEditorService).openEditor(new PerforceGraphEditorInput())
  }
}

/**
 * Bridge for extension-host / cross-feature callers (MainThreadCommands only
 * lets `_workbench.*` through): open the Perforce Graph and reveal the given
 * changelist. Never declare this id in an extension manifest — it would shadow
 * the renderer handler.
 */
export class OpenPerforceGraphFromExtensionAction extends Action2 {
  static readonly ID = '_workbench.openPerforceGraph'

  constructor() {
    super({
      id: OpenPerforceGraphFromExtensionAction.ID,
      title: localize2('action.perforceGraph.open', 'Open Perforce Graph'),
    })
  }

  override async run(accessor: ServicesAccessor, changelist?: unknown): Promise<void> {
    await accessor.get(IEditorService).openEditor(new PerforceGraphEditorInput())
    if (typeof changelist !== 'string' || changelist === '') return
    // Always route through the observable pendingReveal, never a directly
    // registered revealCommit — see OpenGitGraphFromExtensionAction for why
    // (a stale editor instance would swallow the reveal's selection).
    perforceGraphViewState.pendingReveal.set(changelist, undefined)
  }
}

export class PerforceGraphFocusSearchAction extends Action2 {
  static readonly ID = 'perforce-graph.focusSearch'

  constructor() {
    super({
      id: PerforceGraphFocusSearchAction.ID,
      title: localize2('action.perforceGraph.focusSearch', 'Focus Search'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+f', when: "activeEditorId == 'universe:/perforceGraph'" },
      precondition: "activeEditorId == 'universe:/perforceGraph'",
      f1: true,
    })
  }

  override run(): void {
    perforceGraphViewState.focusSearch?.()
  }
}

export class PerforceGraphRefreshAction extends Action2 {
  static readonly ID = 'perforce-graph.refresh'

  constructor() {
    super({
      id: PerforceGraphRefreshAction.ID,
      title: localize2('action.perforceGraph.refresh', 'Refresh'),
      category: CATEGORY,
      // Outranks the unscoped Open Recent (ctrl+r) binding — resolution is
      // weight-first, when-clauses only filter, they don't boost priority.
      keybinding: {
        primary: 'ctrl+r',
        when: "activeEditorId == 'universe:/perforceGraph'",
        weight: KeybindingWeight.WorkbenchContrib + 50,
      },
      precondition: "activeEditorId == 'universe:/perforceGraph'",
      f1: true,
    })
  }

  override run(): void {
    perforceGraphViewState.refresh?.()
  }
}
