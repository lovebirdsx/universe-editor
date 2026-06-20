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
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IQuickTextSearchService } from '../services/search/QuickTextSearchService.js'
import { searchSession } from '../workbench/search/searchSession.js'
import { searchViewState } from '../workbench/search/searchViewState.js'

const SEED_TEXT_MAX_LENGTH = 200

/** Single-line selection text from the active editor, for seeding the search box. */
function readEditorSelection(accessor: ServicesAccessor): string {
  const groups = accessor.get(IEditorGroupsService)
  const active = groups.activeGroup.activeEditor
  if (!(active instanceof FileEditorInput)) return ''
  const editor = FileEditorRegistry.get(active, groups.activeGroup.id)
  const selection = editor?.getSelection()
  if (!editor || !selection || selection.isEmpty()) return ''
  const text = editor.getModel()?.getValueInRange(selection).trim()
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
