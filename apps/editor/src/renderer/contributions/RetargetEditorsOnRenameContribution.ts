/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RetargetEditorsOnRenameContribution — keeps file-backed tabs pointing at the
 *  new path when the Explorer renames or moves a file/folder. Each EditorInput
 *  rebuilds itself around the new URI (via the optional `rename` hook); this
 *  contribution preserves the tab slot by swapping inputs in place.
 *
 *  Two phases are deliberate: an input can be shared by several groups, and
 *  replacing it in the first group disposes it and its Monaco model. Every
 *  group entry's replacement is therefore built (and its live dirty buffer
 *  captured) before any swap is applied.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  ILoggerService,
  IUriIdentityService,
  URI,
  createNamedLogger,
  type EditorInput,
  type IEditorGroup,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
  type IFileRenameOperation,
} from '../services/explorer/ExplorerTreeService.js'

interface IReplacementPlan {
  readonly group: IEditorGroup
  readonly oldInput: EditorInput
  readonly replacement: EditorInput
}

export class RetargetEditorsOnRenameContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger

  constructor(
    @IExplorerTreeService explorer: ExplorerTreeService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'retargetEditorsOnRename',
      name: 'Retarget Editors on Rename',
    })
    this._register(explorer.onDidRunFileOperation((ops) => this._onRenames(ops)))
  }

  private _onRenames(allOps: readonly IFileRenameOperation[]): void {
    // Drop exact no-ops only. A case-only rename on a case-insensitive
    // filesystem is URI-equal but still needs the tab retargeted to the new
    // spelling, so `IUriIdentityService.isEqual` is deliberately not used.
    const ops = allOps.filter((op) => op.oldUri.toString() !== op.newUri.toString())
    if (ops.length === 0) return
    const retarget = this._makeRetarget(ops)

    const plans: IReplacementPlan[] = []
    for (const group of this._groups.groups) {
      for (const editor of [...group.editors]) {
        try {
          const replacement = editor.rename?.(group.id, retarget)
          if (replacement) plans.push({ group, oldInput: editor, replacement })
        } catch (err) {
          this._logger.error(`retarget failed ${editor.id}`, err)
        }
      }
    }

    for (const { group, oldInput, replacement } of plans) {
      // Do not skip on `oldInput.isDisposed`: an input shared by several groups
      // is disposed by the first successful swap, yet every group must still
      // drop its own (now dead) slot in favour of its own replacement.
      if (group.replaceEditor(oldInput, replacement)) continue
      this._logger.warn(`replaceEditor rejected ${replacement.id} group=${group.id}`)
      replacement.dispose()
      // The old input still points at the deleted path and the watcher already
      // skipped closing it for the rename intent; a clean tab would otherwise
      // linger as a stale ghost. Dirty tabs stay open (closing would discard
      // the user's edits) — the next external-change pass surfaces the move.
      if (!oldInput.isDirty && group.contains(oldInput)) {
        group.closeEditor(oldInput)
      }
    }
  }

  private _makeRetarget(ops: readonly IFileRenameOperation[]): (resource: URI) => URI | undefined {
    return (resource) => {
      for (const op of ops) {
        if (op.isDirectory) {
          const relative = this._uriIdentity.relativePath(op.oldUri, resource)
          if (relative === null) continue
          return relative === '' ? op.newUri : URI.joinPath(op.newUri, relative)
        }
        if (this._uriIdentity.isEqual(op.oldUri, resource)) return op.newUri
      }
      return undefined
    }
  }
}
