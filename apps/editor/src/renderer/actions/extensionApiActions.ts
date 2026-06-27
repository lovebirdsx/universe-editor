/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Internal `_workbench.*` commands that back the extension API. The extension
 *  host can only invoke `_workbench.*` commands in the renderer (see
 *  MainThreadCommands), so anything an extension needs from the renderer that
 *  isn't a dedicated RPC channel is surfaced here as a command.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IEditorGroupsService,
  IInstantiationService,
  ILifecycleService,
  IWindowsService,
  IWorkspaceService,
  ShutdownReason,
  URI,
  isEqualResource,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'

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
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && isEqualResource(editor.resource, uri)) {
        groups.activateGroup(group)
        group.setActive(editor)
        return editor
      }
    }
  }
  const input = accessor.get(IInstantiationService).createInstance(FileEditorInput, uri)
  groups.activeGroup.openEditor(input, { activate: true, pinned: true })
  return input
}

/** Monaco may not have mounted the editor yet; retry briefly before giving up. */
async function revealPosition(input: FileEditorInput, line: number, column: number): Promise<void> {
  const delays = [0, 50, 100, 200]
  for (const delay of delays) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
    const editor = FileEditorRegistry.get(input)
    if (editor) {
      const position = { lineNumber: line, column }
      editor.setPosition(position)
      editor.revealLineInCenterIfOutsideViewport(line)
      editor.focus()
      return
    }
  }
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
    void revealPosition(input, line + 1, column + 1)
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
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
    await accessor.get(IWorkspaceService).openFolder(URI.file(fsPath))
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
