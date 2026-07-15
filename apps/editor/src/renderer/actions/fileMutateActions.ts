/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mutate actions on existing Explorer entries: rename / delete.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IDialogService,
  IHostService,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'
import { IExplorerFileOperationService } from '../services/explorer/ExplorerFileOperationService.js'
import {
  EXPLORER_FOCUS_WHEN,
  implicitCommandResource,
  resolveContextOperations,
  reviveUri,
  type ITargetArg,
} from './fileActionsCommon.js'

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

function trashName(platform: string): string {
  return platform === 'win32'
    ? localize('trash.recycleBin', 'Recycle Bin')
    : localize('trash.trash', 'Trash')
}

function isDirectoryTarget(
  tree: ExplorerTreeService,
  target: ReturnType<typeof reviveUri>,
): boolean {
  if (!target) return false
  if (tree.root?.toString() === target.toString()) return true
  return tree
    .getVisibleEntries()
    .some((entry) => entry.isDirectory && entry.resource.toString() === target.toString())
}

function resolveTarget(
  accessor: ServicesAccessor,
  tree: ExplorerTreeService,
  args: ITargetArg | undefined,
): { target: ReturnType<typeof reviveUri>; isDirectory: boolean } {
  const explicit = reviveUri(args?.target ?? args?.resource ?? null)
  if (explicit) {
    return { target: explicit, isDirectory: args?.isDirectory === true }
  }
  const target = implicitCommandResource(accessor, tree)
  return { target, isDirectory: isDirectoryTarget(tree, target) }
}

export class RenameFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.rename'
  constructor() {
    super({
      id: RenameFileAction.ID,
      title: localize2('action.rename.title', 'Rename…'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'f2', when: EXPLORER_FOCUS_WHEN },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const { target } = resolveTarget(accessor, tree, args[0] as ITargetArg | undefined)
    if (!target) return
    const dialog = accessor.get(IDialogService)
    const fileOps = accessor.get(IExplorerFileOperationService)

    const current = basename(target.fsPath)
    const next = await dialog.prompt({
      title: localize('dialog.file.prompt.rename', 'Rename'),
      initialValue: current,
    })
    if (!next || next === current) return
    try {
      await fileOps.rename(target, next)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.rename.error', 'Failed to rename'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}

export class DeleteFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.delete'
  constructor() {
    super({
      id: DeleteFileAction.ID,
      title: localize2('action.deleteFile.title', 'Delete'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'delete', when: EXPLORER_FOCUS_WHEN },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const targets = resolveContextOperations(accessor, tree, [
      (args[0] as ITargetArg | undefined) ?? {},
    ])
    if (targets.length === 0) return
    const dialog = accessor.get(IDialogService)
    const config = accessor.get(IConfigurationService)
    const platform = accessor.get(IHostService).platform
    const fileOps = accessor.get(IExplorerFileOperationService)

    const useTrash = config.get<boolean>('files.enableTrash') !== false
    const confirmDelete = config.get<boolean>('explorer.confirmDelete') !== false
    const trash = trashName(platform)

    const anyDirectory = targets.some((t) => t.isDirectory)
    if (confirmDelete) {
      const confirmed = await dialog.confirm({
        message:
          targets.length === 1
            ? localize(
                'dialog.file.delete.confirm.message',
                'Are you sure you want to delete "{name}"?',
                { name: basename(targets[0]!.resource.fsPath) },
              )
            : localize(
                'dialog.file.delete.confirm.message.multiple',
                'Are you sure you want to delete the {count} selected items?',
                { count: targets.length },
              ),
        detail: useTrash
          ? localize(
              'dialog.file.delete.confirm.detail.trash',
              'You can restore it from the {trash}.',
              { trash },
            )
          : anyDirectory
            ? localize(
                'dialog.file.delete.confirm.detail.directory',
                'This will permanently delete the folder and all of its contents.',
              )
            : localize(
                'dialog.file.delete.confirm.detail.file',
                'This will permanently delete the file.',
              ),
        primaryButton: useTrash
          ? localize('dialog.file.delete.moveToTrash', 'Move to {trash}', { trash })
          : localize('common.delete', 'Delete'),
        type: 'warning',
      })
      if (!confirmed.confirmed) return
    }

    try {
      await fileOps.delete(targets, useTrash)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.delete.error', 'Failed to delete'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}
