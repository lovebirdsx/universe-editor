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
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

function reviveUri(value: URI | UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class FileSearchMainService extends FileSearchService {
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
    const authority = root.authority
    // URIs travel verbatim: the server codec translates remote-ssh -> file on the
    // way in and file -> remote-ssh (revived into real URI instances) on the way out.
    return this._remoteService(authority).search({ ...query, root }, token)
  }

  private _remoteService(authority: string): IFileSearchService {
    if (!this._connections) {
      throw new Error('fileSearch: remote connection service not available')
    }
    return this._connections.getServiceProxy<IFileSearchService>(
      authority,
      RemoteChannels.FileSearch,
    )
  }
}
