/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerAutoRevealContribution — keeps the Explorer tree's "active editor"
 *  marker in sync with IEditorViewTargetService.targetEditor (the last-used
 *  editor surface, so an auxiliary window's file stays marked while the user
 *  works in the main window), and (when `explorer.autoReveal` is enabled) also
 *  reveals + selects the corresponding row whenever the target editor changes.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  IConfigurationService,
  IWorkbenchContribution,
  URI,
} from '@universe-editor/platform'
import { IEditorViewTargetService } from '../services/editor/EditorViewTargetService.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'
import { isFileSystemUri } from '../services/files/fileSystemScheme.js'

export class ExplorerAutoRevealContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IEditorViewTargetService viewTarget: IEditorViewTargetService,
    @IExplorerTreeService tree: ExplorerTreeService,
    @IConfigurationService config: IConfigurationService,
  ) {
    super()
    this._register(
      autorun((reader) => {
        const editor = viewTarget.targetEditor.read(reader)
        // Any filesystem-backed editor (local or remote) has an Explorer row;
        // virtual schemes (markdown-preview:, universe:) do not. The tree itself
        // ignores a resource outside its root, so no extra host check is needed.
        const resource: URI | null =
          editor instanceof FileEditorInput && isFileSystemUri(editor.resource)
            ? editor.resource
            : null
        tree.setActiveEditorResource(resource)
        if (resource && config.get<boolean>('explorer.autoReveal') !== false) {
          void tree.reveal(resource)
        }
      }),
    )
  }
}
