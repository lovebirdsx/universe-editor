/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote-SSH command family: connect to a host and open a remote folder, open a
 *  folder on an already-connected host, and lifecycle commands (close / retry /
 *  stop), plus the WSL connect command over the same wire. Mirrors the VSCode
 *  Remote-SSH / WSL command surface; all interaction goes through
 *  IRemoteStatusService (the thin wire facade over the main connection manager),
 *  IQuickInputService, and IFileDialogService. Helpers take services (not the
 *  accessor): a ServicesAccessor dies at the first await, so every action gathers
 *  its services synchronously at the top of run().
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IFileDialogService,
  ILifecycleService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  IWorkspaceService,
  ProgressLocation,
  REMOTE_SCHEME,
  Severity,
  ShutdownReason,
  isValidWslDistroName,
  localize,
  localize2,
  remoteFsPathToUri,
  wslAuthorityForDistro,
  type IFileDialogService as IFileDialogServiceType,
  type ILifecycleService as ILifecycleServiceType,
  type INotificationService as INotificationServiceType,
  type IProgressService as IProgressServiceType,
  type IQuickInputService as IQuickInputServiceType,
  type IQuickPickItem,
  type IWorkspaceService as IWorkspaceServiceType,
  type QuickPickInput,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type IRemoteStatusService as IRemoteStatusServiceType,
  type RemoteEnvironmentDto,
  type WslDistroDto,
} from '../../shared/ipc/remoteStatusService.js'
import { IRemoteExplorerService } from '../services/remote/RemoteExplorerService.js'

const CATEGORY = localize2('command.category.remoteSsh', 'Remote-SSH')
const WSL_CATEGORY = localize2('command.category.wsl', 'WSL')

interface AuthorityPickItem extends IQuickPickItem {
  readonly authority: string
}

interface RemoteConnectServices {
  readonly remoteStatus: IRemoteStatusServiceType
  readonly notification: INotificationServiceType
  readonly progress: IProgressServiceType
  readonly quickInput: IQuickInputServiceType
  readonly fileDialog: IFileDialogServiceType
  readonly workspace: IWorkspaceServiceType
  readonly lifecycle: ILifecycleServiceType
}

/** Must run before the first await — the accessor is dead afterwards. */
function gatherConnectServices(accessor: ServicesAccessor): RemoteConnectServices {
  return {
    remoteStatus: accessor.get(IRemoteStatusService),
    notification: accessor.get(INotificationService),
    progress: accessor.get(IProgressService),
    quickInput: accessor.get(IQuickInputService),
    fileDialog: accessor.get(IFileDialogService),
    workspace: accessor.get(IWorkspaceService),
    lifecycle: accessor.get(ILifecycleService),
  }
}

/**
 * QuickPick over authorities. With `allowFreeInput`, an Enter with no focused
 * item resolves the raw input value (for `user@host[:port]` typing); otherwise
 * only a concrete item resolves.
 */
function pickAuthority(
  quickInput: IQuickInputServiceType,
  items: readonly QuickPickInput<AuthorityPickItem>[],
  placeholder: string,
  allowFreeInput: boolean,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const pick = quickInput.createQuickPick<AuthorityPickItem>()
    pick.items = items
    pick.placeholder = placeholder
    if (allowFreeInput) pick.autoFocusFirstItem = false
    let accepted = false
    pick.onDidAccept((selected) => {
      const item = selected[0]
      if (item) {
        accepted = true
        pick.hide()
        resolve(item.authority)
        return
      }
      if (!allowFreeInput) return
      const value = pick.value.trim()
      accepted = true
      pick.hide()
      resolve(value === '' ? undefined : value)
    })
    pick.onDidHide(() => {
      if (!accepted) resolve(undefined)
      pick.dispose()
    })
    pick.show()
  })
}

/** Select a remote folder (rooted at the host home) and open it as the workspace. */
async function selectAndOpenRemoteFolder(
  services: RemoteConnectServices,
  authority: string,
  env: RemoteEnvironmentDto,
): Promise<void> {
  const { fileDialog, workspace, lifecycle, progress } = services

  const folder = (
    await fileDialog.showOpenDialog({
      title: localize('remote.openFolder.title', 'Open Folder on {authority}', { authority }),
      defaultUri: remoteFsPathToUri(env.homeDir, authority),
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: localize('fileDialog.openFolderButton', 'Open'),
    })
  )?.[0]
  if (!folder) return
  if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
  await progress.withProgress(
    {
      location: ProgressLocation.Window,
      title: localize('progress.openFolder', 'Opening folder…'),
      source: 'workspace',
    },
    () => workspace.openFolder(folder),
  )
}

/** Connect (progress-wrapped, error → notification) then pick and open a remote folder. */
async function connectAndOpenRemoteFolder(
  services: RemoteConnectServices,
  authority: string,
): Promise<void> {
  const { remoteStatus, notification, progress } = services

  let env: RemoteEnvironmentDto
  try {
    env = await progress.withProgress(
      {
        location: ProgressLocation.Window,
        title: localize('remote.progress.connect', 'Connecting to {authority}…', { authority }),
        source: 'remote',
      },
      () => remoteStatus.connect(authority),
    )
  } catch (err) {
    notification.notify({
      severity: Severity.Error,
      message: localize('remote.connect.failed', 'Failed to connect to {authority}: {message}', {
        authority,
        message: err instanceof Error ? err.message : String(err),
      }),
    })
    return
  }
  await selectAndOpenRemoteFolder(services, authority, env)
}

async function listWslDistrosSafe(
  remoteStatus: IRemoteStatusServiceType,
): Promise<readonly WslDistroDto[]> {
  const distros = await remoteStatus.listWslDistros().catch((): readonly WslDistroDto[] => [])
  return distros.filter((d) => isValidWslDistroName(d.name))
}

function wslPickItems(distros: readonly WslDistroDto[]): AuthorityPickItem[] {
  return distros.map((d) => ({
    id: wslAuthorityForDistro(d.name),
    label: localize('remote.wsl.pickLabel', '{name} (WSL)', { name: d.name }),
    ...(d.isDefault ? { description: localize('remote.wsl.default', 'default') } : {}),
    authority: wslAuthorityForDistro(d.name),
  }))
}

export class ConnectToHostAction extends Action2 {
  static readonly ID = 'remote.connectToHost'
  constructor() {
    super({
      id: ConnectToHostAction.ID,
      title: localize2('action.remote.connectToHost.title', 'Connect to Host…'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
    const services = gatherConnectServices(accessor)

    let authority = authorityArg
    if (authority === undefined) {
      const [hosts, wslDistros] = await Promise.all([
        services.remoteStatus.listSshHosts(),
        listWslDistrosSafe(services.remoteStatus),
      ])
      const items: QuickPickInput<AuthorityPickItem>[] = hosts.map((host) => ({
        id: host,
        label: host,
        description: localize('remote.connectToHost.sshConfig', 'SSH config'),
        authority: host,
      }))
      if (wslDistros.length > 0) {
        items.push({
          type: 'separator',
          id: 'remote.connectToHost.wslSeparator',
          label: localize('remote.section.wslTargets', 'WSL Targets'),
        })
        items.push(...wslPickItems(wslDistros))
      }
      authority = await pickAuthority(
        services.quickInput,
        items,
        localize('remote.connectToHost.placeholder', 'user@host[:port] or select a host'),
        true,
      )
      if (!authority) return
    }

    await connectAndOpenRemoteFolder(services, authority)
  }
}

export class ConnectToWslAction extends Action2 {
  static readonly ID = 'remote.connectToWsl'
  constructor() {
    super({
      id: ConnectToWslAction.ID,
      title: localize2('action.remote.connectToWsl.title', 'Connect to WSL…'),
      category: WSL_CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
    const services = gatherConnectServices(accessor)

    let authority = authorityArg
    if (authority === undefined) {
      const distros = await listWslDistrosSafe(services.remoteStatus)
      if (distros.length === 0) {
        services.notification.notify({
          severity: Severity.Info,
          message: localize(
            'remote.wsl.noneDetected',
            'No WSL distribution detected. Install WSL and a distribution, then try again.',
          ),
        })
        return
      }
      if (distros.length === 1) {
        authority = wslAuthorityForDistro(distros[0]!.name)
      } else {
        const ordered = [...distros].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
        authority = await pickAuthority(
          services.quickInput,
          wslPickItems(ordered),
          localize('remote.connectToWsl.placeholder', 'Select a WSL distribution'),
          false,
        )
        if (!authority) return
      }
    }

    await connectAndOpenRemoteFolder(services, authority)
  }
}

export class OpenFolderOnHostAction extends Action2 {
  static readonly ID = 'remote.openFolder'
  constructor() {
    super({
      id: OpenFolderOnHostAction.ID,
      title: localize2('action.remote.openFolder.title', 'Open Folder on Host…'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
    const services = gatherConnectServices(accessor)
    const { remoteStatus, notification } = services

    let authority: string | undefined = authorityArg
    if (authority === undefined) {
      const connected = (await remoteStatus.getConnections()).filter((c) => c.state === 'connected')
      if (connected.length === 0) {
        notification.notify({
          severity: Severity.Warning,
          message: localize(
            'remote.noConnected',
            "No connected host. Run 'Remote-SSH: Connect to Host…' first.",
          ),
        })
        return
      }

      if (connected.length === 1) {
        authority = connected[0]!.authority
      } else {
        const picked = await pickAuthority(
          services.quickInput,
          connected.map((c) => ({ id: c.authority, label: c.authority, authority: c.authority })),
          localize('remote.openFolder.placeholder', 'Select a connected host'),
          false,
        )
        if (!picked) return
        authority = picked
      }
    }

    const env = await remoteStatus.getEnvironment(authority)
    if (!env) {
      notification.notify({
        severity: Severity.Error,
        message: localize('remote.notConnected', "'{authority}' is not connected.", { authority }),
      })
      return
    }
    await selectAndOpenRemoteFolder(services, authority, env)
  }
}

export class CloseConnectionAction extends Action2 {
  static readonly ID = 'remote.closeConnection'
  constructor() {
    super({
      id: CloseConnectionAction.ID,
      title: localize2('action.remote.closeConnection.title', 'Close Connection'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
    const remoteStatus = accessor.get(IRemoteStatusService)
    const workspace = accessor.get(IWorkspaceService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)
    const quickInput = accessor.get(IQuickInputService)

    let authority: string | undefined = authorityArg
    if (authority === undefined) {
      const connections = (await remoteStatus.getConnections()).filter(
        (c) => c.state === 'connected' || c.state === 'reconnecting',
      )
      if (connections.length === 0) {
        notification.notify({
          severity: Severity.Info,
          message: localize('remote.closeConnection.none', 'No connected host to close.'),
        })
        return
      }
      authority = await pickAuthority(
        quickInput,
        connections.map((c) => ({ id: c.authority, label: c.authority, authority: c.authority })),
        localize('remote.closeConnection.placeholder', 'Select a connection to close'),
        false,
      )
      if (!authority) return
    }

    const current = workspace.current
    if (current?.folder.scheme === REMOTE_SCHEME && current.folder.authority === authority) {
      const { confirmed } = await dialog.confirm({
        type: 'warning',
        message: localize(
          'remote.closeConnection.confirm',
          "Close the connection to '{authority}'? This closes the remote workspace.",
          { authority },
        ),
        primaryButton: localize('remote.closeConnection.confirmButton', 'Close'),
        cancelButton: localize('common.cancel', 'Cancel'),
      })
      if (!confirmed) return
      await workspace.closeFolder()
    }
    await remoteStatus.closeConnection(authority)
  }
}

export class RetryConnectionAction extends Action2 {
  static readonly ID = 'remote.retryConnection'
  constructor() {
    super({
      id: RetryConnectionAction.ID,
      title: localize2('action.remote.retryConnection.title', 'Retry Connection'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
    const remoteStatus = accessor.get(IRemoteStatusService)
    const notification = accessor.get(INotificationService)
    const quickInput = accessor.get(IQuickInputService)

    let authority: string | undefined = authorityArg
    if (authority === undefined) {
      const failed = (await remoteStatus.getConnections()).filter((c) => c.state === 'failed')
      if (failed.length === 0) {
        notification.notify({
          severity: Severity.Info,
          message: localize('remote.noFailed', 'No failed connection to retry.'),
        })
        return
      }
      authority = await pickAuthority(
        quickInput,
        failed.map((c) => ({
          id: c.authority,
          label: c.authority,
          ...(c.errorMessage !== undefined ? { description: c.errorMessage } : {}),
          authority: c.authority,
        })),
        localize('remote.retryConnection.placeholder', 'Select a connection to retry'),
        false,
      )
      if (!authority) return
    }
    await remoteStatus.retryConnection(authority)
  }
}

/**
 * Forget a manually-added SSH host from the Remote Explorer targets list.
 * Driven by the explorer row button and the row context menu — hosts coming
 * from ~/.ssh/config cannot be forgotten here (they are not `manual`).
 */
export class RemoveManualHostAction extends Action2 {
  static readonly ID = 'remote.removeManualHost'
  constructor() {
    super({
      id: RemoveManualHostAction.ID,
      title: localize2('action.remote.removeManualHost.title', 'Forget'),
      category: CATEGORY,
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, host?: string): Promise<void> {
    if (host === undefined || host.trim() === '') return
    const explorer = accessor.get(IRemoteExplorerService)
    await explorer.removeManualHost(host)
  }
}

export class StopRemoteServerAction extends Action2 {
  static readonly ID = 'remote.stopServer'
  constructor() {
    super({
      id: StopRemoteServerAction.ID,
      title: localize2('action.remote.stopServer.title', 'Stop Remote Server'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
    const remoteStatus = accessor.get(IRemoteStatusService)
    const workspace = accessor.get(IWorkspaceService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)
    const quickInput = accessor.get(IQuickInputService)

    let authority: string | undefined = authorityArg
    if (authority === undefined) {
      const connected = (await remoteStatus.getConnections()).filter((c) => c.state === 'connected')
      if (connected.length === 0) {
        notification.notify({
          severity: Severity.Info,
          message: localize('remote.stopServer.none', 'No connected host to stop.'),
        })
        return
      }
      authority = await pickAuthority(
        quickInput,
        connected.map((c) => ({ id: c.authority, label: c.authority, authority: c.authority })),
        localize('remote.stopServer.placeholder', 'Select a host whose server to stop'),
        false,
      )
      if (!authority) return
    }

    const current = workspace.current
    if (current?.folder.scheme === REMOTE_SCHEME && current.folder.authority === authority) {
      const { confirmed } = await dialog.confirm({
        type: 'warning',
        message: localize(
          'remote.stopServer.confirmCurrent',
          "Stop the remote server on '{authority}'? This closes the current remote workspace.",
          { authority },
        ),
        primaryButton: localize('remote.stopServer.confirmButton', 'Stop Server'),
        cancelButton: localize('common.cancel', 'Cancel'),
      })
      if (!confirmed) return
      await workspace.closeFolder()
      await remoteStatus.stopServer(authority)
      return
    }

    const { confirmed } = await dialog.confirm({
      type: 'warning',
      message: localize(
        'remote.stopServer.confirm',
        "Stop the remote server on '{authority}'? The connection will be torn down.",
        { authority },
      ),
      primaryButton: localize('remote.stopServer.confirmButton', 'Stop Server'),
      cancelButton: localize('common.cancel', 'Cancel'),
    })
    if (!confirmed) return
    await remoteStatus.stopServer(authority)
  }
}
