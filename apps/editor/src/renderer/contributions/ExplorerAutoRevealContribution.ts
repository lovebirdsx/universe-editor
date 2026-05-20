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
        const resource: URI | null =
          editor instanceof FileEditorInput && editor.resource.scheme === 'file'
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
