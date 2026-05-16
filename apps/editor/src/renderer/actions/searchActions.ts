/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action2 definitions for the Search feature.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  ILayoutService,
  IViewsService,
  PartId,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../workbench/editor/FileEditorRegistry.js'

export const SEARCH_FOCUS_INPUT_EVENT = 'search:focus-input'

export class FindInFilesAction extends Action2 {
  static readonly ID = 'workbench.action.findInFiles'
  constructor() {
    super({
      id: FindInFilesAction.ID,
      title: '在文件中查找',
      category: 'Search',
      keybinding: { primary: 'ctrl+shift+f' },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor, args?: { query?: string }): void {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    if (!layoutService.getVisible(PartId.SideBar)) {
      layoutService.setVisible(PartId.SideBar, true)
    }
    viewsService.openViewContainer('workbench.view.search')
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(
        new CustomEvent(SEARCH_FOCUS_INPUT_EVENT, { detail: args?.query ?? null }),
      )
    }
  }
}

function runActiveMonacoAction(accessor: ServicesAccessor, actionId: string): void {
  const groups = accessor.get(IEditorGroupsService)
  const active = groups.activeGroup.activeEditor
  if (!(active instanceof FileEditorInput)) return
  const editor = FileEditorRegistry.get(active)
  const action = editor?.getAction(actionId)
  if (action) void action.run()
}

export class FindInFileAction extends Action2 {
  static readonly ID = 'workbench.action.editor.find'
  constructor() {
    super({
      id: FindInFileAction.ID,
      title: '查找',
      category: 'Editor',
      keybinding: { primary: 'ctrl+f' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runActiveMonacoAction(accessor, 'actions.find')
  }
}

export class FindReplaceInFileAction extends Action2 {
  static readonly ID = 'workbench.action.editor.findReplace'
  constructor() {
    super({
      id: FindReplaceInFileAction.ID,
      title: '替换',
      category: 'Editor',
      keybinding: { primary: 'ctrl+h' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runActiveMonacoAction(accessor, 'editor.action.startFindReplaceAction')
  }
}

export class FindNextAction extends Action2 {
  static readonly ID = 'workbench.action.editor.findNext'
  constructor() {
    super({
      id: FindNextAction.ID,
      title: '查找下一个',
      category: 'Editor',
      keybinding: { primary: 'f3' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runActiveMonacoAction(accessor, 'editor.action.nextMatchFindAction')
  }
}

export class FindPreviousAction extends Action2 {
  static readonly ID = 'workbench.action.editor.findPrevious'
  constructor() {
    super({
      id: FindPreviousAction.ID,
      title: '查找上一个',
      category: 'Editor',
      keybinding: { primary: 'shift+f3' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runActiveMonacoAction(accessor, 'editor.action.previousMatchFindAction')
  }
}
