/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace Trust commands: grant / revoke trust for the current workspace, and
 *  a "manage" entry point that prompts. Mirrors VSCode's
 *  `workbench.trust.manage` / grant / revoke actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  INotificationService,
  IWorkspaceService,
  IWorkspaceTrustManagementService,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize2('command.category.workspaceTrust', 'Workspace Trust')

export class GrantWorkspaceTrustAction extends Action2 {
  static readonly ID = 'workbench.trust.grant'
  constructor() {
    super({
      id: GrantWorkspaceTrustAction.ID,
      title: localize2('action.trust.grant', 'Trust Workspace'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const trust = accessor.get(IWorkspaceTrustManagementService)
    const notification = accessor.get(INotificationService)
    if (!trust.canSetWorkspaceTrust()) {
      notification.notify({
        severity: Severity.Info,
        message: localize('trust.noFolder', 'Open a folder to manage workspace trust.'),
      })
      return
    }
    await trust.setWorkspaceTrust(true)
  }
}

export class RevokeWorkspaceTrustAction extends Action2 {
  static readonly ID = 'workbench.trust.revoke'
  constructor() {
    super({
      id: RevokeWorkspaceTrustAction.ID,
      title: localize2('action.trust.revoke', 'Restrict Workspace (Revoke Trust)'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const trust = accessor.get(IWorkspaceTrustManagementService)
    const dialog = accessor.get(IDialogService)
    if (!trust.canSetWorkspaceTrust() || !trust.isWorkspaceTrusted()) return
    const result = await dialog.confirm({
      type: 'warning',
      message: localize('trust.revoke.confirm', 'Restrict this workspace?'),
      detail: localize(
        'trust.revoke.detail',
        'Extensions that require a trusted workspace will be disabled and the extension host will restart.',
      ),
      primaryButton: localize('trust.revoke.primary', 'Restrict'),
    })
    if (result.confirmed) await trust.setWorkspaceTrust(false)
  }
}

export class ManageWorkspaceTrustAction extends Action2 {
  static readonly ID = 'workbench.trust.manage'
  constructor() {
    super({
      id: ManageWorkspaceTrustAction.ID,
      title: localize2('action.trust.manage', 'Manage Workspace Trust'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const trust = accessor.get(IWorkspaceTrustManagementService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)
    const workspace = accessor.get(IWorkspaceService)

    if (!trust.canSetWorkspaceTrust()) {
      notification.notify({
        severity: Severity.Info,
        message: localize('trust.noFolder', 'Open a folder to manage workspace trust.'),
      })
      return
    }

    const trusted = trust.isWorkspaceTrusted()
    const folder = workspace.current?.folder.fsPath ?? ''
    const result = await dialog.confirm({
      type: trusted ? 'info' : 'warning',
      message: trusted
        ? localize('trust.manage.trustedMsg', 'This workspace is trusted.')
        : localize('trust.manage.untrustedMsg', 'Do you trust the authors of this workspace?'),
      detail: trusted
        ? localize('trust.manage.trustedDetail', '{folder}\n\nAll extensions are enabled.', {
            folder,
          })
        : localize(
            'trust.manage.untrustedDetail',
            '{folder}\n\nTrust the folder to enable all extensions. In Restricted Mode, extensions that require trust are disabled.',
            { folder },
          ),
      primaryButton: trusted
        ? localize('trust.manage.restrict', 'Restrict')
        : localize('trust.manage.trust', 'Trust'),
      cancelButton: localize('trust.manage.cancel', 'Cancel'),
    })
    if (result.confirmed) await trust.setWorkspaceTrust(!trusted)
  }
}
