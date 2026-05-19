/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BuiltInEditorBindingsContribution — BlockStartup phase.
 *
 *  Registers the default glob → EditorInput bindings so that all file:// URIs
 *  open with FileEditorInput by default. Higher-priority registrations (e.g.
 *  a future Tree or Graph editor) added later will override specific patterns.
 *
 *  Also registers the "Reopen With..." context menu item on the editor tab.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorResolverService,
  IInstantiationService,
  MenuId,
  MenuRegistry,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'

export class BuiltInEditorBindingsContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IEditorResolverService private readonly _resolver: IEditorResolverService,
    @IInstantiationService private readonly _inst: IInstantiationService,
  ) {
    super()

    // Catch-all: every file:// URI can be opened with FileEditorInput.
    // Priority 1 (builtin) so that future specialized editors registered with
    // priority 100 (registered) or 1000 (override) will sort above this.
    this._register(
      this._resolver.registerEditor(
        '**/*',
        {
          typeId: FileEditorInput.TYPE_ID,
          displayName: 'File Editor',
          priority: 1,
        },
        (uri) => this._inst.createInstance(FileEditorInput, uri),
      ),
    )

    // "Reopen With..." entry in the editor tab context menu.
    // EditorTabContextMenu passes { resource: state.resource.toJSON() } as args.
    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorTabContext, {
        command: 'workbench.action.reopenWith',
        title: 'Reopen With...',
        group: 'z_commands',
        order: 1,
      }),
    )
  }
}
