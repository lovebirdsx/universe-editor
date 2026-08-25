import {
  Action2,
  IDialogService,
  IFileDialogService,
  IFileService,
  IWorkspaceService,
  URI,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
  type IExplorerResourceOperation,
} from '../services/explorer/ExplorerTreeService.js'
import { IExplorerFileOperationService } from '../services/explorer/ExplorerFileOperationService.js'
import type { ExplorerFileOperationService } from '../services/explorer/ExplorerFileOperationService.js'
import { parentOf, sameUri } from '../services/explorer/explorerTreeUtils.js'
import { basenameOf, targetInDirectory } from '../services/explorer/explorerFileOperations.js'
import {
  IFileClipboardService,
  type IFileClipboardResource,
} from '../../shared/ipc/fileClipboardService.js'
import {
  EXPLORER_FOCUS_WHEN,
  implicitPrimaryTarget,
  resolveContextOperations,
  reviveUri,
  type ITargetArg,
} from './fileActionsCommon.js'

function resolveDestinationDir(
  accessor: ServicesAccessor,
  tree: ExplorerTreeService,
  args: unknown[],
): URI | null {
  const arg = args[0] as ITargetArg | undefined
  const explicitParent = reviveUri(arg?.parent ?? null)
  if (explicitParent) return explicitParent
  const explicit = reviveUri(arg?.target ?? arg?.resource ?? null)
  if (explicit) {
    if (arg?.isDirectory === true || tree.isDirectory(explicit)) return explicit
    return parentOf(explicit)
  }
  const focused = implicitPrimaryTarget(accessor) ?? tree.selectedResource
  if (focused) {
    if (tree.isDirectory(focused)) return focused
    return parentOf(focused)
  }
  return tree.root
}

function formatClipboardSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Write to the shared file clipboard (main memory + OS clipboard) after the
 * pre-flight cost check. The local Explorer tree state is not touched here —
 * the shared service's onDidChangeClipboard broadcast feeds it back.
 */
async function writeExplorerClipboard(
  fileClipboard: IFileClipboardService,
  dialog: IDialogService,
  resources: readonly IExplorerResourceOperation[],
  isCut: boolean,
): Promise<void> {
  const payload: IFileClipboardResource[] = resources.map((resource) => ({
    resource: resource.resource.toJSON(),
    isDirectory: resource.isDirectory,
  }))
  const cost = await fileClipboard.checkWriteCost(payload)
  if (cost.refused) {
    await dialog.confirm({
      message: localize(
        'dialog.file.clipboard.refused.message',
        'The selected items are too large to copy to the system clipboard.',
      ),
      detail: localize(
        'dialog.file.clipboard.refused.detail',
        'Copying more than 2GB or 100,000 items to the system clipboard is not supported. Reduce the selection and try again.',
      ),
      type: 'error',
    })
    return
  }
  if (cost.needsConfirmation) {
    const { confirmed } = await dialog.confirm({
      message: localize(
        'dialog.file.clipboard.confirm.message',
        'Copying {size} of files to the system clipboard requires downloading them to a temporary location first. Do you want to continue?',
        { size: formatClipboardSize(cost.totalBytes) },
      ),
      detail: localize(
        'dialog.file.clipboard.confirm.detail',
        'Other applications will get the local copies when you paste.',
      ),
      primaryButton: localize('common.ok', 'OK'),
      type: 'warning',
    })
    if (!confirmed) return
  }
  await fileClipboard.writeResources(payload, isCut, { materialize: true })
}

async function confirmMoveOverwrite(dialog: IDialogService, target: URI): Promise<boolean> {
  const { confirmed } = await dialog.confirm({
    message: localize(
      'dialog.file.move.overwrite.message',
      'A file or folder named "{name}" already exists in the destination folder. Do you want to replace it?',
      { name: basenameOf(target) },
    ),
    detail: localize(
      'dialog.file.move.overwrite.detail',
      'Replacing it will overwrite the existing item.',
    ),
    primaryButton: localize('common.replace', 'Replace'),
    type: 'warning',
  })
  return confirmed
}

async function moveWithOverwritePrompt(
  fileOps: ExplorerFileOperationService,
  fileService: IFileService,
  dialog: IDialogService,
  resources: readonly IExplorerResourceOperation[],
  destinationDir: URI,
): Promise<URI[]> {
  const targets: URI[] = []
  for (const source of resources) {
    const target = targetInDirectory(destinationDir, source.resource)
    if (sameUri(source.resource, target)) continue
    const exists = await fileService.exists(target)
    let overwrite = false
    if (exists) {
      overwrite = await confirmMoveOverwrite(dialog, target)
      if (!overwrite) continue
    }
    targets.push(...(await fileOps.moveResources([source], destinationDir, { overwrite })))
  }
  return targets
}

export class CutFileAction extends Action2 {
  static readonly ID = 'filesExplorer.cut'
  constructor() {
    super({
      id: CutFileAction.ID,
      title: localize2('action.filesExplorer.cut', 'Cut'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+x', when: EXPLORER_FOCUS_WHEN },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const fileClipboard = accessor.get(IFileClipboardService)
    const dialog = accessor.get(IDialogService)
    const resources = resolveContextOperations(accessor, tree, args)
    if (resources.length === 0) return
    await writeExplorerClipboard(fileClipboard, dialog, resources, true)
  }
}

export class CopyExplorerFileAction extends Action2 {
  static readonly ID = 'filesExplorer.copy'
  constructor() {
    super({
      id: CopyExplorerFileAction.ID,
      title: localize2('action.filesExplorer.copy', 'Copy'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+c', when: EXPLORER_FOCUS_WHEN },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const fileClipboard = accessor.get(IFileClipboardService)
    const dialog = accessor.get(IDialogService)
    const resources = resolveContextOperations(accessor, tree, args)
    if (resources.length === 0) return
    await writeExplorerClipboard(fileClipboard, dialog, resources, false)
  }
}

export class PasteExplorerFileAction extends Action2 {
  static readonly ID = 'filesExplorer.paste'
  constructor() {
    super({
      id: PasteExplorerFileAction.ID,
      title: localize2('action.filesExplorer.paste', 'Paste'),
      category: localize2('command.category.file', 'File'),
      // No fileCopied gate: the OS clipboard can now carry files copied in
      // other applications, and we don't poll it, so emptiness is only known
      // at run time.
      keybinding: { primary: 'ctrl+v', when: EXPLORER_FOCUS_WHEN },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const fileClipboard = accessor.get(IFileClipboardService)
    const dialog = accessor.get(IDialogService)
    const fileOps = accessor.get(IExplorerFileOperationService)
    const fileService = accessor.get(IFileService)
    const destinationDir = resolveDestinationDir(accessor, tree, args)
    if (!destinationDir) return
    const snap = await fileClipboard.readResources()
    if (snap.resources.length === 0) return
    const resources: IExplorerResourceOperation[] = snap.resources.flatMap((entry) => {
      const resource = URI.revive(entry.resource)
      return resource ? [{ resource, isDirectory: entry.isDirectory }] : []
    })
    if (resources.length === 0) return
    try {
      // Only move when we wrote the clipboard ourselves and still own it.
      // OS-originated entries are always copied — never delete external files.
      if (snap.isCut && snap.source === 'internal') {
        await moveWithOverwritePrompt(fileOps, fileService, dialog, resources, destinationDir)
        await fileClipboard.clear()
      } else {
        await fileOps.copyResources(resources, destinationDir)
      }
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.paste.error', 'Failed to paste'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}

export class CancelCutExplorerFileAction extends Action2 {
  static readonly ID = 'filesExplorer.cancelCut'
  constructor() {
    super({
      id: CancelCutExplorerFileAction.ID,
      title: localize2('action.filesExplorer.cancelCut', 'Cancel Cut'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'escape', when: `${EXPLORER_FOCUS_WHEN} && explorerResourceCut` },
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // The tree mirrors the shared clipboard, so clearing it is enough — the
    // broadcast event re-adopts the empty snapshot in every window.
    await accessor.get(IFileClipboardService).clear()
  }
}

export class DuplicateFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.duplicate'
  constructor() {
    super({
      id: DuplicateFileAction.ID,
      title: localize2('action.filesExplorer.duplicate', 'Duplicate...'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const source = resolveContextOperations(accessor, tree, args)[0]
    if (!source) return
    const dialog = accessor.get(IDialogService)
    const fileOps = accessor.get(IExplorerFileOperationService)
    const defaultName = await tree.defaultDuplicateName(source)
    const name = await dialog.prompt({
      title: localize('dialog.file.prompt.duplicate', 'Duplicate'),
      initialValue: defaultName,
    })
    if (!name) return
    try {
      await fileOps.duplicate(source, name)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.duplicate.error', 'Failed to duplicate'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}

export class MoveFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.move'
  constructor() {
    super({
      id: MoveFileAction.ID,
      title: localize2('action.filesExplorer.move', 'Move...'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const resources = resolveContextOperations(accessor, tree, args)
    if (resources.length === 0) return
    const workspace = accessor.get(IWorkspaceService)
    const currentParent = parentOf(resources[0]!.resource)
    const defaultUri = currentParent ?? workspace.current?.folder
    const fileDialog = accessor.get(IFileDialogService)
    const dialog = accessor.get(IDialogService)
    const fileService = accessor.get(IFileService)
    const fileOps = accessor.get(IExplorerFileOperationService)
    const destinationDir = (
      await fileDialog.showOpenDialog({
        title: localize('fileDialog.move.title', 'Select Destination Folder'),
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: localize('fileDialog.move.openLabel', 'Move'),
        ...(defaultUri ? { defaultUri } : {}),
      })
    )?.[0]
    if (!destinationDir) return
    try {
      await moveWithOverwritePrompt(fileOps, fileService, dialog, resources, destinationDir)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.move.error', 'Failed to move'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}
