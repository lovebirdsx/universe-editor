/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  GitMergeConflictContribution — VSCode-style inline merge-conflict resolution
 *  for the active plain file editor. Delegates the actual rendering / resolution
 *  to the shared InlineConflictController; this class only tracks which editor is
 *  active and wires the "Compare Changes" action to the diff editor.
 *
 *  VSCode's merge-conflict extension drives the action bar through a
 *  CodeLensProvider; this kernel's extension API has no CodeLens surface, so the
 *  whole feature lives renderer-side as a workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  ICommandService,
  IEditorService,
  type IWorkbenchContribution,
  autorun,
  localize,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { InlineConflictController } from '../workbench/scm/mergeConflict/inlineConflictController.js'
import type { ConflictRegion } from '../workbench/scm/mergeConflict/conflictParser.js'

export class GitMergeConflictContribution extends Disposable implements IWorkbenchContribution {
  private _activeInput: FileEditorInput | undefined
  private readonly _editorStore = this._register(new DisposableStore())
  private readonly _registryStore = this._register(new DisposableStore())

  constructor(
    @IEditorService editorService: IEditorService,
    @ICommandService private readonly _commandService: ICommandService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const active = editorService.activeEditor.read(r)
        if (active instanceof FileEditorInput) {
          this._bind(active)
        } else {
          this._clear()
        }
      }),
    )

    this._register({ dispose: () => this._clear() })
  }

  private _bind(input: FileEditorInput): void {
    this._activeInput = input
    this._registryStore.clear()

    const attach = (): void => {
      this._editorStore.clear()
      const editor = FileEditorRegistry.get(input)
      if (!editor) return
      this._editorStore.add(
        new InlineConflictController(editor, {
          onCompare: (conflict) => void this._compare(conflict),
        }),
      )
    }

    attach()
    this._registryStore.add(
      FileEditorRegistry.onDidChange((changed) => {
        if (changed === input) attach()
      }),
    )
  }

  private async _compare(conflict: ConflictRegion): Promise<void> {
    if (!this._activeInput) return
    const model = FileEditorRegistry.get(this._activeInput)?.getModel()
    if (!model) return
    const path = model.uri.path
    const name = path.slice(path.lastIndexOf('/') + 1)
    await this._commandService.executeCommand('_workbench.openDiff', {
      title: localize('mergeConflict.compareTitle', '{name} (Current ↔ Incoming)', { name }),
      originalUri: model.uri.toString(),
      original: conflict.current.content,
      modified: conflict.incoming.content,
      pinned: true,
    })
  }

  private _clear(): void {
    this._editorStore.clear()
    this._registryStore.clear()
    this._activeInput = undefined
  }
}
