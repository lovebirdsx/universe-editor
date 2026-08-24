/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Claude config service. The file-store core (settings.json +
 *  .credentials.json) lives in node-services (ClaudeConfigStore); this class adds
 *  the local/remote split and the editor-local agent settings (authentication /
 *  model / subagentModel with their `[1m]` toggles, stored in aiSettings.json).
 *
 *  Routed by `authority`: set → the remote server's AgentConfig channel for that
 *  authority; absent → the local ClaudeConfigStore (zero behavior change). The
 *  agent settings (readAgentSettings/writeAgentSettings) are always editor-local;
 *  the gateway probe runs from the effective host — the remote network when an
 *  authority is given, the local host otherwise.
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  Disposable,
  ILoggerService,
  RemoteChannels,
  type ILogger,
} from '@universe-editor/platform'
import {
  ClaudeConfigStore,
  defaultClaudeSettingsPath,
  probeGatewayConnectivity,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  ClaudeAgentSettings,
  ClaudeAuthStatus,
  ClaudeSettings,
  ClaudeSettingsPatch,
  IClaudeConfigService,
} from '../../../shared/ipc/claudeConfigService.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readAiSettingsAgentState, updateAiSettingsAgentState } from '../ai/aiSettingsAgentState.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export class ClaudeConfigMainService extends Disposable implements IClaudeConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _local: ClaudeConfigStore
  private readonly _settingsPath: string

  constructor(
    settingsPath: string = defaultClaudeSettingsPath(),
    @ILoggerService loggerService?: ILoggerService,
    private readonly _configLocation?: IConfigLocationService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._settingsPath = settingsPath
    this._logger = createNamedLogger(loggerService, { id: 'claudeConfig', name: 'Claude Config' })
    this._local = new ClaudeConfigStore({
      settingsPath: this._settingsPath,
      ...(loggerService !== undefined ? { logger: loggerService } : {}),
    })
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

  async readAgentSettings(): Promise<ClaudeAgentSettings> {
    if (!this._configLocation) return {}
    const state = await readAiSettingsAgentState<ClaudeAgentSettings>(
      this._configLocation,
      'claude',
    )
    return sanitizeClaudeAgentSettings(state)
  }

  async writeAgentSettings(settings: ClaudeAgentSettings): Promise<void> {
    if (!this._configLocation) return
    await updateAiSettingsAgentState<ClaudeAgentSettings>(this._configLocation, 'claude', () =>
      sanitizeClaudeAgentSettings(settings),
    )
    this._logger.info('wrote Claude agent settings to aiSettings.json')
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
    return this._connections.getServiceProxy<IRemoteAgentConfigService>(
      authority,
      RemoteChannels.AgentConfig,
    )
  }
}

/**
 * Keep only known fields, dropping any legacy shape left in aiSettings.json.
 * Writing is whole-block replace (the renderer always sends a full snapshot),
 * so this doubles as the write-side narrowing.
 */
function sanitizeClaudeAgentSettings(state: ClaudeAgentSettings | undefined): ClaudeAgentSettings {
  const out: ClaudeAgentSettings = {}
  if (typeof state?.authentication === 'string' && state.authentication !== '') {
    out.authentication = state.authentication
  }
  if (typeof state?.model === 'string' && state.model !== '') out.model = state.model
  if (typeof state?.subagentModel === 'string' && state.subagentModel !== '') {
    out.subagentModel = state.subagentModel
  }
  if (state?.model1m === true) out.model1m = true
  if (state?.subagentModel1m === true) out.subagentModel1m = true
  return out
}
