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
  ViewContainerLocation,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IQuickTextSearchService } from '../services/search/QuickTextSearchService.js'

export class FindInFilesAction extends Action2 {
  static readonly ID = 'workbench.action.findInFiles'
  constructor() {
    super({
      id: FindInFilesAction.ID,
      title: localize('action.findInFiles.title', 'Find in Files'),
      category: localize('command.category.search', 'Search'),
      keybinding: { primary: 'ctrl+shift+f' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const sidebarVisible = layoutService.getVisible(PartId.SideBar)
    const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
    if (
      sidebarVisible &&
      activeId === 'workbench.view.search' &&
      layoutService.getPart(PartId.SideBar)?.isFocused()
    ) {
      layoutService.setVisible(PartId.SideBar, false)
      return
    }
    await layoutService.focusView('workbench.view.search.results', { source: 'command' })
  }
}

export class QuickTextSearchAction extends Action2 {
  static readonly ID = 'workbench.action.quickTextSearch'
  constructor() {
    super({
      id: QuickTextSearchAction.ID,
      title: localize('action.quickTextSearch.title', 'Quick Search'),
      category: localize('command.category.search', 'Search'),
      keybinding: { primary: 'ctrl+q' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IQuickTextSearchService).show()
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
      title: localize('action.find.title', 'Find'),
      category: localize('command.category.editor', 'Editor'),
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
      title: localize('action.replace.title', 'Replace'),
      category: localize('command.category.editor', 'Editor'),
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
      title: localize('action.findNext.title', 'Find Next'),
      category: localize('command.category.editor', 'Editor'),
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
      title: localize('action.findPrevious.title', 'Find Previous'),
      category: localize('command.category.editor', 'Editor'),
      keybinding: { primary: 'shift+f3' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runActiveMonacoAction(accessor, 'editor.action.previousMatchFindAction')
  }
}
