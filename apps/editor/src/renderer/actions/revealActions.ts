/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RevealInExplorerAction — VSCode-compatible `revealInExplorer`: reveals the
 *  target file in the Explorer tree. RevealActiveFileInExplorerAction keeps the
 *  F1 command palette entry and shares the same implementation.
 *  RevealInOSExplorerAction — opens the OS file manager with the file selected.
 *  Resolution order: explicit command arg (URI / context object / SCM resource)
 *  → active file editor → current Explorer selection → workspace folder fallback.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IHostService,
  ILayoutService,
  IWorkspaceService,
  MenuId,
  URI,
  localize2,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'

const URI_STRING_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const EXPLORER_TREE_VIEW_ID = 'workbench.view.explorer.tree'

function reviveUriLike(value: unknown): URI | null {
  if (!value) return null
  if (value instanceof URI) return value
  if (typeof value === 'string') {
    return URI_STRING_RE.test(value) ? URI.parse(value) : URI.file(value)
  }
  if (URI.isUri(value)) return URI.revive(value as URI | UriComponents) ?? null
  return null
}

function resourceFromArg(arg: unknown): URI | null {
  const direct = reviveUriLike(arg)
  if (direct) return direct
  if (!arg || typeof arg !== 'object') return null
  const obj = arg as Record<string, unknown>
  return (
    reviveUriLike(obj['resource']) ??
    reviveUriLike(obj['target']) ??
    reviveUriLike(obj['uri']) ??
    reviveUriLike(obj['resourceUri'])
  )
}

function activeFileResource(accessor: ServicesAccessor): URI | null {
  const groups = accessor.get(IEditorGroupsService)
  const active = groups.activeGroup.activeEditor
  return active instanceof FileEditorInput ? active.resource : null
}

async function revealInExplorer(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
  const resource = resourceFromArg(args[0]) ?? activeFileResource(accessor)
  if (!resource || resource.scheme !== 'file') return
  const layoutService = accessor.get(ILayoutService)
  const treeService = accessor.get(IExplorerTreeService)
  await layoutService.focusView(EXPLORER_TREE_VIEW_ID, { source: 'command' })
  await treeService.reveal(resource)
}

export class RevealInExplorerAction extends Action2 {
  static readonly ID = 'revealInExplorer'
  constructor() {
    super({
      id: RevealInExplorerAction.ID,
      title: localize2('action.revealInExplorer.title', 'Reveal in Explorer View'),
      category: localize2('command.category.file', 'File'),
      menu: [{ id: MenuId.EditorTabContext, group: 'reveal', order: 1 }],
      f1: false,
    })
  }
  override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    return revealInExplorer(accessor, ...args)
  }
}

export class RevealActiveFileInExplorerAction extends Action2 {
  static readonly ID = 'workbench.files.action.revealActiveFileInExplorer'
  constructor() {
    super({
      id: RevealActiveFileInExplorerAction.ID,
      title: localize2('action.revealActiveFileInExplorer.title', 'Reveal Active File in Explorer'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    return revealInExplorer(accessor, ...args)
  }
}

export class RevealInOSExplorerAction extends Action2 {
  static readonly ID = 'workbench.files.action.revealInOsExplorer'
  constructor() {
    super({
      id: RevealInOSExplorerAction.ID,
      title: localize2('action.openContainingFolder.title', 'Open Containing Folder'),
      category: localize2('command.category.file', 'File'),
      keybinding: {
        primary: 'alt+shift+e',
      },
      menu: [{ id: MenuId.EditorTabContext, group: 'reveal', order: 2 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const explicit = resourceFromArg(args[0])
    let resource: URI | null = explicit
    if (!resource) resource = activeFileResource(accessor)
    if (!resource) resource = accessor.get(IExplorerTreeService).selectedResource
    if (!resource) resource = accessor.get(IWorkspaceService).current?.folder ?? null
    if (!resource || resource.scheme !== 'file') return
    await accessor.get(IHostService).showItemInFolder(resource.fsPath)
  }
}
