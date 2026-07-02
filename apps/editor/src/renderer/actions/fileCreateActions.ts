/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Create actions: new file (Explorer or untitled buffer) / new folder.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  IWorkspaceService,
  MenuId,
  URI,
  localize,
  localize2,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { parentOf } from '../services/explorer/explorerTreeUtils.js'
import { reviveUri } from './fileActionsCommon.js'

interface IParentArg {
  readonly parent?: URI | UriComponents
  readonly resource?: URI | UriComponents
  readonly isDirectory?: boolean
}

function resolveParent(accessor: ServicesAccessor, args: IParentArg | undefined): URI | null {
  const explicit = args?.parent ? reviveUri(args.parent) : null
  if (explicit) return explicit
  const resource = args?.resource ? reviveUri(args.resource) : null
  if (resource) return args?.isDirectory === true ? resource : parentOf(resource)
  const workspace = accessor.get(IWorkspaceService)
  return workspace.current?.folder ?? null
}

export class NewUntitledFileAction extends Action2 {
  static readonly ID = 'workbench.action.files.newUntitledFile'
  constructor() {
    super({
      id: NewUntitledFileAction.ID,
      title: localize2('action.newUntitledFile.title', 'New File'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+n', when: '!terminalFocus' },
      menu: { id: MenuId.MenubarFileMenu, group: '1_new', order: 0 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const inst = accessor.get(IInstantiationService)
    const groups = accessor.get(IEditorGroupsService)
    const input = inst.createInstance(UntitledEditorInput)
    openInLockAwareGroup(groups, input, { activate: true })
  }
}

export class NewFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.newFile'
  constructor() {
    super({
      id: NewFileAction.ID,
      title: localize2('action.newFile.title', 'New File…'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const parent = resolveParent(accessor, args[0] as IParentArg)
    if (!parent) return
    const dialog = accessor.get(IDialogService)
    const tree = accessor.get(IExplorerTreeService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)

    const name = await dialog.prompt({
      title: localize('dialog.file.prompt.newFile', 'New File'),
      placeholder: localize('common.name', 'Name'),
    })
    if (!name) return
    try {
      const created = await tree.createFile(parent, name)
      const input = inst.createInstance(FileEditorInput, created)
      openInLockAwareGroup(groups, input, { activate: true })
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.create.error.file', 'Failed to create file'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}

export class NewFolderAction extends Action2 {
  static readonly ID = 'workbench.files.action.newFolder'
  constructor() {
    super({
      id: NewFolderAction.ID,
      title: localize2('action.newFolder.title', 'New Folder…'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const parent = resolveParent(accessor, args[0] as IParentArg)
    if (!parent) return
    const dialog = accessor.get(IDialogService)
    const tree = accessor.get(IExplorerTreeService)

    const name = await dialog.prompt({
      title: localize('dialog.file.prompt.newFolder', 'New Folder'),
      placeholder: localize('common.name', 'Name'),
    })
    if (!name) return
    try {
      await tree.createFolder(parent, name)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.create.error.folder', 'Failed to create folder'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}
