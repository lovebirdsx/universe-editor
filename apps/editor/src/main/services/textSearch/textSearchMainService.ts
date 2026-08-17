/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DI wrapper over the shared TextSearchService (ripgrep text search). The engine
 *  lives in @universe-editor/node-services; this class re-adds the DI constructor
 *  injection and routes `remote-ssh` roots to the server's textSearch channel,
 *  translating URIs on the incremental events and the final results so the
 *  renderer is unaware of the remote hop.
 *--------------------------------------------------------------------------------------------*/

import {
  TextSearchService,
  rgErrorMsgForDisplay,
  resolveRipgrepDiskPath,
  resolveSearchThreads,
} from '@universe-editor/node-services'
import {
  ILoggerService,
  REMOTE_SCHEME,
  RemoteChannels,
  URI,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchMainComplete,
  type ITextSearchMainQuery,
  type ITextSearchMainService,
  type UriComponents,
} from '@universe-editor/platform'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

function reviveUri(value: URI | UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class TextSearchMainService extends TextSearchService {
  private readonly _authorityBySession = new Map<string, string>()
  private readonly _remoteProgressBound = new Set<string>()

  constructor(
    @ILoggerService loggerService?: ILoggerServiceType,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super(loggerService)
  }

  override async search(query: ITextSearchMainQuery): Promise<ITextSearchMainComplete> {
    const root = reviveUri(query.root)
    if (root.scheme !== REMOTE_SCHEME) {
      return super.search(query)
    }
    const authority = root.authority
    const service = this._remoteService(authority)
    this._authorityBySession.set(query.sessionId, authority)
    try {
      // URIs travel verbatim; the server codec handles remote-ssh <-> file.
      return await service.search({ ...query, root })
    } finally {
      this._authorityBySession.delete(query.sessionId)
    }
  }

  override async cancel(sessionId: string): Promise<void> {
    const authority = this._authorityBySession.get(sessionId)
    if (authority === undefined) {
      return super.cancel(sessionId)
    }
    // Best-effort: the session dies with its connection, so a cancel racing a
    // disconnect must not surface an error (or trigger a bring-up just to cancel).
    try {
      await this._remoteService(authority).cancel(sessionId)
    } catch {
      // ignored
    }
  }

  private _remoteService(authority: string): ITextSearchMainService {
    if (!this._connections) {
      throw new Error('textSearch: remote connection service not available')
    }
    const service = this._connections.getServiceProxy<ITextSearchMainService>(
      authority,
      RemoteChannels.TextSearch,
    )
    if (!this._remoteProgressBound.has(authority)) {
      this._remoteProgressBound.add(authority)
      this._register(service.onDidSearchProgress((e) => this._onDidSearchProgress.fire(e)))
      this._register(service.onDidSearchResults((e) => this._onDidSearchResults.fire(e)))
    }
    return service
  }
}

export { rgErrorMsgForDisplay, resolveRipgrepDiskPath, resolveSearchThreads }
