/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Save / Save As actions for the active editor.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  GroupsOrder,
  ICommandService,
  IEditorGroupsService,
  IFileDialogService,
  IFileService,
  IInstantiationService,
  IWorkspaceService,
  MenuId,
  URI,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { parentOf } from '../services/explorer/explorerTreeUtils.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'

export class SaveFileAction extends Action2 {
  static readonly ID = 'workbench.action.files.save'
  constructor() {
    super({
      id: SaveFileAction.ID,
      title: localize2('action.save.title', 'Save'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+s' },
      menu: { id: MenuId.MenubarFileMenu, group: '4_save', order: 1 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService)
    const active = groups.activeGroup.activeEditor
    if (!active) return
    if (active instanceof UntitledEditorInput) {
      await accessor.get(ICommandService).executeCommand(SaveFileAsAction.ID)
      return
    }
    await active.save?.()
  }
}

export class SaveFileAsAction extends Action2 {
  static readonly ID = 'workbench.action.files.saveAs'
  constructor() {
    super({
      id: SaveFileAsAction.ID,
      title: localize2('action.saveAs.title', 'Save As…'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+shift+s' },
      menu: { id: MenuId.MenubarFileMenu, group: '4_save', order: 2 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService)
    const active = groups.activeGroup.activeEditor
    if (!(active instanceof FileEditorInput) && !(active instanceof UntitledEditorInput)) return
    const fileDialog = accessor.get(IFileDialogService)
    const fileService = accessor.get(IFileService)
    const inst = accessor.get(IInstantiationService)

    const defaultPath = resolveDefaultSavePath(active, groups, accessor)
    const picked = await fileDialog.showSaveDialog({
      title: localize('fileDialog.saveAs.title', 'Save As'),
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: localize('fileDialog.save', 'Save'),
      defaultUri: URI.file(defaultPath),
    })
    if (!picked) return

    // Resolve current text via the existing model; fall back to disk (file) or
    // empty (untitled) if unsaved.
    const text =
      active instanceof FileEditorInput
        ? active.isResolved
          ? await readActiveText(active)
          : await active.resolve()
        : await readUntitledText(active)
    await fileService.writeFile(picked, text)

    // Replace the editor with one bound to the new resource. The original input
    // is closed; its dirty state goes with it.
    const newInput = inst.createInstance(FileEditorInput, picked)
    groups.activeGroup.openEditor(newInput, { activate: true })
    groups.activeGroup.closeEditor(active)
  }
}

function resolveDefaultSavePath(
  active: FileEditorInput | UntitledEditorInput,
  groups: IEditorGroupsService,
  accessor: ServicesAccessor,
): string {
  if (active instanceof FileEditorInput) return active.resource.fsPath
  const filename = active.getName() + '.txt'
  // 1. Last active file editor's directory
  for (const group of groups.getGroups(GroupsOrder.MostRecentlyActive)) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput) {
        const dir = parentOf(editor.resource)
        if (dir) return URI.joinPath(dir, filename).fsPath
      }
    }
  }
  // 2. Workspace/project folder
  const folder = accessor.get(IWorkspaceService).current?.folder
  if (folder) return URI.joinPath(folder, filename).fsPath
  // 3. System default
  return filename
}

async function readUntitledText(input: UntitledEditorInput): Promise<string> {
  const model = MonacoModelRegistry.peek(input.resource)
  return model?.getValue() ?? ''
}

async function readActiveText(input: FileEditorInput): Promise<string> {
  // FileEditorInput.save reads through MonacoModelRegistry.peek which returns
  // null if no model has been acquired. Resolve as fallback.
  const text = await input.resolve()
  return text
}

export class SaveAllFilesAction extends Action2 {
  static readonly ID = 'workbench.action.files.saveAll'
  constructor() {
    super({
      id: SaveAllFilesAction.ID,
      title: localize2('action.saveAll.title', 'Save All'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+alt+s' },
      menu: { id: MenuId.MenubarFileMenu, group: '4_save', order: 3 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService)
    const saves: Promise<boolean>[] = []
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof UntitledEditorInput) continue
        if (!editor.isDirty || !editor.save) continue
        saves.push(editor.save())
      }
    }
    await Promise.all(saves)
  }
}
