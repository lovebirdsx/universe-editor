/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Save / Save As actions for the active editor.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IEditorGroupsService,
  IFileService,
  IHostService,
  IInstantiationService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { reviveUri } from './fileActionsCommon.js'

export class SaveFileAction extends Action2 {
  static readonly ID = 'workbench.action.files.save'
  constructor() {
    super({
      id: SaveFileAction.ID,
      title: localize('action.save.title', 'Save'),
      category: localize('command.category.file', 'File'),
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
      title: localize('action.saveAs.title', 'Save As…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+shift+s' },
      menu: { id: MenuId.MenubarFileMenu, group: '4_save', order: 2 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService)
    const active = groups.activeGroup.activeEditor
    if (!(active instanceof FileEditorInput) && !(active instanceof UntitledEditorInput)) return
    const host = accessor.get(IHostService)
    const fileService = accessor.get(IFileService)
    const inst = accessor.get(IInstantiationService)

    const defaultPath =
      active instanceof FileEditorInput ? active.resource.fsPath : active.getName() + '.txt'
    const picked = reviveUri(await host.showSaveFileDialog({ defaultPath }))
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
