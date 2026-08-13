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
  ProxyChannel,
  REMOTE_SCHEME,
  RemoteChannels,
  URI,
  type IDisposable,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchMainComplete,
  type ITextSearchMainQuery,
  type ITextSearchMainService,
  type UriComponents,
} from '@universe-editor/platform'
import { fromWire, toWire } from '../remote/remoteUri.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

function reviveUri(value: URI | UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class TextSearchMainService extends TextSearchService {
  private readonly _authorityBySession = new Map<string, string>()
  private readonly _remoteServices = new Map<string, ITextSearchMainService>()
  private readonly _remoteSubs = new Map<string, IDisposable[]>()

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
    if (!this._connections) {
      throw new Error('textSearch: remote connection service not available')
    }
    const authority = root.authority
    const service = await this._remoteService(authority)
    this._authorityBySession.set(query.sessionId, authority)
    try {
      const complete = await service.search({ ...query, root: toWire(root) })
      return {
        ...complete,
        results: complete.results.map((m) => ({
          resource: fromWire(m.resource, authority),
          matches: m.matches,
        })),
      }
    } finally {
      this._authorityBySession.delete(query.sessionId)
    }
  }

  override async cancel(sessionId: string): Promise<void> {
    const authority = this._authorityBySession.get(sessionId)
    if (authority === undefined) {
      return super.cancel(sessionId)
    }
    const service = this._remoteServices.get(authority)
    if (!service) return
    await service.cancel(sessionId)
  }

  private async _remoteService(authority: string): Promise<ITextSearchMainService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return cached
    const conn = await this._connections!.getConnection(authority)
    const service = ProxyChannel.toService<ITextSearchMainService>(
      conn.getChannel(RemoteChannels.TextSearch),
    )
    this._remoteServices.set(authority, service)
    this._remoteSubs.set(authority, [
      service.onDidSearchProgress((e) => this._onDidSearchProgress.fire(e)),
      service.onDidSearchResults((e) =>
        this._onDidSearchResults.fire({
          sessionId: e.sessionId,
          results: e.results.map((m) => ({
            resource: fromWire(m.resource, authority),
            matches: m.matches,
          })),
        }),
      ),
    ])
    conn.onDidClose(() => this._dropRemote(authority))
    return service
  }

  private _dropRemote(authority: string): void {
    this._remoteServices.delete(authority)
    const subs = this._remoteSubs.get(authority)
    if (subs) {
      for (const s of subs) s.dispose()
      this._remoteSubs.delete(authority)
    }
  }
}

export { rgErrorMsgForDisplay, resolveRipgrepDiskPath, resolveSearchThreads }
