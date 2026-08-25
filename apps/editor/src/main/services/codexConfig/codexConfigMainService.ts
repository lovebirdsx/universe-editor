/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Codex config service. The file-store core (config.toml + auth.json,
 *  `applyCredential`, auth watch) lives in node-services (CodexConfigStore); this
 *  class adds the local/remote split. `resolveActiveAuth` reverse-looks the
 *  credential actually in effect on the effective host — read from that host's
 *  own config.toml / auth.json — against the configured provider entries; the
 *  editor keeps no declared mirror, so there is no drift to detect.
 *
 *  Routed by `authority`: set → the remote server's AgentConfig channel for that
 *  authority; absent → the local CodexConfigStore (zero behavior change). The
 *  gateway probe runs from the effective host — the remote network when an
 *  authority is given, the local host otherwise. `onDidChangeAuth` fires on a
 *  local auth change OR a remote authority's auth change.
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
  CodexConfigStore,
  defaultCodexConfigPath,
  probeGatewayConnectivity,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexSettings,
  CodexSettingsPatch,
  ICodexConfigService,
} from '../../../shared/ipc/codexConfigService.js'
import { resolveCodexActiveAuth } from '../../../shared/ai/agentActiveAuth.js'
import type { AgentActiveAuth } from '../../../shared/ai/agentActiveAuth.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readResolvedProviders } from '../ai/aiSettingsProviders.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export class CodexConfigMainService extends Disposable implements ICodexConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _local: CodexConfigStore
  private readonly _configPath: string
  private readonly _remoteAuthSubscribed = new Set<string>()

  private readonly _onDidChangeAuth = this._register(new Emitter<void>())
  readonly onDidChangeAuth: Event<void> = this._onDidChangeAuth.event

  constructor(
    configPath: string = defaultCodexConfigPath(),
    @ILoggerService loggerService?: ILoggerService,
    private readonly _configLocation?: IConfigLocationService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._configPath = configPath
    this._logger = createNamedLogger(loggerService, { id: 'codexConfig', name: 'Codex Config' })
    this._local = this._register(
      new CodexConfigStore({
        configPath: this._configPath,
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
      }),
    )
    this._register(this._local.onDidChangeAuth(() => this._onDidChangeAuth.fire()))
  }

  async read(authority?: string): Promise<CodexSettings> {
    if (authority) return this._remoteService(authority).codexRead()
    return this._local.read()
  }

  async patch(patch: CodexSettingsPatch, authority?: string): Promise<void> {
    if (authority) {
      await this._remoteService(authority).codexPatch(patch)
      return
    }
    await this._local.patch(patch)
  }

  async applyCredential(
    intent: CodexCredentialIntent,
    authority?: string,
  ): Promise<CodexAuthStatus> {
    if (authority) return this._remoteService(authority).codexApplyCredential(intent)
    return this._local.applyCredential(intent)
  }

  async configPath(authority?: string): Promise<string> {
    if (authority) return this._remoteService(authority).codexConfigPath()
    return this._local.configPath()
  }

  async readAuthStatus(authority?: string): Promise<CodexAuthStatus> {
    if (authority) return this._remoteService(authority).codexReadAuthStatus()
    return this._local.readAuthStatus()
  }

  async resolveActiveAuth(authority?: string): Promise<AgentActiveAuth> {
    const [settings, authStatus, providers] = await Promise.all([
      this.read(authority),
      this.readAuthStatus(authority),
      readResolvedProviders(this._configLocation),
    ])
    return resolveCodexActiveAuth(settings, authStatus, providers)
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
      throw new Error('codexConfig: remote connection service not available')
    }
    const service = this._connections.getServiceProxy<IRemoteAgentConfigService>(
      authority,
      RemoteChannels.AgentConfig,
    )
    if (!this._remoteAuthSubscribed.has(authority)) {
      this._remoteAuthSubscribed.add(authority)
      this._register(service.onDidChangeCodexAuth(() => this._onDidChangeAuth.fire()))
    }
    return service
  }
}
