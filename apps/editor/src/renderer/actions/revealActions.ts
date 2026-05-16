/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RevealActiveFileInExplorerAction — Ctrl+Shift+E (and the tab right-click
 *  entry) activates the Explorer container, expands ancestors, and selects the
 *  resource. Falls back to the active editor's resource when no argument is
 *  supplied.
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
      title: '在资源管理器中显示活动文件',
      category: 'File',
      keybinding: { primary: 'ctrl+shift+e' },
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
    accessor.get(IViewsService).openViewContainer('explorer')
    await accessor.get(IExplorerTreeService).reveal(resource)
  }
}
