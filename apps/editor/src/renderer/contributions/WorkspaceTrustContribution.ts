/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkspaceTrustContribution — surfaces Workspace Trust in the UI:
 *   - a StatusBar "Restricted Mode" entry (left) whenever the open folder is
 *     untrusted, clicking it opens the manage-trust dialog;
 *   - a one-shot startup prompt the first time an untrusted folder is opened,
 *     so the user can grant trust without hunting for the command.
 *
 *  Mirrors VSCode's Restricted Mode status entry + startup trust request. The
 *  trust state authority lives in IWorkspaceTrustManagementService; this is pure
 *  presentation on top of it.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  IStatusBarService,
  IStorageService,
  IWorkspaceService,
  IWorkspaceTrustManagementService,
  StatusBarAlignment,
  StorageScope,
  localize,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ManageWorkspaceTrustAction } from '../actions/workspaceTrustActions.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

/** Per-workspace flag so the startup prompt only shows once per folder. */
const PROMPTED_STORAGE_KEY = 'workbench.trust.promptedOnStartup'

export class WorkspaceTrustContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined

  constructor(
    @IWorkspaceTrustManagementService
    private readonly _trust: IWorkspaceTrustManagementService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @ICommandService private readonly _commands: ICommandService,
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {
    super()
    this._register(this._trust.onDidChangeTrust(() => this._render()))
    this._register(this._workspace.onDidChangeWorkspace(() => this._onWorkspaceChanged()))
    this._register({ dispose: () => this._accessor?.dispose() })
    void this._initialize()
  }

  private async _initialize(): Promise<void> {
    await this._trust.workspaceTrustInitialized
    this._render()
    await this._maybePromptOnStartup()
  }

  private _render(): void {
    // Only show the entry in Restricted Mode (untrusted folder). A trusted or
    // folderless window shows nothing, matching VSCode.
    const show = this._trust.canSetWorkspaceTrust() && !this._trust.isWorkspaceTrusted()
    if (!show) {
      this._accessor?.dispose()
      this._accessor = undefined
      return
    }
    const entry = {
      text: localize('trust.status.restricted', 'Restricted Mode'),
      icon: 'shield',
      tooltip: localize(
        'trust.status.tooltip',
        'This workspace is in Restricted Mode. Some extensions are disabled. Click to manage trust.',
      ),
      command: ManageWorkspaceTrustAction.ID,
      alignment: StatusBarAlignment.Left,
      priority: 10,
    }
    if (this._accessor) this._accessor.update(entry)
    else this._accessor = this._statusBar.addEntry(entry)
  }

  private _onWorkspaceChanged(): void {
    this._render()
    void this._maybePromptOnStartup()
  }

  private async _maybePromptOnStartup(): Promise<void> {
    // The auto-modal would block the E2E harness (which opens folders headless);
    // the status-bar entry + command still work, so only the prompt is skipped.
    if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) return
    if (!this._trust.canSetWorkspaceTrust() || this._trust.isWorkspaceTrusted()) return
    const alreadyPrompted = await this._storage.get<boolean>(
      PROMPTED_STORAGE_KEY,
      StorageScope.WORKSPACE,
    )
    if (alreadyPrompted) return
    await this._storage.set(PROMPTED_STORAGE_KEY, true, StorageScope.WORKSPACE)
    await this._commands.executeCommand(ManageWorkspaceTrustAction.ID)
  }
}
