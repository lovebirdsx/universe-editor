/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteExplorerService — data aggregation for the Remote Explorer sidebar view.
 *  Thin: it only folds the remote-status facade (listSshHosts + getConnections +
 *  onDidChangeState) and GLOBAL storage (manually-added SSH hosts) into observables
 *  the view renders. All connection actions still go through the existing command /
 *  service surface — this service owns no connection logic.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  StorageScope,
  createDecorator,
  isValidWslDistroName,
  observableValue,
  type IObservable,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type RemoteConnectionStatusDto,
  type WslDistroDto,
} from '../../../shared/ipc/remoteStatusService.js'

const MANUAL_HOSTS_STORAGE_KEY = 'remote.manualSshHosts'

export interface RemoteSshTarget {
  readonly host: string
  /** True for hosts the user added by hand ("+ Add New"); false for ~/.ssh/config. */
  readonly manual: boolean
}

export interface IRemoteExplorerService {
  readonly _serviceBrand: undefined
  readonly sshTargets: IObservable<readonly RemoteSshTarget[]>
  readonly wslDistros: IObservable<readonly WslDistroDto[]>
  readonly connections: IObservable<readonly RemoteConnectionStatusDto[]>
  refresh(): Promise<void>
  addManualHost(host: string): Promise<void>
  removeManualHost(host: string): Promise<void>
}

export const IRemoteExplorerService =
  createDecorator<IRemoteExplorerService>('remoteExplorerService')

export class RemoteExplorerService extends Disposable implements IRemoteExplorerService {
  declare readonly _serviceBrand: undefined

  readonly sshTargets = observableValue<readonly RemoteSshTarget[]>(
    'RemoteExplorerService.sshTargets',
    [],
  )
  readonly wslDistros = observableValue<readonly WslDistroDto[]>(
    'RemoteExplorerService.wslDistros',
    [],
  )
  readonly connections = observableValue<readonly RemoteConnectionStatusDto[]>(
    'RemoteExplorerService.connections',
    [],
  )

  private readonly _connections = new Map<string, RemoteConnectionStatusDto>()
  private readonly _configHosts = new Set<string>()
  private readonly _manualHosts = new Set<string>()

  constructor(
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @IStorageService private readonly _storage: IStorageService,
  ) {
    super()
    this._register(
      this._remoteStatus.onDidChangeState((status) => {
        this._connections.set(status.authority, status)
        this._publishConnections()
      }),
    )
  }

  async refresh(): Promise<void> {
    const [hosts, connections, manualHosts, wslDistros] = await Promise.all([
      this._remoteStatus.listSshHosts(),
      this._remoteStatus.getConnections(),
      this._storage.get<string[]>(MANUAL_HOSTS_STORAGE_KEY, StorageScope.GLOBAL),
      this._remoteStatus.listWslDistros().catch((): readonly WslDistroDto[] => []),
    ])
    this._configHosts.clear()
    for (const host of hosts) this._configHosts.add(host)
    this._manualHosts.clear()
    for (const host of manualHosts ?? []) {
      if (typeof host === 'string' && host.trim() !== '') this._manualHosts.add(host.trim())
    }
    this._connections.clear()
    for (const c of connections) this._connections.set(c.authority, c)
    this.wslDistros.set(
      wslDistros.filter((d) => isValidWslDistroName(d.name)),
      undefined,
    )
    this._publishConnections()
    this._publishTargets()
  }

  async addManualHost(host: string): Promise<void> {
    const trimmed = host.trim()
    if (trimmed === '') return
    this._manualHosts.add(trimmed)
    await this._persistManualHosts()
    this._publishTargets()
  }

  async removeManualHost(host: string): Promise<void> {
    this._manualHosts.delete(host)
    await this._persistManualHosts()
    this._publishTargets()
  }

  private async _persistManualHosts(): Promise<void> {
    await this._storage.set(MANUAL_HOSTS_STORAGE_KEY, [...this._manualHosts], StorageScope.GLOBAL)
  }

  private _publishConnections(): void {
    this.connections.set([...this._connections.values()], undefined)
  }

  private _publishTargets(): void {
    const targets: RemoteSshTarget[] = [...this._configHosts]
      .sort((a, b) => a.localeCompare(b))
      .map((host) => ({ host, manual: false }))
    for (const host of [...this._manualHosts].sort((a, b) => a.localeCompare(b))) {
      if (this._configHosts.has(host)) continue
      targets.push({ host, manual: true })
    }
    this.sshTargets.set(targets, undefined)
  }
}
