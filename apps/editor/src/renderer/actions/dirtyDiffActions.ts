/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Dirty-diff navigation — "Go to Next/Previous Change" inside a regular file
 *  editor, jumping between the change regions (current document vs git HEAD)
 *  that DirtyDiffContribution paints in the gutter. Mirrors VSCode's
 *  `workbench.action.editor.{next,previous}Change` (Alt+PageDown / Alt+PageUp).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IEditorGroupsService,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { dirtyDiffCommandId } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import {
  IDirtyDiffNavigationService,
  findAdjacentChange,
} from '../services/scm/DirtyDiffNavigationService.js'
import { IScmDecorationsService } from '../services/scm/ScmDecorationsService.js'
import { IScmService, resolveScmProviderId } from '../services/extensions/ScmService.js'
import { DirtyDiffPeekRegistry } from '../workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.js'

const WHEN = "editorTextFocus && !isInDiffEditor && quickDiffDecorationCount != '0'"

function goToChange(accessor: ServicesAccessor, direction: 'next' | 'previous'): void {
  const group = accessor.get(IEditorGroupsService).activeGroup
  const active = group.activeEditor
  if (!(active instanceof FileEditorInput)) return
  const editor = FileEditorRegistry.get(active, group.id)
  if (!editor) return

  const line = editor.getPosition()?.lineNumber ?? 1
  const target = findAdjacentChange(
    accessor.get(IDirtyDiffNavigationService).regions,
    line,
    direction,
  )
  if (!target) return

  editor.setPosition({ lineNumber: target.startLine, column: 1 })
  editor.revealLineInCenterIfOutsideViewport(target.startLine)
  editor.focus()
}

export class GoToNextChangeAction extends Action2 {
  static readonly ID = 'workbench.action.editor.nextChange'

  constructor() {
    super({
      id: GoToNextChangeAction.ID,
      title: localize2('action.editor.nextChange.title', 'Go to Next Change'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'alt+pagedown', when: WHEN },
      precondition: WHEN,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    goToChange(accessor, 'next')
  }
}

export class GoToPreviousChangeAction extends Action2 {
  static readonly ID = 'workbench.action.editor.previousChange'

  constructor() {
    super({
      id: GoToPreviousChangeAction.ID,
      title: localize2('action.editor.previousChange.title', 'Go to Previous Change'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'alt+pageup', when: WHEN },
      precondition: WHEN,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    goToChange(accessor, 'previous')
  }
}

export class OpenActiveFileChangesAction extends Action2 {
  static readonly ID = '_workbench.openActiveFileChanges'

  constructor() {
    super({
      id: OpenActiveFileChangesAction.ID,
      title: 'Open Active File Changes',
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!(active instanceof FileEditorInput)) return

    const commandService = accessor.get(ICommandService)
    const scmDecorations = accessor.get(IScmDecorationsService)
    const scm = accessor.get(IScmService)
    const hasScmChanges = scmDecorations.getFile(active.resource) !== undefined
    const providerId = resolveScmProviderId(scm.sourceControls.get(), active.resource.fsPath)
    const head = providerId
      ? await commandService.executeCommand<string | null>(
          dirtyDiffCommandId(providerId, 'getHeadContent'),
          active.resource.fsPath,
        )
      : null
    if (head == null && !hasScmChanges) return

    const model =
      FileEditorRegistry.get(active, group.id)?.getModel() ?? active.peekModel() ?? undefined
    const modified = model?.getValue() ?? active.backupContent

    await commandService.executeCommand('_workbench.openDiff', {
      title: `${active.label} (Working Tree)`,
      originalUri: active.resource.toString(),
      original: head ?? '',
      modified,
    })
  }
}

// ---------------------------------------------------------------------------
// Inline dirty-diff peek (the quick-diff widget over a gutter change). Open it
// at the cursor with a keybinding, and close it with Esc — mirroring VSCode's
// `editor.action.dirtydiff.{next,close}` / `closeQuickDiff`.
// ---------------------------------------------------------------------------

export class ShowChangeAtCursorAction extends Action2 {
  static readonly ID = 'workbench.action.editor.showChange'

  constructor() {
    super({
      id: ShowChangeAtCursorAction.ID,
      title: localize2('action.editor.showChange.title', 'Show Change'),
      category: localize2('command.category.editor', 'Editor'),
      precondition: WHEN,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const host = DirtyDiffPeekRegistry.getHost()
    if (!host) return
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!(active instanceof FileEditorInput)) return
    const editor = FileEditorRegistry.get(active, group.id)
    host.openAtLine(editor?.getPosition()?.lineNumber ?? 1)
  }
}

export class CloseDirtyDiffPeekAction extends Action2 {
  static readonly ID = 'closeDirtyDiffPeek'

  constructor() {
    super({
      id: CloseDirtyDiffPeekAction.ID,
      title: localize2('action.editor.closeChange.title', 'Close Change Peek'),
      category: localize2('command.category.editor', 'Editor'),
      // Outrank both Monaco's own Esc handlers and the workbench's
      // "focus editor group" Esc (WorkbenchContrib) so the peek closes first.
      keybinding: {
        primary: 'escape',
        when: 'dirtyDiffPeekVisible',
        weight: KeybindingWeight.WorkbenchContrib + 50,
      },
    })
  }

  override run(): void {
    DirtyDiffPeekRegistry.getHost()?.closePeek()
  }
}
