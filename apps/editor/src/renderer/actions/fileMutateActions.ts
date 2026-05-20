/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mutate actions on existing Explorer entries: rename / delete.
 *--------------------------------------------------------------------------------------------*/

import { Action2, IDialogService, localize, type ServicesAccessor } from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'
import { reviveUri, type ITargetArg } from './fileActionsCommon.js'

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
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
  tree: ExplorerTreeService,
  args: ITargetArg | undefined,
): { target: ReturnType<typeof reviveUri>; isDirectory: boolean } {
  const explicit = reviveUri(args?.target ?? args?.resource ?? null)
  if (explicit) {
    return { target: explicit, isDirectory: args?.isDirectory === true }
  }
  const selected = tree.selectedResource
  return { target: selected, isDirectory: isDirectoryTarget(tree, selected) }
}

export class RenameFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.rename'
  constructor() {
    super({
      id: RenameFileAction.ID,
      title: localize('action.rename.title', 'Rename…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'f2' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const { target } = resolveTarget(tree, args[0] as ITargetArg | undefined)
    if (!target) return
    const dialog = accessor.get(IDialogService)

    const current = basename(target.fsPath)
    const next = await dialog.prompt({
      title: localize('dialog.file.prompt.rename', 'Rename'),
      initialValue: current,
    })
    if (!next || next === current) return
    try {
      await tree.rename(target, next)
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
      title: localize('action.deleteFile.title', 'Delete'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'delete' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const { target, isDirectory } = resolveTarget(tree, (args[0] as ITargetArg | undefined) ?? {})
    if (!target) return
    const dialog = accessor.get(IDialogService)

    const confirmed = await dialog.confirm({
      message: localize(
        'dialog.file.delete.confirm.message',
        'Are you sure you want to delete "{name}"?',
        { name: basename(target.fsPath) },
      ),
      detail: isDirectory
        ? localize(
            'dialog.file.delete.confirm.detail.directory',
            'This will permanently delete the folder and all of its contents.',
          )
        : localize(
            'dialog.file.delete.confirm.detail.file',
            'You can restore it from the system trash if your platform supports it.',
          ),
      primaryButton: localize('common.delete', 'Delete'),
      type: 'warning',
    })
    if (!confirmed.confirmed) return
    try {
      await tree.delete(target, { recursive: isDirectory })
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.delete.error', 'Failed to delete'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}
