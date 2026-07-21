/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Internal `_workbench.*` commands that back the extension API. The extension
 *  host can only invoke `_workbench.*` commands in the renderer (see
 *  MainThreadCommands), so anything an extension needs from the renderer that
 *  isn't a dedicated RPC channel is surfaced here as a command.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  IEditorGroupsService,
  IInstantiationService,
  ILifecycleService,
  IUriIdentityService,
  IWindowsService,
  IWorkspaceService,
  ShutdownReason,
  URI,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  findExistingFileEditor,
  revealSelectionInInput,
} from '../services/editor/revealEditorPosition.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'

/** Backs `workspace.getConfiguration(section).get(key, default)` for extensions. */
export class GetConfigurationAction extends Action2 {
  static readonly ID = '_workbench.getConfiguration'

  constructor() {
    super({ id: GetConfigurationAction.ID, title: 'Get Configuration' })
  }

  override run(accessor: ServicesAccessor, key: string, defaultValue?: unknown): unknown {
    const value = accessor.get(IConfigurationService).get(key)
    return value === undefined ? defaultValue : value
  }
}

/** Backs `workspace.getConfiguration(section).update(key, value)` for extensions. */
export class UpdateConfigurationAction extends Action2 {
  static readonly ID = '_workbench.updateConfiguration'

  constructor() {
    super({ id: UpdateConfigurationAction.ID, title: 'Update Configuration' })
  }

  override async run(accessor: ServicesAccessor, key: string, value: unknown): Promise<void> {
    await accessor.get(IConfigurationService).update(key, value, ConfigurationTarget.User)
  }
}

/**
 * Returns the fsPath of the file backing the active editor — the source file for
 * a FileEditorInput, or the original side of a DiffEditorInput. Lets the Git
 * extension resolve "the current file" for git.openChange / git.openFile, which
 * the extension host can't read directly (no activeTextEditor API).
 */
export class GetActiveEditorFileAction extends Action2 {
  static readonly ID = '_workbench.getActiveEditorFile'

  constructor() {
    super({ id: GetActiveEditorFileAction.ID, title: 'Get Active Editor File' })
  }

  override run(accessor: ServicesAccessor): string | undefined {
    const active = accessor.get(IEditorGroupsService).activeGroup.activeEditor
    if (active instanceof FileEditorInput) return active.resource.fsPath
    if (active instanceof DiffEditorInput) return active.originalUri.fsPath
    return undefined
  }
}

/** Opens a plain file editor for the given fsPath. Backs the Git extension's git.openFile. */
export class OpenFileAction extends Action2 {
  static readonly ID = '_workbench.openFile'

  constructor() {
    super({ id: OpenFileAction.ID, title: 'Open File' })
  }

  override run(accessor: ServicesAccessor, fsPath: string): void {
    if (!fsPath) return
    const group = accessor.get(IEditorGroupsService).activeGroup
    const input = accessor
      .get(IInstantiationService)
      .createInstance(FileEditorInput, URI.file(fsPath))
    group.openEditor(input, { activate: true, pinned: true })
  }
}

function revealExistingOrOpen(
  accessor: ServicesAccessor,
  groups: IEditorGroupsService,
  uri: URI,
): FileEditorInput {
  const existing = findExistingFileEditor(groups, accessor.get(IUriIdentityService), uri)
  if (existing) {
    groups.activateGroup(existing.group)
    existing.group.setActive(existing.editor)
    return existing.editor
  }
  const input = accessor.get(IInstantiationService).createInstance(FileEditorInput, uri)
  openInLockAwareGroup(groups, input, { activate: true, pinned: true })
  return input
}

/**
 * Opens a file editor and reveals a specific position. Backs cross-file jumps for
 * extensions (e.g. numbered-bookmarks). `line`/`column` are 0-based to match the
 * extension API's Position; Monaco lines/columns are 1-based, hence the `+ 1`.
 */
export class OpenFileAtAction extends Action2 {
  static readonly ID = '_workbench.openFileAt'

  constructor() {
    super({ id: OpenFileAtAction.ID, title: 'Open File At Position' })
  }

  override run(accessor: ServicesAccessor, fsPath: string, line: number, column = 0): void {
    if (!fsPath) return
    const groups = accessor.get(IEditorGroupsService)
    const uri = URI.file(fsPath)
    const input = revealExistingOrOpen(accessor, groups, uri)
    void revealSelectionInInput(input, { startLineNumber: line + 1, startColumn: column + 1 })
  }
}

/**
 * Switches this window to the given folder. Backs the Git extension's
 * git.openWorktree (current-window variant). Confirms before interrupting any
 * running session, mirroring OpenFolderAction.
 */
export class OpenFolderFromExtensionAction extends Action2 {
  static readonly ID = '_workbench.openFolder'

  constructor() {
    super({ id: OpenFolderFromExtensionAction.ID, title: 'Open Folder' })
  }

  override async run(accessor: ServicesAccessor, fsPath: string): Promise<void> {
    if (!fsPath) return
    const lifecycle = accessor.get(ILifecycleService)
    const workspace = accessor.get(IWorkspaceService)
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
    await workspace.openFolder(URI.file(fsPath))
  }
}

/**
 * Opens the given folder in a new window. Backs the Git extension's
 * git.openWorktreeInNewWindow.
 */
export class OpenFolderInNewWindowFromExtensionAction extends Action2 {
  static readonly ID = '_workbench.openFolderInNewWindow'

  constructor() {
    super({ id: OpenFolderInNewWindowFromExtensionAction.ID, title: 'Open Folder in New Window' })
  }

  override async run(accessor: ServicesAccessor, fsPath: string): Promise<void> {
    if (!fsPath) return
    await accessor.get(IWindowsService).openWindow(URI.file(fsPath))
  }
}
