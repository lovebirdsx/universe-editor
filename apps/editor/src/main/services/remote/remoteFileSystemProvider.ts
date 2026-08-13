/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFileSystemProvider for the `remote-ssh` scheme. Every call resolves the
 *  connection for the resource's authority, forwards a file:-translated URI to the
 *  server's IFileService channel, and translates any URI it returns back. Caches
 *  one IFileService proxy per authority; the cache drops the entry when the
 *  connection closes so a reconnect gets a fresh proxy.
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  ProxyChannel,
  RemoteChannels,
  URI,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
  type IFileSystemProvider,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import { fromWire, toWire } from './remoteUri.js'
import type { IRemoteConnectionService } from './remoteConnectionMainService.js'

export class RemoteFileSystemProvider implements IFileSystemProvider {
  // Phase 1 simplification: case sensitivity is fixed at `true`. The real value
  // is on the handshake info (IRemoteHandshakeInfo.pathCaseSensitive) and should
  // feed the per-scheme case-sensitivity registry once remote workspaces land.
  readonly capabilities = { pathCaseSensitive: true }

  private readonly _logger: ILogger
  private readonly _services = new Map<string, IFileService>()

  constructor(
    private readonly _connections: IRemoteConnectionService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteFileSystem',
      name: 'Remote File System',
    })
  }

  private async _service(authority: string): Promise<IFileService> {
    const cached = this._services.get(authority)
    if (cached) return cached
    const conn = await this._connections.getConnection(authority)
    const service = ProxyChannel.toService<IFileService>(conn.getChannel(RemoteChannels.FileSystem))
    // The listener is owned by the connection's onDidClose emitter (disposed on
    // connection teardown); it only drops the cached proxy so the next call
    // re-resolves against the reconnected connection.
    conn.onDidClose(() => this._services.delete(authority))
    this._services.set(authority, service)
    this._logger.debug(`remote file system proxy ready authority=${authority}`)
    return service
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const svc = await this._service(resource.authority)
    return svc.readFile(toWire(resource))
  }

  async readFileText(resource: URI, encoding?: 'utf8'): Promise<string> {
    const svc = await this._service(resource.authority)
    return svc.readFileText(toWire(resource), encoding)
  }

  async writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    const svc = await this._service(resource.authority)
    return svc.writeFile(toWire(resource), content)
  }

  async exists(resource: URI): Promise<boolean> {
    const svc = await this._service(resource.authority)
    return svc.exists(toWire(resource))
  }

  async stat(resource: URI): Promise<IFileStat> {
    const svc = await this._service(resource.authority)
    const stat = await svc.stat(toWire(resource))
    return { ...stat, resource: fromWire(stat.resource, resource.authority) }
  }

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const svc = await this._service(resource.authority)
    return svc.list(toWire(resource))
  }

  async realpath(resource: URI): Promise<URI> {
    const svc = await this._service(resource.authority)
    const wire = await svc.realpath!(toWire(resource))
    return fromWire(wire, resource.authority)
  }

  async createDirectory(resource: URI): Promise<void> {
    const svc = await this._service(resource.authority)
    return svc.createDirectory(toWire(resource))
  }

  async delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const svc = await this._service(resource.authority)
    return svc.delete(toWire(resource), opts)
  }

  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const svc = await this._service(source.authority)
    return svc.rename(toWire(source), toWire(target), opts)
  }

  async copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const svc = await this._service(source.authority)
    return svc.copy(toWire(source), toWire(target), opts)
  }

  async listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<URI[]> {
    const svc = await this._service(root.authority)
    const files = await svc.listRecursive(toWire(root), options)
    return files.map((f) => fromWire(f, root.authority))
  }
}
