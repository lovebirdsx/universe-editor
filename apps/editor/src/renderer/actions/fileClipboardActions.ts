import {
  Action2,
  IDialogService,
  IFileDialogService,
  IFileService,
  IWorkspaceService,
  localize,
  localize2,
  type ServicesAccessor,
  type URI,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
  type IExplorerResourceOperation,
} from '../services/explorer/ExplorerTreeService.js'
import { parentOf, sameUri } from '../services/explorer/explorerTreeUtils.js'
import { basenameOf, targetInDirectory } from '../services/explorer/explorerFileOperations.js'
import { resolveContextOperations, reviveUri, type ITargetArg } from './fileActionsCommon.js'

const EXPLORER_FOCUS_WHEN =
  "focusedView == 'workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus"

function resolveDestinationDir(tree: ExplorerTreeService, args: unknown[]): URI | null {
  const arg = args[0] as ITargetArg | undefined
  const explicitParent = reviveUri(arg?.parent ?? null)
  if (explicitParent) return explicitParent
  const explicit = reviveUri(arg?.target ?? arg?.resource ?? null)
  if (explicit) {
    if (arg?.isDirectory === true || tree.isDirectory(explicit)) return explicit
    return parentOf(explicit)
  }
  const focused = tree.selectedResource
  if (focused) {
    if (tree.isDirectory(focused)) return focused
    return parentOf(focused)
  }
  return tree.root
}

async function writePathClipboard(resources: readonly IExplorerResourceOperation[]): Promise<void> {
  const text = resources.map((resource) => resource.resource.fsPath).join('\n')
  if (!text) return
  try {
    await globalThis.navigator?.clipboard?.writeText(text)
  } catch {
    // Browser clipboard permission is best-effort; the in-app Explorer clipboard is authoritative.
  }
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
  tree: ExplorerTreeService,
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
    targets.push(...(await tree.moveResources([source], destinationDir, { overwrite })))
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
    const resources = resolveContextOperations(tree, args)
    if (resources.length === 0) return
    tree.setToCopy(resources, true)
    await writePathClipboard(resources)
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
    const resources = resolveContextOperations(tree, args)
    if (resources.length === 0) return
    tree.setToCopy(resources, false)
    await writePathClipboard(resources)
  }
}

export class PasteExplorerFileAction extends Action2 {
  static readonly ID = 'filesExplorer.paste'
  constructor() {
    super({
      id: PasteExplorerFileAction.ID,
      title: localize2('action.filesExplorer.paste', 'Paste'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+v', when: `${EXPLORER_FOCUS_WHEN} && fileCopied` },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const destinationDir = resolveDestinationDir(tree, args)
    const resources = tree.clipboardResources
    if (!destinationDir || resources.length === 0) return
    const dialog = accessor.get(IDialogService)
    try {
      if (tree.clipboardIsCut) {
        await moveWithOverwritePrompt(
          tree,
          accessor.get(IFileService),
          dialog,
          resources,
          destinationDir,
        )
        tree.clearClipboard()
      } else {
        await tree.copyResources(resources, destinationDir)
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

  override run(accessor: ServicesAccessor): void {
    accessor.get(IExplorerTreeService).clearClipboard()
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
    const source = resolveContextOperations(tree, args)[0]
    if (!source) return
    const dialog = accessor.get(IDialogService)
    const defaultName = await tree.defaultDuplicateName(source)
    const name = await dialog.prompt({
      title: localize('dialog.file.prompt.duplicate', 'Duplicate'),
      initialValue: defaultName,
    })
    if (!name) return
    try {
      await tree.duplicate(source, name)
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
    const resources = resolveContextOperations(tree, args)
    if (resources.length === 0) return
    const workspace = accessor.get(IWorkspaceService)
    const currentParent = parentOf(resources[0]!.resource)
    const defaultUri = currentParent ?? workspace.current?.folder
    const fileDialog = accessor.get(IFileDialogService)
    const dialog = accessor.get(IDialogService)
    const fileService = accessor.get(IFileService)
    const destinationDir = await fileDialog.showOpenDialog({
      title: localize('fileDialog.move.title', 'Select Destination Folder'),
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: localize('fileDialog.move.openLabel', 'Move'),
      ...(defaultUri ? { defaultUri } : {}),
    })
    if (!destinationDir) return
    try {
      await moveWithOverwritePrompt(tree, fileService, dialog, resources, destinationDir)
    } catch (err) {
      await dialog.confirm({
        message: localize('dialog.file.move.error', 'Failed to move'),
        detail: err instanceof Error ? err.message : String(err),
        type: 'error',
      })
    }
  }
}
