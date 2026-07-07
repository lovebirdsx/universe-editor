/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mutate actions on existing Explorer entries: rename / delete.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'
import { resolveContextOperations, reviveUri, type ITargetArg } from './fileActionsCommon.js'

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
      title: localize2('action.rename.title', 'Rename…'),
      category: localize2('command.category.file', 'File'),
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
      title: localize2('action.deleteFile.title', 'Delete'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'delete' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const targets = resolveContextOperations(tree, [(args[0] as ITargetArg | undefined) ?? {}])
    if (targets.length === 0) return
    const dialog = accessor.get(IDialogService)

    const anyDirectory = targets.some((t) => t.isDirectory)
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
      detail: anyDirectory
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
    const failed: { resource: string; error: unknown }[] = []
    for (const target of targets) {
      try {
        await tree.delete(target.resource, { recursive: target.isDirectory })
      } catch (err) {
        failed.push({ resource: target.resource.fsPath, error: err })
      }
    }
    if (failed.length > 0) {
      const first = failed[0]!
      await dialog.confirm({
        message: localize('dialog.file.delete.error', 'Failed to delete'),
        detail:
          failed.length === 1
            ? first.error instanceof Error
              ? first.error.message
              : String(first.error)
            : localize(
                'dialog.file.delete.error.multiple',
                'Failed to delete {count} items. First error: {message}',
                {
                  count: failed.length,
                  message: first.error instanceof Error ? first.error.message : String(first.error),
                },
              ),
        type: 'error',
      })
    }
  }
}
