/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File-system Action2 commands: Save / Save As / Open File / New File /
 *  New Folder / Rename / Delete. Most of these can be driven from either the
 *  command palette (no args) or the Explorer right-click menu (target args).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
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
  type UriComponents,
} from '@universe-editor/platform'
import { IRecentFilesService } from '../services/recentFiles/recentFilesService.js'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../workbench/editor/UntitledEditorInput.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { confirmLargeFile } from '../workbench/editor/largeFileGuard.js'
import { IExplorerTreeService } from '../workbench/explorer/ExplorerTreeService.js'

function reviveUri(value: URI | UriComponents | null): URI | null {
  if (!value) return null
  return value instanceof URI ? value : (URI.revive(value) as URI)
}

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

// ---------------------------------------------------------------------------
// Save / Save As
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Open File
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Explorer CRUD: New File / New Folder / Rename / Delete
// ---------------------------------------------------------------------------

interface IParentArg {
  readonly parent?: URI | UriComponents
}
interface ITargetArg {
  readonly target?: URI | UriComponents
  readonly isDirectory?: boolean
}

function resolveParent(accessor: ServicesAccessor, args: IParentArg | undefined): URI | null {
  const explicit = args?.parent ? reviveUri(args.parent) : null
  if (explicit) return explicit
  const workspace = accessor.get(IWorkspaceService)
  return workspace.current?.folder ?? null
}

export class NewFileAction extends Action2 {
  static readonly ID = 'workbench.files.action.newFile'
  constructor() {
    super({
      id: NewFileAction.ID,
      title: localize('action.newFile.title', 'New File…'),
      category: localize('command.category.file', 'File'),
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
      groups.activeGroup.openEditor(input, { activate: true })
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
      title: localize('action.newFolder.title', 'New Folder…'),
      category: localize('command.category.file', 'File'),
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
    const target = reviveUri((args[0] as ITargetArg | undefined)?.target ?? null)
    if (!target) return
    const dialog = accessor.get(IDialogService)
    const tree = accessor.get(IExplorerTreeService)

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
    const a = (args[0] as ITargetArg | undefined) ?? {}
    const target = reviveUri(a.target ?? null)
    if (!target) return
    const isDirectory = !!a.isDirectory
    const dialog = accessor.get(IDialogService)
    const tree = accessor.get(IExplorerTreeService)

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

// ---------------------------------------------------------------------------
// Recent Files
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shell integration: Open with Default App
// ---------------------------------------------------------------------------

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
