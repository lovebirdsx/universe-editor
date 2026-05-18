/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers Monaco built-in editor commands into CommandsRegistry so they
 *  appear in the Keyboard Shortcuts editor and can be overridden by users.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  IEditorGroupsService,
  IWorkbenchContribution,
} from '@universe-editor/platform'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../workbench/editor/FileEditorRegistry.js'
import { MONACO_COMMAND_CATALOG } from '../workbench/editor/monaco/monacoCommandCatalog.js'

export class MonacoCommandsContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IEditorGroupsService private readonly _groups: IEditorGroupsService) {
    super()
    for (const cmd of MONACO_COMMAND_CATALOG) {
      const cmdId = cmd.id
      this._register(
        CommandsRegistry.registerCommand({
          id: cmdId,
          metadata: { description: cmd.label, category: cmd.category },
          handler: () => {
            const activeInput = this._groups.activeGroup.activeEditor
            if (!(activeInput instanceof FileEditorInput)) return
            FileEditorRegistry.get(activeInput)?.trigger('', cmdId, {})
          },
        }),
      )
    }
  }
}
