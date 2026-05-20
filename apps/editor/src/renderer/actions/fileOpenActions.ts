/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Open / OpenRecent / OpenWithDefaultApp / ClearRecent / Refresh actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorGroupsService,
  IFileService,
  IHostService,
  IInstantiationService,
  IQuickInputService,
  IWorkspaceService,
  MenuId,
  URI,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IRecentFilesService } from '../services/recentFiles/recentFilesService.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { confirmLargeFile } from '../services/editor/largeFileGuard.js'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { parentOf } from '../services/explorer/explorerTreeUtils.js'
import { reviveUri, type ITargetArg } from './fileActionsCommon.js'

export class OpenFileAction extends Action2 {
  static readonly ID = 'workbench.action.files.openFile'
  constructor() {
    super({
      id: OpenFileAction.ID,
      title: localize('action.openFile.title', 'Open File…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+o' },
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 0 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const host = accessor.get(IHostService)
    const workspace = accessor.get(IWorkspaceService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const fileService = accessor.get(IFileService)
    const dialog = accessor.get(IDialogService)

    const picked = reviveUri(
      await host.showOpenFileDialog({
        ...(workspace.current ? { defaultPath: workspace.current.folder.fsPath } : {}),
      }),
    )
    if (!picked) return
    if (!(await confirmLargeFile(picked, fileService, dialog))) return
    const input = inst.createInstance(FileEditorInput, picked)
    groups.activeGroup.openEditor(input, { activate: true })
  }
}

export class OpenRecentFilesAction extends Action2 {
  static readonly ID = 'workbench.action.openRecentFile'
  constructor() {
    super({
      id: OpenRecentFilesAction.ID,
      title: localize('action.openRecentFile.title', 'Open Recent File…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+p' },
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 2 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const recentFiles = accessor.get(IRecentFilesService)
    const quickInput = accessor.get(IQuickInputService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)

    const items = await recentFiles.getAll()
    if (items.length === 0) return

    const pickItems = items.map((f) => ({
      id: f.uri.toString(),
      label: f.name,
      description: f.uri.fsPath,
    }))

    const pick = await quickInput.pick(pickItems, {
      id: 'workbench.recentFiles',
      placeholder: localize('quickInput.openRecentFile.placeholder', 'Open Recent File…'),
    })
    if (!pick) return

    const uri = URI.parse(pick.id)

    // Activate if already open in any group.
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput && editor.resource.toString() === uri.toString()) {
          groups.activateGroup(group)
          group.setActive(editor)
          return
        }
      }
    }

    const input = inst.createInstance(FileEditorInput, uri)
    groups.activeGroup.openEditor(input, { activate: true })
  }
}

export class ClearRecentFilesAction extends Action2 {
  static readonly ID = 'workbench.action.clearRecentFiles'
  constructor() {
    super({
      id: ClearRecentFilesAction.ID,
      title: localize('action.clearRecentFiles.title', 'Clear Recently Opened Files'),
      category: localize('command.category.file', 'File'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IRecentFilesService).clear()
  }
}

export class OpenWithDefaultAppAction extends Action2 {
  static readonly ID = 'workbench.files.action.openWithDefaultApp'
  constructor() {
    super({
      id: OpenWithDefaultAppAction.ID,
      title: localize('action.openWithDefaultApplication.title', 'Open with Default Application'),
      category: localize('command.category.file', 'File'),
      f1: false,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const target = reviveUri((args[0] as ITargetArg | undefined)?.target ?? null)
    if (!target) return
    const host = accessor.get(IHostService)
    const err = await host.openWithDefaultApp(target.fsPath)
    if (err) {
      const dialog = accessor.get(IDialogService)
      await dialog.confirm({
        message: localize('dialog.file.open.error', 'Unable to open file'),
        detail: err,
        type: 'error',
      })
    }
  }
}

export class RefreshExplorerAction extends Action2 {
  static readonly ID = 'workbench.files.action.refresh'
  constructor() {
    super({
      id: RefreshExplorerAction.ID,
      title: localize('action.refresh.title', 'Refresh Explorer'),
      category: localize('command.category.file', 'File'),
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const arg = args[0] as ITargetArg | undefined
    const resourceArg = reviveUri(arg?.resource ?? null)
    const parentArg = reviveUri(arg?.parent ?? null)
    const resource = resourceArg
      ? arg?.isDirectory === true
        ? resourceArg
        : (parentArg ?? parentOf(resourceArg) ?? resourceArg)
      : tree.root
    if (!resource) return
    await tree.refresh(resource)
  }
}
