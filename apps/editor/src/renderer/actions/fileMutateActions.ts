/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mutate actions on existing Explorer entries: rename / delete.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IDialogService,
  IFileService,
  IHostService,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
  type IExplorerResourceOperation,
} from '../services/explorer/ExplorerTreeService.js'
import {
  IExplorerFileOperationService,
  type ExplorerFileOperationService,
} from '../services/explorer/ExplorerFileOperationService.js'
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

    const current = basename(target.path)
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
    // Every service must be resolved before the first await: the accessor is
    // only valid synchronously (see action2-async-accessor-invalidation).
    const fileService = accessor.get(IFileService)

    // The trash is an OS shell facility the local Electron process reaches;
    // remote hosts have no such API, so asking for it there would fail the whole
    // delete. Present permanent deletion honestly instead of promising a
    // recycle bin we cannot deliver — the same call VSCode's
    // `ExplorerResourceMoveableToTrash` context key makes.
    const useTrash =
      config.get<boolean>('files.enableTrash') !== false &&
      (await supportsTrash(fileService, targets))
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
                { name: basename(targets[0]!.resource.path) },
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
      const detail = err instanceof Error ? err.message : String(err)
      if (useTrash) {
        await this._offerPermanentDelete(dialog, fileService, fileOps, targets, detail)
        return
      }
      await dialog.confirm({
        message: localize('dialog.file.delete.error', 'Failed to delete'),
        detail,
        type: 'error',
      })
    }
  }

  /**
   * The trash was available but the OS refused the move. Mirrors VSCode's
   * offer to delete permanently instead rather than leaving the user stuck.
   * Only pre-resolved services are used here — the action's accessor died at
   * the first await.
   */
  private async _offerPermanentDelete(
    dialog: IDialogService,
    fileService: IFileService,
    fileOps: ExplorerFileOperationService,
    targets: readonly IExplorerResourceOperation[],
    trashFailureDetail: string,
  ): Promise<void> {
    const retry = await dialog.confirm({
      message: localize('dialog.file.delete.error', 'Failed to delete'),
      detail: `${trashFailureDetail}\n\n${localize(
        'dialog.file.delete.permanent.retry.detail',
        'You can delete it permanently instead.',
      )}`,
      primaryButton: localize('dialog.file.delete.permanent.button', 'Delete Permanently'),
      type: 'warning',
    })
    if (!retry.confirmed) return

    // Deletion runs target by target, so an earlier one may already be gone;
    // retrying it verbatim would fail with ENOENT on an entry we did delete.
    const alive = await Promise.all(targets.map((t) => fileService.exists(t.resource)))
    const remaining = targets.filter((_, i) => alive[i])
    if (remaining.length === 0) return

    try {
      await fileOps.delete(remaining, false)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.delete.error', 'Failed to delete'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}

/**
 * True only when every target's filesystem can move entries to the OS trash.
 * A mixed selection (local + remote) degrades to permanent deletion for all of
 * them rather than half-honouring the promise.
 */
async function supportsTrash(
  fileService: IFileService,
  targets: readonly IExplorerResourceOperation[],
): Promise<boolean> {
  // Test doubles may omit the optional capability query; keep their pre-existing
  // trash behaviour rather than silently turning their deletes permanent.
  if (!fileService.getCapabilities) return true
  const seen = new Set<string>()
  for (const target of targets) {
    const key = `${target.resource.scheme}://${target.resource.authority}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const caps = await fileService.getCapabilities(target.resource)
      if (!caps.supportsTrash) return false
    } catch {
      // A failed probe means "unknown", and answering "no trash" would silently
      // turn a requested trash move into a permanent delete. Keep `useTrash` so
      // a provider that really has no trash fails loud, and let the user pick
      // permanent deletion from the retry dialog instead.
      return true
    }
  }
  return true
}
