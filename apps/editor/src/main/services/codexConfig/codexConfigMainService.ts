/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Codex config service. The file-store core (config.toml + auth.json,
 *  `applyCredential`, auth watch) lives in node-services (CodexConfigStore); this
 *  class adds the local/remote split, the editor-local agent settings, and
 *  `resolveActiveAuth` (drift detection between the editor's declared
 *  `authentication` and what is actually in effect on disk).
 *
 *  Routed by `authority`: set → the remote server's AgentConfig channel for that
 *  authority; absent → the local CodexConfigStore (zero behavior change). The
 *  agent settings (readAgentSettings/writeAgentSettings) are always editor-local;
 *  `resolveActiveAuth` compares the *effective* host's credential (the authority's
 *  remote config, or the local host) against the editor's declared authentication,
 *  and the gateway probe runs from the effective host. `onDidChangeAuth` fires on a
 *  local auth change OR a remote authority's auth change.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  RemoteChannels,
  resolveProviderEntries,
  type AiProviderEntry,
  type AiResolvedProvider,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import {
  CodexConfigStore,
  GATEWAY_PROVIDER_ID,
  defaultCodexConfigPath,
  probeGatewayConnectivity,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  CodexActiveAuth,
  CodexAgentSettings,
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexSettings,
  CodexSettingsPatch,
  ICodexConfigService,
} from '../../../shared/ipc/codexConfigService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../shared/ipc/claudeConfigService.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { deriveCodexGateway } from '../../../shared/ai/providerDerivation.js'
import { BUILTIN_MODEL_KNOWLEDGE } from '../../../shared/ai/catalog/modelKnowledge.js'
import { readAiSettingsAgentState, updateAiSettingsAgentState } from '../ai/aiSettingsAgentState.js'
import { readAiSettingsRoot } from '../ai/aiSettingsFile.js'
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

  async readAgentSettings(): Promise<CodexAgentSettings> {
    if (!this._configLocation) return {}
    const state = await readAiSettingsAgentState<CodexAgentSettings>(this._configLocation, 'codex')
    return sanitizeCodexAgentSettings(state)
  }

  async writeAgentSettings(settings: CodexAgentSettings): Promise<void> {
    if (!this._configLocation) return
    await updateAiSettingsAgentState<CodexAgentSettings>(this._configLocation, 'codex', (current) =>
      mergeCodexAgentSettings(current, settings),
    )
    this._logger.info('wrote Codex agent settings to aiSettings.json')
  }

  async resolveActiveAuth(authority?: string): Promise<CodexActiveAuth> {
    const [agentSettings, settings, authStatus, providers] = await Promise.all([
      this.readAgentSettings(),
      this.read(authority),
      this.readAuthStatus(authority),
      this._readResolvedProviders(),
    ])
    return computeCodexActiveAuth(agentSettings.authentication, settings, authStatus, providers)
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

  private async _readResolvedProviders(): Promise<readonly AiResolvedProvider[]> {
    if (!this._configLocation) return []
    const { dir } = await this._configLocation.getInfo()
    const root = await readAiSettingsRoot(join(dir, 'aiSettings.json'))
    const raw = root['providers']
    const entries: readonly AiProviderEntry[] = Array.isArray(raw) ? raw : []
    return resolveProviderEntries(entries, BUILTIN_MODEL_KNOWLEDGE).providers
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

/**
 * Pure drift detection. `declared` is the editor's `authentication` string
 * (provider id, `@subscription`, or absent); `kind` / `providerId` describe what
 * is actually in effect on the effective host. `drift` is true when they disagree.
 */
export function computeCodexActiveAuth(
  declared: string | undefined,
  settings: CodexSettings,
  authStatus: CodexAuthStatus,
  providers: readonly AiResolvedProvider[],
): CodexActiveAuth {
  const modelProvider = settings['model_provider']
  if (modelProvider === GATEWAY_PROVIDER_ID) {
    const block = gatewayBlock(settings)
    const baseUrl = block?.['base_url']
    const token = block?.['experimental_bearer_token']
    const providerId =
      typeof baseUrl === 'string' && typeof token === 'string' && token !== ''
        ? matchingProviderId(providers, baseUrl, token)
        : undefined
    return {
      kind: 'provider',
      ...(providerId !== undefined ? { providerId } : {}),
      drift: computeDrift(declared, 'provider', providerId),
    }
  }

  // Built-in `openai` provider: ChatGPT login only counts when `model_provider`
  // is empty (a custom provider would bypass auth.json).
  const builtinActive = typeof modelProvider !== 'string' || modelProvider === ''
  const kind = authStatus.active === 'chatgpt' && builtinActive ? 'subscription' : 'none'
  return { kind, drift: computeDrift(declared, kind, undefined) }
}

function computeDrift(
  declared: string | undefined,
  kind: 'subscription' | 'provider' | 'none',
  providerId: string | undefined,
): boolean {
  if (declared === undefined || declared === '') {
    // The editor isn't managing codex auth: only a hand-written gateway on disk
    // that the editor doesn't own is a mismatch worth surfacing.
    return kind === 'provider'
  }
  if (declared === AGENT_SUBSCRIPTION_AUTH) return kind !== 'subscription'
  return kind !== 'provider' || providerId !== declared
}

function gatewayBlock(settings: CodexSettings): Record<string, unknown> | undefined {
  const providers = settings['model_providers']
  if (!providers || typeof providers !== 'object') return undefined
  const block = (providers as Record<string, unknown>)[GATEWAY_PROVIDER_ID]
  return block && typeof block === 'object' ? (block as Record<string, unknown>) : undefined
}

function matchingProviderId(
  providers: readonly AiResolvedProvider[],
  baseUrl: string,
  token: string,
): string | undefined {
  for (const provider of providers) {
    const derived = deriveCodexGateway(provider)
    if (derived !== undefined && derived.baseUrl === baseUrl && derived.apiKey === token) {
      return provider.id
    }
  }
  return undefined
}

function sanitizeCodexAgentSettings(state: CodexAgentSettings | undefined): CodexAgentSettings {
  const out: CodexAgentSettings = {}
  if (typeof state?.authentication === 'string' && state.authentication !== '') {
    out.authentication = state.authentication
  }
  if (typeof state?.model === 'string' && state.model !== '') out.model = state.model
  return out
}

function mergeCodexAgentSettings(
  current: CodexAgentSettings | undefined,
  next: CodexAgentSettings,
): CodexAgentSettings {
  const out = sanitizeCodexAgentSettings(current)
  delete out.authentication
  delete out.model
  const nextClean = sanitizeCodexAgentSettings(next)
  if (nextClean.authentication !== undefined) out.authentication = nextClean.authentication
  if (nextClean.model !== undefined) out.model = nextClean.model
  return out
}
