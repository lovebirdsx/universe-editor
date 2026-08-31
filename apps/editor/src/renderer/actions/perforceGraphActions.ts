/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Perforce Graph actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  IWorkspaceService,
  KeybindingWeight,
  URI,
  basename,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { PerforceGraphEditorInput } from '../services/editor/PerforceGraphEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'
import { scmHostPath } from '../services/scm/scmHostPath.js'
import {
  getPerforceGraphViewState,
  perforceGraphViewState,
} from '../services/perforceGraph/perforceGraphViewState.js'

const CATEGORY = localize2('command.category.perforceGraph', 'Perforce Graph')

function reviveScopeResource(value: unknown): URI | undefined {
  if (!URI.isUri(value)) return undefined
  return URI.revive(value) ?? undefined
}

/**
 * Resolve the target of `perforce-graph.viewFileHistory` from its command arg.
 * Handles the two concrete call sites plus the no-arg command palette:
 *   - Explorer context menu → `{ resource: URI, isDirectory }` (a live URI instance)
 *   - SCM file row → `{ resourceUri: string, ... }` (a bare host fs-path)
 * `URI.isUri` also accepts a degraded `UriComponents` so an IPC round-trip is fine.
 */
export function resolveGraphScopeArg(arg: unknown): { uri: URI; isDirectory: boolean } | undefined {
  if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) return undefined
  const a = arg as Record<string, unknown>
  const isDirectory = a['isDirectory'] === true

  const resource = a['resource']
  if (resource !== undefined) {
    const uri = reviveScopeResource(resource)
    return uri ? { uri, isDirectory } : undefined
  }

  const resourceUri = a['resourceUri']
  if (typeof resourceUri === 'string' && resourceUri !== '') {
    return { uri: URI.file(resourceUri), isDirectory: false }
  }

  return undefined
}

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

export class ViewPerforceFileHistoryAction extends Action2 {
  static readonly ID = 'perforce-graph.viewFileHistory'

  constructor() {
    super({
      id: ViewPerforceFileHistoryAction.ID,
      title: localize2('action.perforceGraph.viewFileHistory', 'View File History'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const editorService = accessor.get(IEditorService)
    const workspaceService = accessor.get(IWorkspaceService)

    let scope = resolveGraphScopeArg(arg)
    if (!scope) {
      const active = editorService.activeEditor.get()
      if (active instanceof FileEditorInput) {
        scope = { uri: active.resource, isDirectory: false }
      }
    }
    if (!scope) return

    // File history runs on the SCM host; an off-host resource (a local file in a
    // remote window) has no history there — mirroring dirty-diff's scmHostPath gate.
    const hostPath = scmHostPath(scope.uri, currentRemoteAuthority(workspaceService.current))
    if (hostPath === undefined) return

    await editorService.openEditor(
      new PerforceGraphEditorInput({
        path: hostPath,
        isDirectory: scope.isDirectory,
        label: basename(hostPath),
      }),
    )
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
      keybinding: { primary: 'ctrl+f', when: "activeEditorType == 'perforceGraph'" },
      precondition: "activeEditorType == 'perforceGraph'",
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const active = accessor.get(IEditorService).activeEditor.get()
    if (!(active instanceof PerforceGraphEditorInput)) return
    getPerforceGraphViewState(active.id).focusSearch?.()
  }
}

export class PerforceGraphRefreshAction extends Action2 {
  static readonly ID = 'perforce-graph.refresh'

  constructor() {
    super({
      id: PerforceGraphRefreshAction.ID,
      title: localize2('action.perforceGraph.refresh', 'Refresh'),
      category: CATEGORY,
      // Scoped refresh binding; plain ctrl+r stays with Go to Symbol in Editor
      // (unscoped) so the graph's change list is reachable through it.
      keybinding: {
        primary: 'ctrl+shift+r',
        when: "activeEditorType == 'perforceGraph'",
        weight: KeybindingWeight.WorkbenchContrib + 50,
      },
      precondition: "activeEditorType == 'perforceGraph'",
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const active = accessor.get(IEditorService).activeEditor.get()
    if (!(active instanceof PerforceGraphEditorInput)) return
    getPerforceGraphViewState(active.id).refresh?.()
  }
}
