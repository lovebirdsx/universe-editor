/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side API usage service. The fetch core lives in node-services
 *  (claudeUsage.ts); this class adds the local/remote split — routed by
 *  `authority`: set → the remote server's AgentConfig channel for that authority
 *  (remote settings + remote network); absent → the local settings file.
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  Disposable,
  ILoggerService,
  ProxyChannel,
  RemoteChannels,
  type ILogger,
} from '@universe-editor/platform'
import {
  defaultClaudeSettingsPath,
  fetchClaudeUsage,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type { IUsageService, UsageResult } from '../../../shared/ipc/services.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export class UsageMainService extends Disposable implements IUsageService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _settingsPath: string
  private readonly _loggerService: ILoggerService | undefined
  private readonly _remoteServices = new Map<string, IRemoteAgentConfigService>()

  constructor(
    settingsPath: string = defaultClaudeSettingsPath(),
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._settingsPath = settingsPath
    this._loggerService = loggerService
    this._logger = createNamedLogger(loggerService, { id: 'usage', name: 'Usage' })
  }

  async getUsage(authority?: string): Promise<UsageResult> {
    if (authority) {
      this._logger.debug(`usage fetch via remote authority '${authority}'`)
      try {
        return await (await this._remoteService(authority)).claudeFetchUsage()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this._logger.warn(`usage fetch failed (remote '${authority}'): ${message}`)
        return { kind: 'error', message }
      }
    }
    this._logger.debug('usage fetch via local settings')
    return fetchClaudeUsage(this._settingsPath, this._loggerService)
  }

  private async _remoteService(authority: string): Promise<IRemoteAgentConfigService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return cached
    if (!this._connections) {
      throw new Error('usage: remote connection service not available')
    }
    const conn = await this._connections.getConnection(authority)
    const service = ProxyChannel.toService<IRemoteAgentConfigService>(
      conn.getChannel(RemoteChannels.AgentConfig),
    )
    this._remoteServices.set(authority, service)
    return service
  }
}
