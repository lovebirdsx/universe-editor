/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DI wrapper over the shared FileSearchService (ripgrep file-name search).
 *  The engine lives in @universe-editor/node-services; this class re-adds the
 *  @ILoggerService / @IRemoteConnectionService constructor injection and routes
 *  `remote-ssh` roots to the server's fileSearch channel.
 *--------------------------------------------------------------------------------------------*/

import { FileSearchService, type FileSearchServiceOptions } from '@universe-editor/node-services'
import {
  ILoggerService,
  ProxyChannel,
  REMOTE_SCHEME,
  RemoteChannels,
  URI,
  type CancellationToken,
  type IFileSearchComplete,
  type IFileSearchQuery,
  type IFileSearchService,
  type ILoggerService as ILoggerServiceType,
  type UriComponents,
} from '@universe-editor/platform'
import { fromWire, toWire } from '../remote/remoteUri.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

function reviveUri(value: URI | UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class FileSearchMainService extends FileSearchService {
  private readonly _remoteServices = new Map<string, IFileSearchService>()

  constructor(
    @ILoggerService loggerService?: ILoggerServiceType,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
    options?: FileSearchServiceOptions,
  ) {
    super(loggerService, options)
  }

  override async search(
    query: IFileSearchQuery,
    token?: CancellationToken,
  ): Promise<IFileSearchComplete> {
    const root = reviveUri(query.root)
    if (root.scheme !== REMOTE_SCHEME) {
      return super.search(query, token)
    }
    if (!this._connections) {
      throw new Error('fileSearch: remote connection service not available')
    }
    const authority = root.authority
    const service = await this._remoteService(authority)
    const result = await service.search({ ...query, root: toWire(root) }, token)
    return {
      ...result,
      results: result.results.map((m) => ({ ...m, resource: fromWire(m.resource, authority) })),
    }
  }

  private async _remoteService(authority: string): Promise<IFileSearchService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return cached
    const conn = await this._connections!.getConnection(authority)
    const service = ProxyChannel.toService<IFileSearchService>(
      conn.getChannel(RemoteChannels.FileSearch),
    )
    conn.onDidClose(() => this._remoteServices.delete(authority))
    this._remoteServices.set(authority, service)
    return service
  }
}
