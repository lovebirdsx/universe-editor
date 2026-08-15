/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-scoped terminal service: routes each terminal to the host that will
 *  actually run it. The PTY lifecycle core lives in @universe-editor/node-services
 *  (PtyHostService); this thin shell adds the local/remote split.
 *
 *    - `cwd` scheme `remote-ssh` → the server's Terminal channel for that
 *      authority, with the remote id rewritten to a window-unique mapped id
 *      (`remote:<authority>:<remoteId>`) so the renderer stays scheme-agnostic.
 *    - any other cwd (or none) → the local PtyHostService.
 *
 *  Events are merged back into one `onData` / `onExit` / `onTitleChange` stream
 *  keyed by the mapped id. A permanent remote connection close fires `onExit` for
 *  every terminal that authority still held (socket drops are NOT permanent —
 *  PersistentProtocol keeps the channel alive across a reconnect, so output keeps
 *  flowing and no exit is synthesised).
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  ProxyChannel,
  REMOTE_SCHEME,
  RemoteChannels,
  URI,
  type Event,
  type IDisposable,
  type ILogger,
  type ITerminalCreatedInfo,
  type ITerminalDataEvent,
  type ITerminalExitEvent,
  type ITerminalProfile,
  type ITerminalProfilesRequest,
  type ITerminalService,
  type ITerminalSpawnSpec,
  type ITerminalTitleEvent,
  type UriComponents,
} from '@universe-editor/platform'
import { PtyHostService, type PtySpawner } from '@universe-editor/node-services'
import { processRoleRegistry } from '../process/processRoleRegistry.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

/** A remote terminal endpoint: the service plus its permanent-close signal. */
export interface IRemoteTerminalEndpoint {
  readonly service: ITerminalService
  readonly onDidClose: Event<void>
}

type RemoteTerminalFactory = (authority: string) => Promise<IRemoteTerminalEndpoint>

interface RemoteEntry {
  authority: string
  remoteId: string
}

function reviveUri(value: UriComponents | URI): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

function keyOf(authority: string, remoteId: string): string {
  return `${authority}\u0000${remoteId}`
}

export class TerminalMainService extends Disposable implements ITerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _local: PtyHostService
  private readonly _logger: ILogger
  private readonly _remoteTerminalFactory: RemoteTerminalFactory

  private readonly _remoteServices = new Map<string, ITerminalService>()
  private readonly _remotePromises = new Map<string, Promise<ITerminalService>>()
  private readonly _remoteSubs = new Map<string, IDisposable[]>()
  /** mapped id → remote identity. */
  private readonly _remoteByMappedId = new Map<string, RemoteEntry>()
  /** reverse lookup: authority\0remoteId → mapped id. */
  private readonly _remoteMappedIdByKey = new Map<string, string>()
  /** live mapped ids per authority (for connection-close cleanup). */
  private readonly _remoteIdsByAuthority = new Map<string, Set<string>>()

  private readonly _onData = this._register(new Emitter<ITerminalDataEvent>())
  readonly onData: Event<ITerminalDataEvent> = this._onData.event

  private readonly _onExit = this._register(new Emitter<ITerminalExitEvent>())
  readonly onExit: Event<ITerminalExitEvent> = this._onExit.event

  private readonly _onTitleChange = this._register(new Emitter<ITerminalTitleEvent>())
  readonly onTitleChange: Event<ITerminalTitleEvent> = this._onTitleChange.event

  constructor(
    private readonly _spawn: PtySpawner | undefined,
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
    remoteTerminalFactory?: RemoteTerminalFactory,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'terminal', name: 'Terminal' })
    this._remoteTerminalFactory =
      remoteTerminalFactory ??
      (async (authority) => {
        if (!this._connections) {
          throw new Error('terminal: remote connection service not available')
        }
        const conn = await this._connections.getConnection(authority)
        return {
          service: ProxyChannel.toService<ITerminalService>(
            conn.getChannel(RemoteChannels.Terminal),
          ),
          onDidClose: conn.onDidClose,
        }
      })

    this._local = this._register(
      new PtyHostService({
        ...(this._spawn !== undefined ? { spawn: this._spawn } : {}),
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
        onPtySpawned: (pid, label) => processRoleRegistry.register(pid, { role: 'pty', label }),
      }),
    )
    this._register(this._local.onData((e) => this._onData.fire(e)))
    this._register(this._local.onExit((e) => this._onExit.fire(e)))
    this._register(this._local.onTitleChange((e) => this._onTitleChange.fire(e)))
  }

  async create(spec: ITerminalSpawnSpec): Promise<ITerminalCreatedInfo> {
    const cwdUri = spec.cwd ? reviveUri(spec.cwd) : undefined
    if (cwdUri && cwdUri.scheme === REMOTE_SCHEME) {
      return this._createRemote(cwdUri.authority, spec)
    }
    // Local: a file URI's fsPath is the host path; absent cwd stays absent.
    const { cwd: _cwd, ...rest } = spec
    const cwdPath = cwdUri ? cwdUri.fsPath : undefined
    return this._local.create({ ...rest, ...(cwdPath !== undefined ? { cwd: cwdPath } : {}) })
  }

  async getProfiles(request: ITerminalProfilesRequest): Promise<readonly ITerminalProfile[]> {
    const folder = request.folder ? reviveUri(request.folder) : undefined
    if (folder && folder.scheme === REMOTE_SCHEME) {
      const service = await this._remoteService(folder.authority)
      return service.getProfiles(request)
    }
    return this._local.getProfiles(request)
  }

  input(id: string, data: string): Promise<void> {
    const remote = this._remoteByMappedId.get(id)
    if (remote) {
      const service = this._remoteServices.get(remote.authority)
      return service ? service.input(remote.remoteId, data) : Promise.resolve()
    }
    return this._local.input(id, data)
  }

  resize(id: string, cols: number, rows: number): Promise<void> {
    const remote = this._remoteByMappedId.get(id)
    if (remote) {
      const service = this._remoteServices.get(remote.authority)
      return service ? service.resize(remote.remoteId, cols, rows) : Promise.resolve()
    }
    return this._local.resize(id, cols, rows)
  }

  kill(id: string): Promise<void> {
    const remote = this._remoteByMappedId.get(id)
    if (remote) {
      const service = this._remoteServices.get(remote.authority)
      return service ? service.kill(remote.remoteId) : Promise.resolve()
    }
    return this._local.kill(id)
  }

  release(id: string): Promise<void> {
    const remote = this._remoteByMappedId.get(id)
    if (remote) {
      this._dropRemoteId(id)
      const service = this._remoteServices.get(remote.authority)
      return service ? service.release(remote.remoteId) : Promise.resolve()
    }
    return this._local.release(id)
  }

  async list(): Promise<readonly ITerminalCreatedInfo[]> {
    const local = await this._local.list()
    const remote: ITerminalCreatedInfo[] = []
    for (const [authority, service] of this._remoteServices) {
      for (const info of await service.list()) {
        remote.push({ ...info, id: this._mappedId(authority, info.id) })
      }
    }
    return [...local, ...remote]
  }

  override dispose(): void {
    this._remoteSubs.clear()
    this._remoteServices.clear()
    this._remotePromises.clear()
    this._remoteByMappedId.clear()
    this._remoteMappedIdByKey.clear()
    this._remoteIdsByAuthority.clear()
    super.dispose()
  }

  // ------------------------- remote plumbing -------------------------

  private async _createRemote(
    authority: string,
    spec: ITerminalSpawnSpec,
  ): Promise<ITerminalCreatedInfo> {
    const service = await this._remoteService(authority)
    const info = await service.create(spec)
    this._logger.info(
      `create remote authority=${authority} remoteId=${info.id} shell=${spec.shell ?? ''} cwd=${spec.cwd ? JSON.stringify(spec.cwd) : ''}`,
    )
    const mappedId = this._mappedId(authority, info.id)
    this._remoteByMappedId.set(mappedId, { authority, remoteId: info.id })
    this._remoteMappedIdByKey.set(keyOf(authority, info.id), mappedId)
    let set = this._remoteIdsByAuthority.get(authority)
    if (!set) {
      set = new Set()
      this._remoteIdsByAuthority.set(authority, set)
    }
    set.add(mappedId)
    return { ...info, id: mappedId }
  }

  private _remoteService(authority: string): Promise<ITerminalService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return Promise.resolve(cached)
    const inflight = this._remotePromises.get(authority)
    if (inflight) return inflight
    const promise = this._connectRemote(authority).finally(() => {
      if (this._remotePromises.get(authority) === promise) this._remotePromises.delete(authority)
    })
    this._remotePromises.set(authority, promise)
    return promise
  }

  private async _connectRemote(authority: string): Promise<ITerminalService> {
    const endpoint = await this._remoteTerminalFactory(authority)
    const service = endpoint.service
    const subs: IDisposable[] = [
      service.onData((e) => {
        const mappedId = this._remoteMappedIdByKey.get(keyOf(authority, e.id))
        if (mappedId) this._onData.fire({ id: mappedId, data: e.data })
      }),
      service.onExit((e) => {
        const mappedId = this._remoteMappedIdByKey.get(keyOf(authority, e.id))
        if (!mappedId) return
        this._dropRemoteId(mappedId)
        this._onExit.fire({
          id: mappedId,
          exitCode: e.exitCode,
          ...(e.signal != null ? { signal: e.signal } : {}),
        })
      }),
      service.onTitleChange((e) => {
        const mappedId = this._remoteMappedIdByKey.get(keyOf(authority, e.id))
        if (mappedId) this._onTitleChange.fire({ id: mappedId, title: e.title })
      }),
      endpoint.onDidClose(() => this._onRemoteClosed(authority)),
    ]
    if (this._store.isDisposed) {
      for (const s of subs) s.dispose()
      throw new Error('terminal: service disposed while connecting')
    }
    for (const s of subs) this._register(s)
    this._remoteServices.set(authority, service)
    this._remoteSubs.set(authority, subs)
    return service
  }

  private _mappedId(authority: string, remoteId: string): string {
    return (
      this._remoteMappedIdByKey.get(keyOf(authority, remoteId)) ?? `remote:${authority}:${remoteId}`
    )
  }

  private _dropRemoteId(mappedId: string): void {
    const entry = this._remoteByMappedId.get(mappedId)
    if (!entry) return
    this._remoteByMappedId.delete(mappedId)
    this._remoteMappedIdByKey.delete(keyOf(entry.authority, entry.remoteId))
    const set = this._remoteIdsByAuthority.get(entry.authority)
    set?.delete(mappedId)
    if (set && set.size === 0) this._remoteIdsByAuthority.delete(entry.authority)
  }

  private _onRemoteClosed(authority: string): void {
    const subs = this._remoteSubs.get(authority)
    if (subs) {
      for (const s of subs) this._store.delete(s)
      this._remoteSubs.delete(authority)
    }
    this._remoteServices.delete(authority)
    const ids = [...(this._remoteIdsByAuthority.get(authority) ?? [])]
    this._logger.info(
      `remote connection closed authority=${authority} synthesizing exit for ${ids.length} terminal(s)`,
    )
    for (const mappedId of ids) {
      this._dropRemoteId(mappedId)
      this._onExit.fire({ id: mappedId, exitCode: 0 })
    }
  }
}
