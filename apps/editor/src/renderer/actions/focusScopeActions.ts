/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Focus-folders Action2 definitions: focus on / add to / remove from the
 *  focus scope, and exit focus mode. The folder commands are driven by the
 *  Explorer context menu and resolve their targets through the shared
 *  Explorer multi-select rules (see fileActionsCommon).
 *
 *  Adding to the focus set needs an entry point the filter cannot reach: a
 *  whitelist hides exactly the folders a user wants to add next, so the Explorer
 *  context menu — which can only offer what is already visible — is not enough
 *  on its own. `AddFoldersToFocusAction` browses with the file dialog instead,
 *  which reads the filesystem directly and is unaffected by focus.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IFileDialogService,
  INotificationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  Severity,
  localize,
  localize2,
  type IQuickPickItem,
  type IQuickPickSeparator,
  type QuickPickInput,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'
import { relativeTo } from '../services/explorer/explorerTreeUtils.js'
import { IFocusScopeService } from '../services/focus/FocusScopeService.js'
import { resolveContextOperations } from './fileActionsCommon.js'

/**
 * Workspace-relative paths of the resources a focus command should act on.
 * Focus entries may name a single file as well as a directory, so both kinds
 * are kept; only the workspace root itself is dropped.
 */
function resolveFocusEntries(
  accessor: ServicesAccessor,
  tree: ExplorerTreeService,
  args: unknown[],
): string[] {
  const root = tree.root
  if (!root) return []
  const entries: string[] = []
  for (const operation of resolveContextOperations(accessor, tree, args)) {
    const rel = relativeTo(root, operation.resource)
    if (rel === '') continue
    entries.push(rel)
  }
  return entries
}

export class FocusOnFolderAction extends Action2 {
  static readonly ID = 'workbench.action.focusScope.focusFolder'
  constructor() {
    super({
      id: FocusOnFolderAction.ID,
      title: localize2('action.focusScope.focusFolder.title', 'Focus on This'),
      category: localize2('command.category.view', 'View'),
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const focusScope = accessor.get(IFocusScopeService)
    const entries = resolveFocusEntries(accessor, tree, args)
    if (entries.length === 0) return
    await focusScope.setFolders(entries)
  }
}

export class AddFolderToFocusAction extends Action2 {
  static readonly ID = 'workbench.action.focusScope.addFolder'
  constructor() {
    super({
      id: AddFolderToFocusAction.ID,
      title: localize2('action.focusScope.addFolder.title', 'Add to Focus'),
      category: localize2('command.category.view', 'View'),
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const focusScope = accessor.get(IFocusScopeService)
    const entries = resolveFocusEntries(accessor, tree, args)
    if (entries.length === 0) return
    await focusScope.addFolders(entries)
  }
}

export class RemoveFolderFromFocusAction extends Action2 {
  static readonly ID = 'workbench.action.focusScope.removeFolder'
  constructor() {
    super({
      id: RemoveFolderFromFocusAction.ID,
      title: localize2('action.focusScope.removeFolder.title', 'Remove from Focus'),
      category: localize2('command.category.view', 'View'),
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const focusScope = accessor.get(IFocusScopeService)
    const entries = resolveFocusEntries(accessor, tree, args)
    if (entries.length === 0) return
    await focusScope.removeFolders(entries)
  }
}

export class ClearFocusScopeAction extends Action2 {
  static readonly ID = 'workbench.action.focusScope.clear'
  constructor() {
    super({
      id: ClearFocusScopeAction.ID,
      title: localize2('action.focusScope.clear.title', 'Exit Focus Mode'),
      category: localize2('command.category.view', 'View'),
      // Enabled, not active: the empty-but-enabled state is exactly the one the
      // user needs an exit from, and it has no folders to make `active` true.
      precondition: 'focusScopeEnabled',
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const focusScope = accessor.get(IFocusScopeService)
    await focusScope.setEnabled(false)
  }
}

/**
 * Browse for paths to focus. Unlike the Explorer context-menu commands this
 * works while focus is already narrow: the file dialog lists directories
 * straight from IFileService, so the folders focus is currently hiding are still
 * reachable — and it accepts a typed path, which beats scrolling a large tree.
 * Files are selectable too: a focus entry may name one file.
 */
export class AddFoldersToFocusAction extends Action2 {
  static readonly ID = 'workbench.action.focusScope.addFolders'
  constructor() {
    super({
      id: AddFoldersToFocusAction.ID,
      title: localize2('action.focusScope.addFolders.title', 'Add to Focus...'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Every service resolved before the first await: the accessor is only valid
    // synchronously, and the dialog below is a long one.
    const fileDialog = accessor.get(IFileDialogService)
    const focusScope = accessor.get(IFocusScopeService)
    const workspace = accessor.get(IWorkspaceService)
    const notification = accessor.get(INotificationService)
    const uriIdentity = accessor.get(IUriIdentityService)

    const root = workspace.current?.folder
    if (!root) {
      // Focus folders are workspace-relative, so there is nothing to be relative
      // to. Said out loud rather than silently ignored — the command is reachable
      // from the palette with no folder open.
      notification.notify({
        severity: Severity.Info,
        message: localize(
          'focusScope.noWorkspace',
          'Open a folder first — focus folders are relative to the open folder.',
        ),
      })
      return
    }

    const picked = await fileDialog.showOpenDialog({
      title: localize('focusScope.dialog.title', 'Add to Focus'),
      defaultUri: root,
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: localize('focusScope.dialog.confirm', 'Focus'),
    })
    if (!picked || picked.length === 0) return

    const inside: string[] = []
    let skipped = 0
    for (const uri of picked) {
      // A focus entry is a workspace-relative path by definition, so neither an
      // outside path (`relativePath` → null) nor the root itself (`''`, which
      // means "focus everything") can become one.
      // normalizeFocusFolders would drop both silently, and a command that
      // appears to do nothing is worse than one that says what it skipped.
      const rel = uriIdentity.relativePath(root, uri)
      if (rel === null || rel === '') skipped++
      else inside.push(rel)
    }

    if (inside.length > 0) await focusScope.addFolders(inside)

    if (skipped > 0) {
      notification.notify({
        severity: Severity.Warning,
        message: localize(
          'focusScope.dialog.skipped',
          'Skipped {count} selection(s): a focus entry must be inside the open folder.',
          { count: skipped },
        ),
      })
    }
  }
}

/**
 * The status-bar indicator's click target: remove a focused folder, add more, or
 * leave focus mode. Clicking used to exit focus outright, but "narrow this
 * further" and "drop one folder" are the everyday operations — an accidental
 * click costing the whole set was the wrong default.
 */
export class ManageFocusScopeAction extends Action2 {
  static readonly ID = 'workbench.action.focusScope.manage'
  constructor() {
    super({
      id: ManageFocusScopeAction.ID,
      title: localize2('action.focusScope.manage.title', 'Manage Focused Entries'),
      category: localize2('command.category.view', 'View'),
      precondition: 'focusScopeEnabled',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const focusScope = accessor.get(IFocusScopeService)
    const commands = accessor.get(ICommandService)

    const entries = focusScope.entries
    const removeLabel = localize('focusScope.manage.remove', 'Remove from focus')
    const items: QuickPickInput<FocusManageItem>[] = entries.map((entry) => ({
      id: `remove:${entry}`,
      label: entry,
      description: removeLabel,
      action: { kind: 'remove', entry } as const,
    }))
    if (items.length > 0) {
      items.push({ type: 'separator', id: 'focusScope.manage.sep' } satisfies IQuickPickSeparator)
    }
    items.push({
      id: 'add',
      label: localize('focusScope.manage.add', 'Add...'),
      action: { kind: 'add' } as const,
    })
    items.push({
      id: 'exit',
      label: localize('focusScope.manage.exit', 'Exit Focus Mode'),
      action: { kind: 'exit' } as const,
    })

    const chosen = await quickInput.pick(items, {
      placeholder:
        entries.length > 0
          ? localize('focusScope.manage.placeholder', 'Focused entries — pick one to remove')
          : localize('focusScope.manage.placeholderEmpty', 'Focus mode is on with nothing focused'),
    })
    if (!chosen) return

    switch (chosen.action.kind) {
      case 'remove':
        await focusScope.removeFolders([chosen.action.entry])
        return
      case 'add':
        await commands.executeCommand(AddFoldersToFocusAction.ID)
        return
      case 'exit':
        await focusScope.setEnabled(false)
        return
    }
  }
}

interface FocusManageItem extends IQuickPickItem {
  readonly action:
    | { readonly kind: 'remove'; readonly entry: string }
    | { readonly kind: 'add' }
    | { readonly kind: 'exit' }
}
