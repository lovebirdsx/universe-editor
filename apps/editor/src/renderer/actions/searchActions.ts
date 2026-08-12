/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action2 definitions for the Search feature.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  ILayoutService,
  IViewsService,
  IWorkspaceService,
  PartId,
  ViewContainerLocation,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { getActiveTextEditor } from '../services/editor/activeTextEditor.js'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { folderIncludesForSearch } from '../services/search/folderIncludes.js'
import { IQuickTextSearchService } from '../services/search/QuickTextSearchService.js'
import { searchSession } from '../workbench/search/searchSession.js'
import { searchViewState } from '../workbench/search/searchViewState.js'
import { EXPLORER_FOCUS_WHEN, resolvePrimaryTarget } from './fileActionsCommon.js'

const SEED_TEXT_MAX_LENGTH = 200

/** Single-line selection text from the active editor, for seeding the search box. */
function readEditorSelection(accessor: ServicesAccessor): string {
  const groups = accessor.get(IEditorGroupsService)
  const active = getActiveTextEditor(groups)
  const selection = active?.editor.getSelection()
  if (!active || !selection || selection.isEmpty()) return ''
  const text = active.editor.getModel()?.getValueInRange(selection).trim()
  if (!text || text.includes('\n')) return ''
  return text.length > SEED_TEXT_MAX_LENGTH ? text.slice(0, SEED_TEXT_MAX_LENGTH) : text
}

export class FindInFilesAction extends Action2 {
  static readonly ID = 'workbench.action.findInFiles'
  constructor() {
    super({
      id: FindInFilesAction.ID,
      title: localize2('action.findInFiles.title', 'Find in Files'),
      category: localize2('command.category.search', 'Search'),
      keybinding: { primary: 'ctrl+shift+f' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const seed = readEditorSelection(accessor)
    if (seed) {
      searchSession.seedPattern = seed
      // A mounted SearchView won't remount, so nudge it to consume the seed.
      searchViewState.requestSeed()
    }
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

export class FindInFolderAction extends Action2 {
  static readonly ID = 'filesExplorer.findInFolder'
  constructor() {
    super({
      id: FindInFolderAction.ID,
      title: localize2('action.findInFolder.title', 'Find in Folder...'),
      category: localize2('command.category.search', 'Search'),
      keybinding: { primary: 'shift+alt+f', when: EXPLORER_FOCUS_WHEN },
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const layoutService = accessor.get(ILayoutService)
    const tree = accessor.get(IExplorerTreeService)
    const root = accessor.get(IWorkspaceService).current?.folder
    if (!root) return
    const primary = resolvePrimaryTarget(args)
    const folders = tree
      .getContextResourceOperations(primary)
      .filter((operation) => operation.isDirectory)
      .map((operation) => operation.resource)
    if (folders.length === 0) return
    const includes = folderIncludesForSearch(root, folders)
    searchSession.includesText = includes
    searchSession.filtersVisible = true
    // A mounted SearchView won't remount, so nudge it to consume the seed.
    searchSession.seedIncludes = includes
    searchViewState.requestSeedIncludes()
    await layoutService.focusView('workbench.view.search.results', { source: 'command' })
  }
}

export class QuickTextSearchAction extends Action2 {
  static readonly ID = 'workbench.action.quickTextSearch'
  constructor() {
    super({
      id: QuickTextSearchAction.ID,
      title: localize2('action.quickTextSearch.title', 'Quick Search'),
      category: localize2('command.category.search', 'Search'),
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
  const active = getActiveTextEditor(groups)
  const action = active?.editor.getAction(actionId)
  if (action) void action.run()
}

export class FindInFileAction extends Action2 {
  static readonly ID = 'workbench.action.editor.find'
  constructor() {
    super({
      id: FindInFileAction.ID,
      title: localize2('action.find.title', 'Find'),
      category: localize2('command.category.editor', 'Editor'),
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
      title: localize2('action.replace.title', 'Replace'),
      category: localize2('command.category.editor', 'Editor'),
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
      title: localize2('action.findNext.title', 'Find Next'),
      category: localize2('command.category.editor', 'Editor'),
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
      title: localize2('action.findPrevious.title', 'Find Previous'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'shift+f3' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runActiveMonacoAction(accessor, 'editor.action.previousMatchFindAction')
  }
}
