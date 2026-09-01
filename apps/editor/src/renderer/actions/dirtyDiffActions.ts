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
  IUriIdentityService,
  IWorkspaceService,
  KeybindingWeight,
  MenuId,
  localize,
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
import { resolveOpenChangesTarget } from '../services/scm/openChanges.js'
import { scmHostPath } from '../services/scm/scmHostPath.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'
import { IScmService, resolveScmProviderId } from '../services/extensions/ScmService.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'
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

/**
 * The single "Open Changes" entry point, shared by every SCM provider. Git and
 * Perforce each contribute a `<providerId>.openChange` capability command, but
 * the user-facing entries (keybinding, editor title icon, Explorer context menu,
 * command palette) all funnel through here so there is one command to learn
 * rather than one per provider.
 *
 * Which provider handles a file is arbitrated by `resolveScmProviderId`: the
 * most specific owner, except that when several own it (a git repo nested in a
 * Perforce workspace) the repo selected in the SCM view wins.
 */
export class OpenChangesAction extends Action2 {
  static readonly ID = 'workbench.action.scm.openChanges'

  constructor() {
    super({
      id: OpenChangesAction.ID,
      title: localize2('action.scm.openChanges.title', 'Open Changes'),
      category: localize2('command.category.scm', 'Source Control'),
      icon: 'compare-changes',
      keybinding: { primary: 'shift+alt+y', when: '!isInDiffEditor' },
      f1: true,
      menu: [
        {
          id: MenuId.EditorTitle,
          group: 'navigation',
          order: 2,
          when: "resourceScmProvider != '' && scmActiveResourceHasChanges && !isInDiffEditor",
        },
        {
          id: MenuId.ExplorerContext,
          group: '3_compare',
          order: 4,
          when:
            "resourceScmProvider != '' && !explorerResourceIsFolder" +
            ' && !explorerResourceMultiSelected',
        },
      ],
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    // args[1] from the Explorer context menu is the multi-selection array
    // (ExplorerContextMenu materializes it for extensions) — not options.
    const [arg, rawOptions] = args as [
      unknown,
      ({ pinned?: boolean; preserveFocus?: boolean } | undefined)?,
    ]
    const options = Array.isArray(rawOptions) ? undefined : rawOptions
    // Everything the accessor provides has to be read before the first await —
    // a ServicesAccessor is only valid for the synchronous part of run().
    const group = accessor.get(IEditorGroupsService).activeGroup
    const commandService = accessor.get(ICommandService)
    const scmDecorations = accessor.get(IScmDecorationsService)
    const scm = accessor.get(IScmService)
    const uriIdentity = accessor.get(IUriIdentityService)
    const remoteAuthority = currentRemoteAuthority(accessor.get(IWorkspaceService).current)

    const active = group.activeEditor
    const target =
      resolveOpenChangesTarget(arg) ??
      (active instanceof FileEditorInput ? active.resource : undefined)
    if (!target) return

    // The baseline fetch runs on the SCM host, so an off-host resource (a local
    // file in a remote window) has no baseline here — a bare fsPath would route
    // the client's path to the remote provider and diff an unrelated file.
    const hostPath = scmHostPath(target, remoteAuthority)
    const providerId = hostPath
      ? resolveScmProviderId(scm.sourceControls.get(), hostPath, scmViewState.selectedRepo.get())
      : undefined
    if (!providerId || !hostPath) return

    const passThrough = {
      ...(options?.pinned !== undefined ? { pinned: options.pinned } : {}),
      ...(options?.preserveFocus !== undefined ? { preserveFocus: options.preserveFocus } : {}),
    }
    const delegate = (): Promise<unknown> =>
      commandService.executeCommand(
        dirtyDiffCommandId(providerId, 'openChange'),
        hostPath,
        passThrough,
      )

    // Only the active editor has a live buffer to diff against; anything else
    // (an Explorer target, a spreadsheet opened in a webview) goes to the owning
    // provider, which knows how to render its own special cases.
    const isActiveFile =
      active instanceof FileEditorInput && uriIdentity.isEqual(active.resource, target)
    if (!isActiveFile) {
      await delegate()
      return
    }

    const hasScmChanges = scmDecorations.getFile(active.resource) !== undefined
    const head = await commandService.executeCommand<string | null>(
      dirtyDiffCommandId(providerId, 'getHeadContent'),
      hostPath,
    )
    // A baseline in hand is the only case the buffer-aware path handles correctly.
    // `getHeadContent` collapses "no baseline" and "fetching it failed" into the
    // same null, and the provider is the only side that can tell them apart —
    // Perforce toasts the failure and opens the plain file for an open-for-add,
    // where diffing against an empty left side would read as "whole file added".
    if (head == null) {
      if (hasScmChanges) await delegate()
      return
    }

    const model =
      FileEditorRegistry.get(active, group.id)?.getModel() ?? active.peekModel() ?? undefined
    const modified = model?.getValue() ?? active.backupContent

    await commandService.executeCommand('_workbench.openDiff', {
      title: localize('diff.workingTreeTitle', '{label} (Working Tree)', { label: active.label }),
      originalUri: active.resource.toString(),
      original: head,
      modified,
      openableUri: active.resource.toString(),
      liveModified: true,
      ...passThrough,
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
