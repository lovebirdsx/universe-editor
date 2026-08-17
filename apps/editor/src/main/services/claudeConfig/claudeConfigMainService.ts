/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Claude config service. The file-store core (settings.json +
 *  .credentials.json) lives in node-services (ClaudeConfigStore); this class adds
 *  the local/remote split and the editor-local credential library.
 *
 *  Routed by `authority`: set → the remote server's AgentConfig channel for that
 *  authority; absent → the local ClaudeConfigStore (zero behavior change). The
 *  credential library (readProfiles/writeProfiles) is always editor-local; the
 *  gateway probe runs from the effective host — the remote network when an
 *  authority is given, the local host otherwise.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
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
  writeFileAtomic,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  ClaudeAuthStatus,
  ClaudeCredentialProfile,
  ClaudeSettings,
  ClaudeSettingsPatch,
  IClaudeConfigService,
} from '../../../shared/ipc/claudeConfigService.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readAiSettingsAgentState, updateAiSettingsAgentState } from '../ai/aiSettingsAgentState.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

interface ClaudeAgentSettingsState {
  authentication?: {
    profiles?: ClaudeCredentialProfile[]
  }
}

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

  async readProfiles(): Promise<ClaudeCredentialProfile[]> {
    if (this._configLocation) {
      const state = await readAiSettingsAgentState<ClaudeAgentSettingsState>(
        this._configLocation,
        'claude',
      )
      const profiles = state?.authentication?.profiles
      if (Array.isArray(profiles)) return profiles
      const legacyProfiles = await this._readLegacyProfiles()
      if (legacyProfiles.length > 0) await this.writeProfiles(legacyProfiles)
      return legacyProfiles
    }
    return this._readLegacyProfiles()
  }

  async writeProfiles(profiles: ClaudeCredentialProfile[]): Promise<void> {
    if (this._configLocation) {
      await updateAiSettingsAgentState<ClaudeAgentSettingsState>(
        this._configLocation,
        'claude',
        (current) => ({
          ...current,
          authentication: { ...current?.authentication, profiles },
        }),
      )
      this._logger.info(`wrote ${profiles.length} Claude credential profile(s) to aiSettings.json`)
      return
    }
    const path = this._profilesPath()
    await writeFileAtomic(path, `${JSON.stringify({ profiles }, null, 2)}\n`)
    this._logger.info(`wrote ${profiles.length} credential profile(s) to ${path}`)
  }

  private async _readLegacyProfiles(): Promise<ClaudeCredentialProfile[]> {
    const path = this._profilesPath()
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(`readProfiles failed: ${(err as Error).message}`)
      }
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { profiles?: unknown }
      return Array.isArray(parsed.profiles) ? (parsed.profiles as ClaudeCredentialProfile[]) : []
    } catch {
      this._logger.warn(`credential-profiles.json is not valid JSON at ${path}`)
      return []
    }
  }

  private _profilesPath(): string {
    return join(dirname(this._settingsPath), '.universe-editor', 'credential-profiles.json')
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
