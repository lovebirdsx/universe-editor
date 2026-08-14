/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteStatusContribution — the leftmost status-bar entry for a remote-ssh
 *  workspace (VSCode's RemoteStatusIndicator, simplified). Shows `SSH: <authority>`
 *  with a state-dependent glyph/spinner, seeds the `remoteAuthority` context key,
 *  and opens a QuickPick menu (Open Folder on Host / Close / Retry / Stop Server)
 *  on click. The entry exists only while the current workspace folder is remote-ssh.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  Disposable,
  ICommandService,
  IContextKeyService,
  IQuickInputService,
  IStatusBarService,
  IWorkspaceService,
  REMOTE_SCHEME,
  StatusBarAlignment,
  localize,
  localize2,
  registerAction2,
  type IContextKey,
  type IQuickPickItem,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type RemoteConnectionStateDto,
} from '../../shared/ipc/remoteStatusService.js'
import {
  CloseConnectionAction,
  ConnectToWslAction,
  OpenFolderOnHostAction,
  RetryConnectionAction,
  StopRemoteServerAction,
} from '../actions/remoteActions.js'

const REMOTE_STATUS_MENU_COMMAND_ID = 'workbench.action.remote.showMenu'

interface MenuItem extends IQuickPickItem {
  readonly commandId: string
}

export class RemoteStatusContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined
  private readonly _remoteAuthorityKey: IContextKey<string>
  private readonly _states = new Map<string, RemoteConnectionStateDto>()

  constructor(
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @ICommandService private readonly _commands: ICommandService,
    @IQuickInputService private readonly _quickInput: IQuickInputService,
  ) {
    super()
    const showMenu = () => void this._showMenu()

    this._remoteAuthorityKey = contextKeyService.createKey<string>('remoteAuthority', '')

    this._register(
      registerAction2(
        class extends Action2 {
          constructor() {
            super({
              id: REMOTE_STATUS_MENU_COMMAND_ID,
              title: localize2('remote.menu.title', 'Show Remote Menu'),
            })
          }
          override run(accessor: ServicesAccessor): void {
            void accessor
            showMenu()
          }
        },
      ),
    )

    this._register(this._workspace.onDidChangeWorkspace(() => this._render()))
    this._register(
      this._remoteStatus.onDidChangeState((status) => {
        this._states.set(status.authority, status.state)
        this._render()
      }),
    )
    this._register({ dispose: () => this._accessor?.dispose() })

    void this._seedStates().then(() => this._render())
    this._render()
  }

  private async _seedStates(): Promise<void> {
    for (const c of await this._remoteStatus.getConnections()) {
      this._states.set(c.authority, c.state)
    }
  }

  private _currentAuthority(): string | undefined {
    const folder = this._workspace.current?.folder
    return folder !== undefined && folder.scheme === REMOTE_SCHEME ? folder.authority : undefined
  }

  private _render(): void {
    const authority = this._currentAuthority()
    this._remoteAuthorityKey.set(authority ?? '')
    if (authority === undefined) {
      this._accessor?.dispose()
      this._accessor = undefined
      return
    }
    const entry = this._entryFor(authority)
    if (this._accessor !== undefined) this._accessor.update(entry)
    else this._accessor = this._statusBar.addEntry(entry)
  }

  private _entryFor(authority: string): IStatusBarEntry {
    const state = this._states.get(authority)
    const base = {
      tooltip: localize('remote.status.tooltip', 'Remote: {authority}', { authority }),
      command: REMOTE_STATUS_MENU_COMMAND_ID,
      alignment: StatusBarAlignment.Left,
      priority: Number.POSITIVE_INFINITY,
    }
    switch (state) {
      case 'reconnecting':
        return {
          ...base,
          text: localize('remote.status.reconnecting', 'SSH: {authority} (Reconnecting...)', {
            authority,
          }),
          showProgress: 'syncing',
        }
      case 'failed':
        return {
          ...base,
          text: localize('remote.status.failed', '$(warning) SSH: {authority} (Failed)', {
            authority,
          }),
        }
      case 'deploying':
      case 'forwarding':
      case 'handshaking':
        return {
          ...base,
          text: localize('remote.status.connecting', 'SSH: {authority} (Connecting...)', {
            authority,
          }),
          showProgress: 'spinning',
        }
      default:
        return {
          ...base,
          text: localize('remote.status.connected', '$(remote) SSH: {authority}', { authority }),
        }
    }
  }

  private async _showMenu(): Promise<void> {
    const authority = this._currentAuthority()
    if (authority === undefined) return
    const wslDistros = await this._remoteStatus.listWslDistros().catch(() => [])
    const items: MenuItem[] = [
      {
        id: OpenFolderOnHostAction.ID,
        label: localize('remote.menu.openFolder', 'Open Folder on Host...'),
        commandId: OpenFolderOnHostAction.ID,
      },
      ...(wslDistros.length > 0
        ? [
            {
              id: ConnectToWslAction.ID,
              label: localize('remote.menu.connectToWsl', 'Connect to WSL...'),
              commandId: ConnectToWslAction.ID,
            },
          ]
        : []),
      {
        id: CloseConnectionAction.ID,
        label: localize('remote.menu.close', 'Close Connection'),
        commandId: CloseConnectionAction.ID,
      },
      {
        id: RetryConnectionAction.ID,
        label: localize('remote.menu.retry', 'Retry Connection'),
        commandId: RetryConnectionAction.ID,
      },
      {
        id: StopRemoteServerAction.ID,
        label: localize('remote.menu.stopServer', 'Stop Remote Server'),
        commandId: StopRemoteServerAction.ID,
      },
    ]
    const picked = await this._quickInput.pick<MenuItem>(items, {
      placeholder: localize('remote.menu.placeholder', 'Remote ({authority})', { authority }),
    })
    if (picked === undefined) return
    if (picked.commandId === ConnectToWslAction.ID) {
      void this._commands.executeCommand(picked.commandId)
    } else {
      void this._commands.executeCommand(picked.commandId, authority)
    }
  }
}
