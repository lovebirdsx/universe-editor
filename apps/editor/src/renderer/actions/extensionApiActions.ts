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
  URI,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'

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
