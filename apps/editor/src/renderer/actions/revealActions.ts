/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RevealActiveFileInExplorerAction — reveals the active file in the Explorer
 *  tree (tab right-click entry and F1 command palette). Ctrl+Shift+E is owned
 *  by ShowExplorerAction (show/hide toggle); this action has no default binding.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IViewsService,
  MenuId,
  URI,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'
import { IExplorerTreeService } from '../workbench/explorer/ExplorerTreeService.js'

interface IRevealArgs {
  readonly resource?: URI | UriComponents
}

function reviveResource(value: URI | UriComponents | undefined): URI | null {
  if (!value) return null
  if (value instanceof URI) return value
  return URI.revive(value) ?? null
}

export class RevealActiveFileInExplorerAction extends Action2 {
  static readonly ID = 'workbench.files.action.revealActiveFileInExplorer'
  constructor() {
    super({
      id: RevealActiveFileInExplorerAction.ID,
      title: 'Reveal Active File in Explorer',
      category: 'File',
      menu: [{ id: MenuId.EditorTabContext, group: 'reveal', order: 1 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const explicit = reviveResource((args[0] as IRevealArgs | undefined)?.resource)
    let resource: URI | null = explicit
    if (!resource) {
      const groups = accessor.get(IEditorGroupsService)
      const active = groups.activeGroup.activeEditor
      if (active instanceof FileEditorInput) resource = active.resource
    }
    if (!resource || resource.scheme !== 'file') return
    accessor.get(IViewsService).openViewContainer('workbench.view.explorer')
    await accessor.get(IExplorerTreeService).reveal(resource)
  }
}
