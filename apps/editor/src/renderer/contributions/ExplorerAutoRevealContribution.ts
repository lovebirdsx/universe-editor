/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerAutoRevealContribution — keeps the Explorer tree's "active editor"
 *  marker in sync with IEditorService.activeEditor, and (when
 *  `explorer.autoReveal` is enabled) also reveals + selects the corresponding
 *  row whenever the active editor changes.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  IConfigurationService,
  IEditorService,
  IWorkbenchContribution,
  URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'
import { isFileSystemUri } from '../services/files/fileSystemScheme.js'

export class ExplorerAutoRevealContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IEditorService editorService: IEditorService,
    @IExplorerTreeService tree: ExplorerTreeService,
    @IConfigurationService config: IConfigurationService,
  ) {
    super()
    this._register(
      autorun((reader) => {
        const editor = editorService.activeEditor.read(reader)
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
