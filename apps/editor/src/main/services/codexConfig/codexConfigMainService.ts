/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Codex config service. The file-store core (config.toml + auth.json,
 *  `applyCredential`, auth watch) lives in node-services (CodexConfigStore); this
 *  class adds the local/remote split and the editor-local credential library.
 *
 *  Routed by `authority`: set → the remote server's AgentConfig channel for that
 *  authority; absent → the local CodexConfigStore (zero behavior change). The
 *  credential library (readProfiles/writeProfiles) is always editor-local;
 *  `matchActiveProfile` compares the *effective* host's credential (the authority's
 *  remote config, or the local host) against that library, and the gateway probe
 *  runs from the effective host. `onDidChangeAuth` fires on a local auth change OR
 *  a remote authority's auth change.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
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
  GATEWAY_PROVIDER_ID,
  defaultCodexConfigPath,
  probeGatewayConnectivity,
  resolveCodexAuthMode,
  writeFileAtomic,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexCredentialProfile,
  CodexSettings,
  CodexSettingsPatch,
  ICodexConfigService,
} from '../../../shared/ipc/codexConfigService.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readAiSettingsAgentState, updateAiSettingsAgentState } from '../ai/aiSettingsAgentState.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

interface CodexAgentSettingsState {
  authentication?: {
    profiles?: CodexCredentialProfile[]
  }
}

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

  async readProfiles(): Promise<CodexCredentialProfile[]> {
    if (this._configLocation) {
      const state = await readAiSettingsAgentState<CodexAgentSettingsState>(
        this._configLocation,
        'codex',
      )
      const profiles = state?.authentication?.profiles
      if (Array.isArray(profiles)) return profiles
      const legacyProfiles = await this._readLegacyProfiles()
      if (legacyProfiles.length > 0) await this.writeProfiles(legacyProfiles)
      return legacyProfiles
    }
    return this._readLegacyProfiles()
  }

  async writeProfiles(profiles: CodexCredentialProfile[]): Promise<void> {
    if (this._configLocation) {
      await updateAiSettingsAgentState<CodexAgentSettingsState>(
        this._configLocation,
        'codex',
        (current) => ({
          ...current,
          authentication: { ...current?.authentication, profiles },
        }),
      )
      this._logger.info(`wrote ${profiles.length} Codex credential profile(s) to aiSettings.json`)
      return
    }
    const path = this._profilesPath()
    await writeFileAtomic(path, `${JSON.stringify({ profiles }, null, 2)}\n`)
    this._logger.info(`wrote ${profiles.length} credential profile(s) to ${path}`)
  }

  async matchActiveProfile(authority?: string): Promise<string | undefined> {
    const profiles = await this.readProfiles()
    if (profiles.length === 0) return undefined

    // Gateway mode: the provider block carries both the URL and the key, so
    // same-URL profiles are told apart by their bearer token.
    const settings = await this.read(authority)
    if (settings['model_provider'] === GATEWAY_PROVIDER_ID) {
      const providers = settings['model_providers']
      const gw =
        providers && typeof providers === 'object'
          ? (providers as Record<string, unknown>)[GATEWAY_PROVIDER_ID]
          : undefined
      const baseUrl =
        gw && typeof gw === 'object' ? (gw as Record<string, unknown>)['base_url'] : undefined
      const token =
        gw && typeof gw === 'object'
          ? (gw as Record<string, unknown>)['experimental_bearer_token']
          : undefined
      if (typeof baseUrl !== 'string' || typeof token !== 'string' || token === '') {
        return undefined
      }
      const match = profiles.find(
        (p) => p.kind === 'gateway' && p.baseUrl === baseUrl && p.apiKey === token,
      )
      this._logger.info(`active profile match: ${match?.id ?? 'none'} (gateway ${baseUrl})`)
      return match?.id
    }

    // Built-in openai provider: an API-key profile matches only when its key is
    // the one in the effective host's auth.json; a ChatGPT login matches no
    // profile. Remote matching narrows to the editor's saved apiKey candidates and
    // only an index travels back — the remote auth.json never crosses the wire.
    if (authority) {
      const apiKeyProfiles = profiles.filter(
        (p) => p.kind === 'apiKey' && typeof p.apiKey === 'string' && p.apiKey !== '',
      )
      if (apiKeyProfiles.length === 0) return undefined
      const idx = await this._remoteService(authority).codexMatchActiveApiKey(
        apiKeyProfiles.map((p) => p.apiKey as string),
      )
      this._logger.info(
        `active profile match: ${idx >= 0 ? apiKeyProfiles[idx]?.id : 'none'} (remote apiKey)`,
      )
      return idx >= 0 ? apiKeyProfiles[idx]?.id : undefined
    }

    const auth = await this._local.readAuthRaw()
    if (!auth || resolveCodexAuthMode(auth) !== 'apiKey') return undefined
    const match = profiles.find((p) => p.kind === 'apiKey' && p.apiKey === auth['OPENAI_API_KEY'])
    this._logger.info(`active profile match: ${match?.id ?? 'none'} (apiKey)`)
    return match?.id
  }

  private async _readLegacyProfiles(): Promise<CodexCredentialProfile[]> {
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
      return Array.isArray(parsed.profiles) ? (parsed.profiles as CodexCredentialProfile[]) : []
    } catch {
      this._logger.warn(`credential-profiles.json is not valid JSON at ${path}`)
      return []
    }
  }

  private _profilesPath(): string {
    return join(dirname(this._configPath), '.universe-editor', 'credential-profiles.json')
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
