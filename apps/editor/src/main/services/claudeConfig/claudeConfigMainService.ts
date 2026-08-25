/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Claude config service. The file-store core (settings.json +
 *  .credentials.json) lives in node-services (ClaudeConfigStore); this class adds
 *  the local/remote split. `resolveActiveAuth` reverse-looks the credential
 *  actually in effect on the effective host — read from that host's own
 *  settings.json / .credentials.json — against the configured provider entries;
 *  the editor keeps no declared mirror, so there is no drift to detect.
 *
 *  Routed by `authority`: set → the remote server's AgentConfig channel for that
 *  authority; absent → the local ClaudeConfigStore (zero behavior change). The
 *  gateway probe runs from the effective host — the remote network when an
 *  authority is given, the local host otherwise. `onDidChangeConfig` covers both
 *  the local store's directory watch and every remote authority seen.
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  RemoteChannels,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import {
  ClaudeConfigStore,
  defaultClaudeSettingsPath,
  probeGatewayConnectivity,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  ClaudeSettingsPatch,
  IClaudeConfigService,
} from '../../../shared/ipc/claudeConfigService.js'
import { resolveClaudeActiveAuth } from '../../../shared/ai/agentActiveAuth.js'
import type { AgentActiveAuth } from '../../../shared/ai/agentActiveAuth.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readResolvedProviders } from '../ai/aiSettingsProviders.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export class ClaudeConfigMainService extends Disposable implements IClaudeConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _local: ClaudeConfigStore
  private readonly _settingsPath: string
  private readonly _remoteConfigSubscribed = new Set<string>()

  private readonly _onDidChangeConfig = this._register(new Emitter<void>())
  readonly onDidChangeConfig: Event<void> = this._onDidChangeConfig.event

  constructor(
    settingsPath: string = defaultClaudeSettingsPath(),
    @ILoggerService loggerService?: ILoggerService,
    private readonly _configLocation?: IConfigLocationService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._settingsPath = settingsPath
    this._logger = createNamedLogger(loggerService, { id: 'claudeConfig', name: 'Claude Config' })
    // The store's constructor starts a directory fs.watch; registering it makes
    // disposal tear the watcher down with the service.
    this._local = this._register(
      new ClaudeConfigStore({
        settingsPath: this._settingsPath,
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
      }),
    )
    this._register(this._local.onDidChangeConfig(() => this._onDidChangeConfig.fire()))
  }

  async read(authority?: string): Promise<ClaudeSettings> {
    if (authority) return this._remoteService(authority).claudeRead()
    return this._local.read()
  }

  async patch(patch: ClaudeSettingsPatch, authority?: string): Promise<void> {
    if (authority) {
      await this._remoteService(authority).claudePatch(patch)
      return
    }
    await this._local.patch(patch)
  }

  async configPath(authority?: string): Promise<string> {
    if (authority) return this._remoteService(authority).claudeConfigPath()
    return this._local.configPath()
  }

  async readAuthStatus(authority?: string): Promise<ClaudeAuthStatus> {
    if (authority) return this._remoteService(authority).claudeReadAuthStatus()
    return this._local.readAuthStatus()
  }

  async resolveActiveAuth(authority?: string): Promise<AgentActiveAuth> {
    const [settings, authStatus, providers] = await Promise.all([
      this.read(authority),
      this.readAuthStatus(authority),
      readResolvedProviders(this._configLocation),
    ])
    return resolveClaudeActiveAuth(settings, authStatus, providers)
  }

  async checkGatewayConnectivity(baseUrl: string, authority?: string): Promise<boolean> {
    const reachable = authority
      ? await this._remoteService(authority).checkGatewayConnectivity(baseUrl)
      : await probeGatewayConnectivity(baseUrl)
    const where = authority ? 'remote' : 'local'
    this._logger.info(
      `gateway probe ${baseUrl} -> ${reachable ? 'reachable' : 'unreachable'} (${where})`,
    )
    return reachable
  }

  private _remoteService(authority: string): IRemoteAgentConfigService {
    if (!this._connections) {
      throw new Error('claudeConfig: remote connection service not available')
    }
    const service = this._connections.getServiceProxy<IRemoteAgentConfigService>(
      authority,
      RemoteChannels.AgentConfig,
    )
    if (!this._remoteConfigSubscribed.has(authority)) {
      this._remoteConfigSubscribed.add(authority)
      this._register(service.onDidChangeClaudeConfig(() => this._onDidChangeConfig.fire()))
    }
    return service
  }
}
