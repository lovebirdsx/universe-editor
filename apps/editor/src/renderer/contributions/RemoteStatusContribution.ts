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
  type RemoteConnectionProgressDto,
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

const REMOTE_STEP_LABEL: Record<RemoteConnectionProgressDto['stepId'], string> = {
  'stopping-old': localize('remote.status.step.stoppingOld', 'Stopping old server'),
  uploading: localize('remote.status.step.uploading', 'Uploading server bundle'),
  installing: localize('remote.status.step.installing', 'Installing server'),
  'starting-daemon': localize('remote.status.step.startingDaemon', 'Starting server'),
}

interface MenuItem extends IQuickPickItem {
  readonly commandId: string
}

export class RemoteStatusContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined
  private readonly _remoteAuthorityKey: IContextKey<string>
  private readonly _states = new Map<string, RemoteConnectionStateDto>()
  private readonly _progress = new Map<string, RemoteConnectionProgressDto>()
  private _timer: ReturnType<typeof setInterval> | undefined

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
        if (status.progress !== undefined) this._progress.set(status.authority, status.progress)
        else this._progress.delete(status.authority)
        this._states.set(status.authority, status.state)
        this._render()
      }),
    )
    this._register({ dispose: () => this._accessor?.dispose() })
    this._register({
      dispose: () => {
        if (this._timer !== undefined) clearInterval(this._timer)
      },
    })

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

  /**
   * A fresh connect brings the server up before the remote folder opens
   * (connect → openFolder), so fall back to any in-flight bring-up while the
   * workspace is still local — otherwise install steps would never surface.
   */
  private _displayAuthority(): string | undefined {
    const current = this._currentAuthority()
    if (current !== undefined) return current
    for (const [authority, state] of this._states) {
      if (state === 'deploying' || state === 'forwarding' || state === 'handshaking') {
        return authority
      }
    }
    return undefined
  }

  private _render(): void {
    this._remoteAuthorityKey.set(this._currentAuthority() ?? '')
    const authority = this._displayAuthority()
    if (authority === undefined) {
      this._accessor?.dispose()
      this._accessor = undefined
      this._stopTimer()
      return
    }
    const entry = this._entryFor(authority)
    if (this._accessor !== undefined) this._accessor.update(entry)
    else this._accessor = this._statusBar.addEntry(entry)
    if (this._progress.has(authority)) this._startTimer()
    else this._stopTimer()
  }

  private _startTimer(): void {
    if (this._timer !== undefined) return
    this._timer = setInterval(() => this._render(), 1000)
  }

  private _stopTimer(): void {
    if (this._timer === undefined) return
    clearInterval(this._timer)
    this._timer = undefined
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
      case 'handshaking': {
        const progress = this._progress.get(authority)
        if (progress !== undefined) {
          return {
            ...base,
            text: localize(
              'remote.status.step',
              'SSH: {authority} (Step {index}/{total}: {step} · {elapsed})',
              {
                authority,
                index: progress.stepIndex,
                total: progress.stepTotal,
                step: REMOTE_STEP_LABEL[progress.stepId],
                elapsed: formatElapsedMs(Date.now() - progress.startedAt),
              },
            ),
            showProgress: 'spinning',
          }
        }
        return {
          ...base,
          text: localize('remote.status.connecting', 'SSH: {authority} (Connecting...)', {
            authority,
          }),
          showProgress: 'spinning',
        }
      }
      default:
        return {
          ...base,
          text: localize('remote.status.connected', '$(remote) SSH: {authority}', { authority }),
        }
    }
  }

  private async _showMenu(): Promise<void> {
    const authority = this._displayAuthority()
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

export function formatElapsedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (totalSeconds < 60) return `${seconds}s`
  if (hours === 0) return `${minutes}m ${seconds}s`
  return `${hours}h ${minutes}m ${seconds}s`
}
