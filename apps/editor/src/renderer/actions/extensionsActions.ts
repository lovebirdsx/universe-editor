/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Extension management commands: install a local `.vsix`, uninstall an installed
 *  extension. The heavy lifting (download-free extract + registry) lives in the
 *  main-process IExtensionManagementService; these are thin command wrappers.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IFileDialogService,
  INotificationService,
  IQuickInputService,
  IViewsService,
  Severity,
  localize,
  localize2,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IExtensionManagementService } from '../../shared/ipc/extensionManagementService.js'
import {
  IExtensionEnablementService,
  EnablementState,
} from '../services/extensions/ExtensionEnablementService.js'

const CATEGORY = localize2('command.category.extensions', 'Extensions')

export class ShowExtensionsAction extends Action2 {
  static readonly ID = 'workbench.extensions.action.showExtensions'
  constructor() {
    super({
      id: ShowExtensionsAction.ID,
      title: localize2('action.extensions.show', 'Show Installed Extensions'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IViewsService).openViewContainer('workbench.view.extensions')
  }
}

export class InstallExtensionFromVsixAction extends Action2 {
  static readonly ID = 'workbench.extensions.action.installFromVSIX'
  constructor() {
    super({
      id: InstallExtensionFromVsixAction.ID,
      title: localize2('action.extensions.installFromVSIX', 'Install from VSIX…'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service synchronously — the accessor is invalid after the
    // first await (see the async-accessor invalidation guard).
    const fileDialog = accessor.get(IFileDialogService)
    const management = accessor.get(IExtensionManagementService)
    const notification = accessor.get(INotificationService)

    const picked = await fileDialog.showOpenDialog({
      title: localize('action.extensions.installFromVSIX.title', 'Install from VSIX'),
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: localize('action.extensions.installFromVSIX.open', 'Install'),
    })
    if (!picked) return

    const vsixPath = picked.fsPath
    if (!/\.vsix$/i.test(vsixPath)) {
      notification.notify({
        severity: Severity.Error,
        message: localize(
          'action.extensions.installFromVSIX.notVsix',
          'The selected file is not a .vsix package.',
        ),
      })
      return
    }

    try {
      const local = await management.installVSIX(vsixPath)
      notification.notify({
        severity: Severity.Info,
        message: localize(
          'action.extensions.installFromVSIX.done',
          'Installed extension "{name}" ({version}).',
          {
            name: local.manifest.displayName ?? local.identifier,
            version: local.version,
          },
        ),
      })
    } catch (err) {
      notification.notify({
        severity: Severity.Error,
        message: localize(
          'action.extensions.installFromVSIX.failed',
          'Failed to install extension: {error}',
          { error: (err as Error).message },
        ),
      })
    }
  }
}

export class UninstallExtensionAction extends Action2 {
  static readonly ID = 'workbench.extensions.action.uninstall'
  constructor() {
    super({
      id: UninstallExtensionAction.ID,
      title: localize2('action.extensions.uninstall', 'Uninstall Extension…'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const management = accessor.get(IExtensionManagementService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)

    const installed = await management.getInstalled()
    if (installed.length === 0) {
      notification.notify({
        severity: Severity.Info,
        message: localize('action.extensions.uninstall.none', 'No user extensions are installed.'),
      })
      return
    }

    const items: (IQuickPickItem & { identifier: string })[] = installed.map((ext) => ({
      id: ext.identifier,
      identifier: ext.identifier,
      label: ext.manifest.displayName ?? ext.identifier,
      description: `${ext.identifier} · ${ext.version}`,
    }))

    const picked = await quickInput.pick(items, {
      id: 'extensions.uninstall',
      placeholder: localize(
        'action.extensions.uninstall.placeholder',
        'Select an extension to uninstall',
      ),
      matchOnDescription: true,
    })
    if (!picked) return

    const confirmed = await dialog.confirm({
      type: 'warning',
      message: localize('action.extensions.uninstall.confirm', 'Uninstall "{name}"?', {
        name: picked.label,
      }),
      primaryButton: localize('action.extensions.uninstall.confirm.yes', 'Uninstall'),
      cancelButton: localize('common.cancel', 'Cancel'),
    })
    if (!confirmed.confirmed) return

    try {
      await management.uninstall(picked.identifier)
      notification.notify({
        severity: Severity.Info,
        message: localize('action.extensions.uninstall.done', 'Uninstalled "{name}".', {
          name: picked.label,
        }),
      })
    } catch (err) {
      notification.notify({
        severity: Severity.Error,
        message: localize(
          'action.extensions.uninstall.failed',
          'Failed to uninstall extension: {error}',
          { error: (err as Error).message },
        ),
      })
    }
  }
}

export class CheckForExtensionUpdatesAction extends Action2 {
  static readonly ID = 'workbench.extensions.action.checkForUpdates'
  constructor() {
    super({
      id: CheckForExtensionUpdatesAction.ID,
      title: localize2('action.extensions.checkForUpdates', 'Check for Extension Updates'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const management = accessor.get(IExtensionManagementService)
    const notification = accessor.get(INotificationService)

    const updates = await management.checkForUpdates()
    if (updates.length === 0) {
      notification.notify({
        severity: Severity.Info,
        message: localize(
          'action.extensions.checkForUpdates.none',
          'All extensions are up to date.',
        ),
      })
      return
    }

    for (const update of updates) {
      try {
        await management.updateExtension(update)
      } catch (err) {
        notification.notify({
          severity: Severity.Error,
          message: localize('action.extensions.update.failed', 'Failed to update {name}: {error}', {
            name: update.identifier,
            error: (err as Error).message,
          }),
        })
      }
    }
    notification.notify({
      severity: Severity.Info,
      message: localize('action.extensions.checkForUpdates.done', 'Updated {count} extension(s).', {
        count: updates.length,
      }),
    })
  }
}

/** A pickable extension with its current enablement state. */
interface IEnablementPickContext {
  management: IExtensionManagementService
  enablement: IExtensionEnablementService
  quickInput: IQuickInputService
  notification: INotificationService
}

/**
 * Prompt for an installed / built-in extension whose current enablement matches
 * `wantEnabled`, then apply `target`. Shared by the four enable/disable commands.
 */
async function pickAndSetEnablement(
  ctx: IEnablementPickContext,
  opts: {
    wantEnabled: boolean
    target: EnablementState
    placeholder: string
    emptyMessage: string
  },
): Promise<void> {
  const all = [
    ...(await ctx.management.listBuiltinExtensions()),
    ...(await ctx.management.getInstalled()),
  ]
  const withState = await Promise.all(
    all.map(async (ext) => ({
      ext,
      state: await ctx.enablement.getEnablementState(ext.identifier),
    })),
  )
  const isEnabled = (s: EnablementState): boolean =>
    s === EnablementState.EnabledGlobally || s === EnablementState.EnabledWorkspace
  const candidates = withState.filter(({ state }) => isEnabled(state) === opts.wantEnabled)

  if (candidates.length === 0) {
    ctx.notification.notify({ severity: Severity.Info, message: opts.emptyMessage })
    return
  }

  const items: (IQuickPickItem & { identifier: string })[] = candidates.map(({ ext }) => ({
    id: ext.identifier,
    identifier: ext.identifier,
    label: ext.manifest.displayName ?? ext.identifier,
    description: `${ext.identifier} · ${ext.version}`,
  }))

  const picked = await ctx.quickInput.pick(items, {
    id: 'extensions.enablement',
    placeholder: opts.placeholder,
    matchOnDescription: true,
  })
  if (!picked) return

  await ctx.enablement.setEnablement(picked.identifier, opts.target)
}

function enablementContext(accessor: ServicesAccessor): IEnablementPickContext {
  return {
    management: accessor.get(IExtensionManagementService),
    enablement: accessor.get(IExtensionEnablementService),
    quickInput: accessor.get(IQuickInputService),
    notification: accessor.get(INotificationService),
  }
}

export class EnableExtensionGloballyAction extends Action2 {
  static readonly ID = 'extensions.enableGlobally'
  constructor() {
    super({
      id: EnableExtensionGloballyAction.ID,
      title: localize2('action.extensions.enableGlobally', 'Enable Extension'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickAndSetEnablement(enablementContext(accessor), {
      wantEnabled: false,
      target: EnablementState.EnabledGlobally,
      placeholder: localize(
        'action.extensions.enable.placeholder',
        'Select an extension to enable',
      ),
      emptyMessage: localize('action.extensions.enable.none', 'No disabled extensions.'),
    })
  }
}

export class DisableExtensionGloballyAction extends Action2 {
  static readonly ID = 'extensions.disableGlobally'
  constructor() {
    super({
      id: DisableExtensionGloballyAction.ID,
      title: localize2('action.extensions.disableGlobally', 'Disable Extension'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickAndSetEnablement(enablementContext(accessor), {
      wantEnabled: true,
      target: EnablementState.DisabledGlobally,
      placeholder: localize(
        'action.extensions.disable.placeholder',
        'Select an extension to disable',
      ),
      emptyMessage: localize('action.extensions.disable.none', 'No enabled extensions.'),
    })
  }
}

export class EnableExtensionForWorkspaceAction extends Action2 {
  static readonly ID = 'extensions.enableForWorkspace'
  constructor() {
    super({
      id: EnableExtensionForWorkspaceAction.ID,
      title: localize2('action.extensions.enableForWorkspace', 'Enable Extension (Workspace)'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const ctx = enablementContext(accessor)
    if (!ctx.enablement.hasWorkspace()) {
      ctx.notification.notify({
        severity: Severity.Info,
        message: localize(
          'action.extensions.workspace.none',
          'Open a folder to change workspace enablement.',
        ),
      })
      return
    }
    await pickAndSetEnablement(ctx, {
      wantEnabled: false,
      target: EnablementState.EnabledWorkspace,
      placeholder: localize(
        'action.extensions.enableWorkspace.placeholder',
        'Select an extension to enable for this workspace',
      ),
      emptyMessage: localize('action.extensions.enable.none', 'No disabled extensions.'),
    })
  }
}

export class DisableExtensionForWorkspaceAction extends Action2 {
  static readonly ID = 'extensions.disableForWorkspace'
  constructor() {
    super({
      id: DisableExtensionForWorkspaceAction.ID,
      title: localize2('action.extensions.disableForWorkspace', 'Disable Extension (Workspace)'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const ctx = enablementContext(accessor)
    if (!ctx.enablement.hasWorkspace()) {
      ctx.notification.notify({
        severity: Severity.Info,
        message: localize(
          'action.extensions.workspace.none',
          'Open a folder to change workspace enablement.',
        ),
      })
      return
    }
    await pickAndSetEnablement(ctx, {
      wantEnabled: true,
      target: EnablementState.DisabledWorkspace,
      placeholder: localize(
        'action.extensions.disableWorkspace.placeholder',
        'Select an extension to disable for this workspace',
      ),
      emptyMessage: localize('action.extensions.disable.none', 'No enabled extensions.'),
    })
  }
}
