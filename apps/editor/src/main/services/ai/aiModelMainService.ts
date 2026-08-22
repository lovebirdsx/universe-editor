/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process AI model facade: reads provider instances + types from
 *  <configDir>/aiSettings.json, resolves them into runtime providers (apiKey
 *  inline, by user decision), feeds them to the registry, schedules requests, and
 *  pumps each provider stream into requestId-keyed chunk events. Per-model
 *  configuration (schema default → user settings → per-request options) is resolved
 *  here and handed to the provider. Remote rate/usage sources are coordinated here
 *  (off the hot path) and exposed to the renderer as a synchronous mirror.
 *--------------------------------------------------------------------------------------------*/

import { type FSWatcher, watch as fsWatch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  AiError,
  AiErrorCode,
  AiModelRegistry,
  AiRemoteSourceRegistry,
  type CancellationToken,
  CancellationTokenSource,
  createNamedLogger,
  Disposable,
  Emitter,
  type Event,
  type ILogger,
  ILoggerService,
  isCancellationError,
  localize,
  parseModelRef,
  providerKey,
  resolveProviderInstances,
  transformErrorForSerialization,
  type AiAccountUsage,
  type AiActiveModelKind,
  type AiActiveModels,
  type AiCustomModelConfig,
  type AiMessage,
  type AiMessagePart,
  type AiModelConfiguration,
  type AiModelConfigSchema,
  type AiModelMetadata,
  type AiModelSelector,
  type AiProviderInstance,
  type AiProviderType,
  type AiProviderTypeDescriptor,
  type AiProviderVerifyInput,
  type AiProviderVerifyResult,
  type AiRateTableSnapshot,
  type AiRemoteSourceSpec,
  type AiRequestOptions,
  type AiResolvedProvider,
  type AiResponse,
} from '@universe-editor/platform'
import { type ParseError, parse } from 'jsonc-parser'
import { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import type {
  AiActiveModelChangeEvent,
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'
import { BUILTIN_PROVIDER_TYPES } from '../../../shared/ai/catalog/index.js'
import { resolveModelPricing } from '../../../shared/ai/resolveModelPricing.js'
import { IMainStorageService, type Storage } from '../../storage.js'
import { OllamaProvider } from './providers/ollamaProvider.js'
import { OpenAiChatProvider } from './providers/openAiChatProvider.js'
import { AnthropicMessagesProvider } from './providers/anthropicMessagesProvider.js'
import { OpenAiResponsesProvider } from './providers/openAiResponsesProvider.js'
import { HttpJsonPricingSource } from './remote/httpJsonPricingSource.js'
import { HttpJsonUsageSource } from './remote/httpJsonUsageSource.js'
import { AiRemoteCache } from './remote/remoteCache.js'
import { AiRemoteCoordinator } from './remote/remoteCoordinator.js'
import { AiDebugRecorder, IAiDebugRecorderService } from './aiDebugRecorder.js'
import { mutateAiSettingsFile, writeAiSettingsFile } from './aiSettingsFile.js'

const AI_SETTINGS_FILE = 'aiSettings.json'
const SECRET_STORAGE_KEY = 'secrets'

/**
 * Upper bound for one-shot metadata calls (model enumeration, token counting,
 * model selection). Without it, a provider whose endpoint never responds (e.g. a
 * misconfigured baseUrl) keeps its fetch — and the cancellation listener / abort
 * store it registers — pending forever, surfacing as a leak on process exit.
 */
const METADATA_REQUEST_TIMEOUT_MS = 10_000

/** Minimal slice of Electron's safeStorage so tests can stub decryption. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  decryptString(ciphertext: Buffer): string
}

/** Mutable working copy of an instance, used when editing the persisted file. */
interface MutableInstance {
  name: string
  type: string
  label?: string
  baseUrl?: string
  apiKey?: string
  usageSource?: AiRemoteSourceSpec
  models?: readonly AiCustomModelConfig[]
  settings?: Record<string, AiModelConfiguration>
}

/** Typed + raw shape of a parsed aiSettings.json (raw kept for migration). */
interface ParsedSettings {
  providers: AiProviderInstance[]
  providerTypes: Record<string, AiProviderType>
  activeModels: AiActiveModels
  file: Record<string, unknown>
}

/** Fields `_writeSettings` should change; absent fields preserve what is on disk. */
interface SettingsWrite {
  readonly providers?: readonly AiProviderInstance[]
  readonly providerTypes?: Readonly<Record<string, AiProviderType>>
  readonly activeModels?: AiActiveModels
  readonly agentSettings?: Record<string, unknown>
}

export class AiModelMainService extends Disposable implements IAiModelMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _registry = this._register(new AiModelRegistry())
  private readonly _configLocation: IConfigLocationService

  private readonly _remoteRegistry = new AiRemoteSourceRegistry()
  private readonly _remoteCache: AiRemoteCache
  private readonly _remoteCoordinator: AiRemoteCoordinator
  readonly onDidChangeRemote: Event<void>

  private readonly _onDidEmitChunk = this._register(new Emitter<AiChunkEvent>())
  readonly onDidEmitChunk = this._onDidEmitChunk.event

  private readonly _onDidEndRequest = this._register(new Emitter<AiEndEvent>())
  readonly onDidEndRequest = this._onDidEndRequest.event

  readonly onDidChangeModels = this._registry.onDidChangeModels

  private readonly _onDidChangeActiveModel = this._register(new Emitter<AiActiveModelChangeEvent>())
  readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event

  private readonly _inflight = new Map<string, CancellationTokenSource>()
  private _providers: readonly AiProviderInstance[] = []
  private _userTypes: Readonly<Record<string, AiProviderType>> = {}
  private _activeModels: AiActiveModels = {}
  private readonly _ready: Promise<void>

  private _watcher: FSWatcher | undefined
  private _watchedDir: string | undefined
  private _reloadTimer: ReturnType<typeof setTimeout> | undefined
  private _suppressUntil = 0

  constructor(
    @IConfigLocationService configLocation: IConfigLocationService,
    @ILoggerService loggerService?: ILoggerService,
    @IAiDebugRecorderService private readonly _recorder?: AiDebugRecorder,
    @IMainStorageService private readonly _storage?: Storage,
    private readonly _safeStorage: SafeStorageLike = safeStorage,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'aiModel', name: 'AI Model' })
    this._configLocation = configLocation
    this._remoteCache = new AiRemoteCache(
      async () => (await this._configLocation.getInfo()).dir,
      this._logger,
    )
    this._remoteCoordinator = this._register(
      new AiRemoteCoordinator({
        registry: this._remoteRegistry,
        cache: this._remoteCache,
        logger: this._logger,
      }),
    )
    this.onDidChangeRemote = this._remoteCoordinator.onDidChange

    this._registerBuiltInProviders()
    this._registerBuiltInRemoteSources()
    this._register(configLocation.onDidChangeConfigDir(() => void this._reload()))
    this._ready = this._reload()
  }

  private _registerBuiltInProviders(): void {
    this._register(this._registry.registerProvider('ollama', new OllamaProvider()))
    this._register(this._registry.registerProvider('openai-chat', new OpenAiChatProvider()))
    this._register(
      this._registry.registerProvider('anthropic-messages', new AnthropicMessagesProvider()),
    )
    this._register(
      this._registry.registerProvider('openai-responses', new OpenAiResponsesProvider()),
    )
  }

  private _registerBuiltInRemoteSources(): void {
    this._register(
      this._remoteRegistry.registerPricingSource(new HttpJsonPricingSource(this._logger)),
    )
    this._register(this._remoteRegistry.registerUsageSource(new HttpJsonUsageSource(this._logger)))
  }

  /**
   * Built-in types merged under the user-defined layer. A user entry with the
   * same id replaces the built-in entry wholesale (no field-level merge) — simple
   * and predictable.
   */
  private _mergedTypes(): Readonly<Record<string, AiProviderType>> {
    return { ...BUILTIN_PROVIDER_TYPES, ...this._userTypes }
  }

  async getModels(): Promise<readonly AiModelMetadata[]> {
    await this._ready
    return this._withTimeoutToken(async (token) => {
      const models = await this._registry.getModels(token)
      return this._withGatewayPricing(models)
    })
  }

  async selectModels(selector: AiModelSelector): Promise<readonly string[]> {
    await this._ready
    return this._withTimeoutToken((token) => this._registry.selectModels(selector, token))
  }

  async computeTokenLength(modelId: string, text: string): Promise<number> {
    await this._ready
    return this._withTimeoutToken(async (token) => {
      const resolved = await this._registry.resolveModel(modelId, token)
      if (!resolved) throw missingProviderError(modelId)
      return resolved.provider.provideTokenCount(modelId, text, resolved.resolved, token)
    })
  }

  async getModelConfiguration(modelId: string): Promise<AiModelConfiguration> {
    await this._ready
    const ref = parseModelRef(modelId)
    const instance = ref
      ? this._providers.find((p) => p.type === ref.type && p.name === ref.instance)
      : undefined
    const userSettings = instance?.settings?.[modelId] ?? {}
    const schema = await this._schemaFor(modelId)
    return mergeModelConfig(schema, userSettings)
  }

  async setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void> {
    await this._ready
    const ref = parseModelRef(modelId)
    if (!ref) return
    const schema = await this._schemaFor(modelId)
    const cleaned = dropDefaults(config, schema)

    const providers = this._providers.map(cloneInstance)
    let idx = providers.findIndex((p) => p.type === ref.type && p.name === ref.instance)
    if (idx === -1) {
      providers.push({ name: ref.instance, type: ref.type })
      idx = providers.length - 1
    }
    const instance = providers[idx]!
    const settings: Record<string, AiModelConfiguration> = { ...(instance.settings ?? {}) }
    if (Object.keys(cleaned).length === 0) delete settings[modelId]
    else settings[modelId] = cleaned
    if (Object.keys(settings).length === 0) delete instance.settings
    else instance.settings = settings

    await this._writeSettings({ providers })
    await this._reload()
  }

  async getProviders(): Promise<readonly AiProviderInstance[]> {
    await this._ready
    return this._providers
  }

  async updateProviders(providers: readonly AiProviderInstance[]): Promise<void> {
    await this._ready
    await this._writeSettings({ providers })
    await this._reload()
  }

  async getProviderTypes(): Promise<Readonly<Record<string, AiProviderType>>> {
    await this._ready
    return this._mergedTypes()
  }

  async updateProviderTypes(types: Readonly<Record<string, AiProviderType>>): Promise<void> {
    await this._ready
    // Keep the persisted layer minimal: a type identical to its built-in stays
    // builtin (not written), everything else lands in `providerTypes`.
    const userLayer: Record<string, AiProviderType> = {}
    for (const [id, type] of Object.entries(types)) {
      const builtin = BUILTIN_PROVIDER_TYPES[id]
      if (builtin !== undefined && JSON.stringify(builtin) === JSON.stringify(type)) continue
      userLayer[id] = type
    }
    await this._writeSettings({ providerTypes: userLayer })
    await this._reload()
  }

  async getProviderTypeDescriptors(): Promise<readonly AiProviderTypeDescriptor[]> {
    await this._ready
    const merged = this._mergedTypes()
    return Object.entries(merged).map(([id, type]) => ({
      id,
      label: type.label ?? id,
      protocol: type.protocol,
      ...(type.defaultBaseUrl !== undefined ? { defaultBaseUrl: type.defaultBaseUrl } : {}),
      requiresApiKey: type.requiresApiKey ?? false,
      builtin: !(id in this._userTypes),
    }))
  }

  async verifyProvider(input: AiProviderVerifyInput): Promise<AiProviderVerifyResult> {
    await this._ready
    const provider = this._registry.getProvider(input.protocol)
    if (!provider) {
      return {
        ok: false,
        modelCount: 0,
        error: localize('ai.verify.noProvider', "No provider registered for '{protocol}'.", {
          protocol: input.protocol,
        }),
      }
    }
    // A throwaway resolved provider: the probed key is read from the input only
    // and never written to aiSettings.json.
    const resolved: AiResolvedProvider = {
      type: input.type,
      name: input.name,
      protocol: input.protocol,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    }
    try {
      const models = await this._withTimeoutToken((token) =>
        provider.provideModels(resolved, token),
      )
      if (models.length === 0) {
        return {
          ok: false,
          modelCount: 0,
          error: localize(
            'ai.verify.noModels',
            'The endpoint responded but no models are available.',
          ),
        }
      }
      return { ok: true, modelCount: models.length }
    } catch (err) {
      return { ok: false, modelCount: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async setApiKey(typeId: string, instanceName: string, key: string): Promise<void> {
    await this._ready
    const providers = this._providers.map(cloneInstance)
    let idx = providers.findIndex((p) => p.type === typeId && p.name === instanceName)
    if (idx === -1) {
      providers.push({ name: instanceName, type: typeId })
      idx = providers.length - 1
    }
    providers[idx]!.apiKey = key
    await this._writeSettings({ providers })
    await this._reload()
  }

  async deleteApiKey(typeId: string, instanceName: string): Promise<void> {
    await this._ready
    const idx = this._providers.findIndex((p) => p.type === typeId && p.name === instanceName)
    if (idx === -1 || this._providers[idx]!.apiKey === undefined) return
    const providers = this._providers.map(cloneInstance)
    delete providers[idx]!.apiKey
    await this._writeSettings({ providers })
    await this._reload()
  }

  async hasApiKey(typeId: string, instanceName: string): Promise<boolean> {
    await this._ready
    return this._providers.some(
      (p) => p.type === typeId && p.name === instanceName && p.apiKey !== undefined,
    )
  }

  async getRateTables(): Promise<readonly AiRateTableSnapshot[]> {
    await this._ready
    return this._remoteCoordinator.allRateSnapshots()
  }

  async getAccountUsage(providerKey: string): Promise<AiAccountUsage | undefined> {
    await this._ready
    return this._remoteCoordinator.getUsage(providerKey)
  }

  async refreshRemote(providerKey?: string): Promise<void> {
    await this._ready
    await this._remoteCoordinator.refresh(providerKey)
  }

  async startRequest(
    requestId: string,
    messages: readonly AiMessageDto[],
    options: AiRequestOptions,
  ): Promise<void> {
    await this._ready
    const cts = new CancellationTokenSource()
    this._inflight.set(requestId, cts)
    const domainMessages = messages.map(reviveMessage)
    this._recorder?.begin(requestId, domainMessages, options)

    try {
      const resolved = await this._registry.resolveModel(options.modelId, cts.token)
      if (!resolved) {
        this._endRequestWithError(requestId, missingProviderError(options.modelId))
        this._disposeInflight(requestId)
        return
      }

      const modelConfiguration = await this.getModelConfiguration(options.modelId)
      const merged: AiRequestOptions = { ...options, modelConfiguration }
      this._pumpResponse(
        requestId,
        resolved.provider.sendRequest(domainMessages, merged, resolved.resolved, cts.token),
      )
    } catch (err) {
      this._endRequestWithError(requestId, err)
      this._disposeInflight(requestId)
    }
  }

  async cancelRequest(requestId: string): Promise<void> {
    this._inflight.get(requestId)?.cancel()
  }

  async getActiveModel(kind: AiActiveModelKind): Promise<string | undefined> {
    await this._ready
    return this._activeModels[kind]
  }

  async setActiveModel(kind: AiActiveModelKind, modelId: string | undefined): Promise<void> {
    await this._ready
    const next: {
      chat?: string
      inlineCompletion?: string
      commit?: string
      sessionTitle?: string
    } = {
      ...this._activeModels,
    }
    if (modelId === undefined) delete next[kind]
    else next[kind] = modelId
    this._activeModels = next
    await this._writeSettings({ activeModels: next })
    this._onDidChangeActiveModel.fire({ kind })
  }

  private async _schemaFor(modelId: string): Promise<AiModelConfigSchema | undefined> {
    const models = await this._withTimeoutToken((token) => this._registry.getModels(token))
    return models.find((m) => m.id === modelId)?.configurationSchema
  }

  private async _reload(): Promise<void> {
    const { dir } = await this._configLocation.getInfo()
    this._setupWatcher(dir)
    const path = join(dir, AI_SETTINGS_FILE)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      text = ''
    }
    const parsed = parseSettings(text)
    await this._migrateOnce(parsed, path)
    this._userTypes = parsed.providerTypes
    this._providers = parsed.providers
    this._activeModels = parsed.activeModels
    const resolved = resolveProviderInstances(this._providers, this._mergedTypes())
    this._registry.setProviders(resolved)
    this._remoteCoordinator.setProviders(resolved)
  }

  private async _writeSettings(write: SettingsWrite): Promise<void> {
    const { dir } = await this._configLocation.getInfo()
    const path = join(dir, AI_SETTINGS_FILE)
    this._suppressUntil = Date.now() + 500
    // Credential libraries and agent-authentication forms share this file; the
    // read-modify-write below is serialized with them by aiSettingsFile.
    await mutateAiSettingsFile(
      path,
      (root) => {
        if (write.providers !== undefined) root['providers'] = write.providers
        if (write.providerTypes !== undefined) {
          if (Object.keys(write.providerTypes).length > 0)
            root['providerTypes'] = write.providerTypes
          else delete root['providerTypes']
        }
        if (write.activeModels !== undefined) {
          if (hasAnyActive(write.activeModels)) root['activeModels'] = write.activeModels
          else delete root['activeModels']
        }
        if (write.agentSettings !== undefined) root['agentSettings'] = write.agentSettings
      },
      (error) => {
        this._logger.warn(`ai settings: chmod 0600 failed: ${error.message}`)
      },
    )
  }

  private async _writeFile(path: string, file: Record<string, unknown>): Promise<void> {
    await writeAiSettingsFile(path, file, (error) => {
      this._logger.warn(`ai settings: chmod 0600 failed: ${error.message}`)
    })
  }

  /**
   * Idempotent one-time migration of legacy aiSettings.json / secret-storage
   * shapes. Detects old shapes by their structure (presence of `groups`, gateway
   * profiles without `providerRef`, leftover `ai.secret.*` keys) — never by a
   * version marker. Rewrites the file once when anything changed.
   */
  private async _migrateOnce(parsed: ParsedSettings, path: string): Promise<void> {
    let migrated = false

    if (Array.isArray(parsed.file['groups'])) {
      const { providers, providerTypes } = migrateLegacyGroups(parsed.file['groups'])
      if (providers.length > 0) {
        parsed.providers.push(...providers)
        for (const [id, type] of Object.entries(providerTypes)) parsed.providerTypes[id] = type
        this._logger.info(`ai migration: migrated ${providers.length} legacy provider group(s)`)
      }
      delete parsed.file['groups']
      migrated = true
    }

    // Phase 1: decrypt secrets and fill providers in memory only. The persisted
    // cleanup of ai.secret.* is deferred until the rewritten file is durably on
    // disk (below), so a failed write never destroys the plaintext before it is
    // saved and the migration can be retried on the next start.
    const cleanedSecrets = await this._migrateSecrets(parsed.providers)
    if (cleanedSecrets !== undefined) migrated = true
    if (this._migrateGatewayProfiles(parsed.file, parsed.providers)) migrated = true

    if (!migrated) return

    parsed.file['providers'] = parsed.providers
    if (Object.keys(parsed.providerTypes).length > 0)
      parsed.file['providerTypes'] = parsed.providerTypes
    else delete parsed.file['providerTypes']
    await this._writeFile(path, parsed.file)

    // Phase 2: only now that the plaintext apiKeys are on disk, drop the
    // ai.secret.* keys from storage. If this final cleanup fails the keys are
    // simply re-migrated (idempotently) on the next start.
    if (cleanedSecrets !== undefined && this._storage !== undefined) {
      await this._storage.set(SECRET_STORAGE_KEY, cleanedSecrets)
    }
  }

  private async _migrateSecrets(
    providers: AiProviderInstance[],
  ): Promise<Record<string, string> | undefined> {
    if (this._storage === undefined) return undefined
    let map: Record<string, string> | undefined
    try {
      map = await this._storage.get<Record<string, string>>(SECRET_STORAGE_KEY)
    } catch {
      return undefined
    }
    if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined
    // Build the post-cleanup map without mutating the value `storage.get` handed
    // us (which may be a live reference), so the deferred `storage.set` below is
    // the only thing that actually removes a key.
    const next: Record<string, string> = {}
    let removed = false
    for (const [key, encoded] of Object.entries(map)) {
      const ref = parseSecretKey(key)
      if (ref === undefined) {
        next[key] = encoded
        continue
      }
      if (typeof encoded !== 'string') {
        next[key] = encoded
        continue
      }
      let plaintext: string
      try {
        if (!this._safeStorage.isEncryptionAvailable()) {
          this._logger.warn(`ai migration: skipped secret '${key}' — OS encryption unavailable`)
          next[key] = encoded
          continue
        }
        plaintext = this._safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      } catch {
        this._logger.warn(`ai migration: failed to decrypt secret '${key}' — left in place`)
        next[key] = encoded
        continue
      }
      const idx = providers.findIndex((p) => p.type === ref.type && p.name === ref.name)
      if (idx === -1) {
        this._logger.warn(
          `ai migration: no instance ${ref.type}/${ref.name} for secret — left in place`,
        )
        next[key] = encoded
        continue
      }
      providers[idx] = { ...providers[idx]!, apiKey: plaintext }
      removed = true
      this._logger.info(`ai migration: migrated secret → ${ref.type}/${ref.name} apiKey`)
    }
    return removed ? next : undefined
  }

  private _migrateGatewayProfiles(
    file: Record<string, unknown>,
    providers: AiProviderInstance[],
  ): boolean {
    const agents = asRecord(file['agentSettings'])
    if (agents === undefined) return false
    let migrated = false
    for (const [agentId, typeId] of [
      ['claude', 'anthropic'],
      ['codex', 'openai'],
    ] as const) {
      const agent = asRecord(agents[agentId])
      if (agent === undefined) continue
      const auth = asRecord(agent['authentication'])
      if (auth === undefined) continue
      if (!Array.isArray(auth['profiles'])) continue
      const next: unknown[] = []
      let changed = false
      for (const raw of auth['profiles'] as readonly unknown[]) {
        const profile = asRecord(raw)
        if (
          profile === undefined ||
          profile['kind'] !== 'gateway' ||
          profile['providerRef'] !== undefined
        ) {
          next.push(raw)
          continue
        }
        const result = this._migrateGatewayProfile(profile, typeId, providers)
        if (result === undefined) {
          this._logger.warn(
            `ai migration: ${agentId} gateway profile missing baseUrl/key — left as-is`,
          )
          next.push(raw)
        } else {
          next.push(result)
          changed = true
        }
      }
      if (changed) {
        auth['profiles'] = next
        migrated = true
      }
    }
    return migrated
  }

  private _migrateGatewayProfile(
    profile: Record<string, unknown>,
    typeId: string,
    providers: AiProviderInstance[],
  ): Record<string, unknown> | undefined {
    const baseUrl = profile['baseUrl']
    const key = typeId === 'anthropic' ? profile['authToken'] : profile['apiKey']
    if (
      typeof baseUrl !== 'string' ||
      baseUrl.trim() === '' ||
      typeof key !== 'string' ||
      key.trim() === ''
    ) {
      return undefined
    }
    const label =
      typeof profile['label'] === 'string'
        ? profile['label']
        : typeof profile['id'] === 'string'
          ? profile['id']
          : 'gateway'
    const used = new Set(providers.map((p) => providerKey(p)))
    const name = uniqueInstanceName(slugify(label), used, typeId)
    providers.push({ name, type: typeId, baseUrl, apiKey: key })
    this._logger.info(`ai migration: gateway profile '${label}' → provider ${typeId}/${name}`)
    const result: Record<string, unknown> = { kind: 'gateway', providerRef: `${typeId}/${name}` }
    if (profile['id'] !== undefined) result['id'] = profile['id']
    if (profile['label'] !== undefined) result['label'] = profile['label']
    if (profile['model'] !== undefined) result['model'] = profile['model']
    if (profile['smallFastModel'] !== undefined)
      result['smallFastModel'] = profile['smallFastModel']
    return result
  }

  private _withGatewayPricing(models: readonly AiModelMetadata[]): readonly AiModelMetadata[] {
    return models.map((m) => {
      const ref = parseModelRef(m.id)
      if (!ref) return m
      const gatewayRates = this._remoteCoordinator.getRates(
        providerKey({ type: ref.type, name: ref.instance }),
      )
      const type = this._mergedTypes()[ref.type]
      const model = this._declaredModel(ref.type, ref.instance, ref.model)
      const resolved = resolveModelPricing({
        modelId: m.id,
        ...(model !== undefined ? { model } : {}),
        ...(gatewayRates !== undefined ? { gatewayRates } : {}),
        ...(type?.pricing !== undefined ? { typePricing: type.pricing } : {}),
      })
      // Only gateway-level hits are new information here — the provider already
      // resolved model/type/catalog. Guard on the origin so a model-level pricing
      // can never be downgraded by the gateway table.
      if (resolved.origin !== 'gateway' || resolved.pricing === undefined) return m
      return { ...m, pricing: resolved.pricing, pricingOrigin: 'gateway' }
    })
  }

  private _declaredModel(
    typeId: string,
    instanceName: string,
    bareModel: string,
  ): AiCustomModelConfig | undefined {
    const instance = this._providers.find((p) => p.type === typeId && p.name === instanceName)
    const fromInstance = instance?.models?.find((m) => m.id === bareModel)
    if (fromInstance !== undefined) return fromInstance
    return this._mergedTypes()[typeId]?.models?.find((m) => m.id === bareModel)
  }

  private _setupWatcher(dir: string): void {
    if (this._watchedDir === dir && this._watcher) return
    this._watcher?.close()
    this._watchedDir = dir
    try {
      this._watcher = fsWatch(dir, (_event, filename) => {
        if (filename && filename.toString() !== AI_SETTINGS_FILE) return
        if (Date.now() < this._suppressUntil) return
        if (this._reloadTimer) clearTimeout(this._reloadTimer)
        this._reloadTimer = setTimeout(() => void this._reload(), 200)
      })
    } catch {
      this._watcher = undefined
    }
  }

  private _pumpResponse(requestId: string, response: AiResponse): void {
    // Pump the provider's stream into requestId-keyed events. Errors and normal
    // completion both terminate via onDidEndRequest (two-path on the renderer).
    void (async () => {
      try {
        for await (const chunk of response.stream) {
          this._recorder?.recordChunk(requestId, chunk)
          this._onDidEmitChunk.fire({ requestId, chunk })
        }
        await response.result
        this._recorder?.finish(requestId)
        this._onDidEndRequest.fire({ requestId })
      } catch (err) {
        this._endRequestWithError(requestId, err)
      } finally {
        this._disposeInflight(requestId)
      }
    })()
  }

  private async _withTimeoutToken<T>(fn: (token: CancellationToken) => Promise<T>): Promise<T> {
    const cts = new CancellationTokenSource()
    const timer = setTimeout(() => cts.cancel(), METADATA_REQUEST_TIMEOUT_MS)
    try {
      return await fn(cts.token)
    } finally {
      clearTimeout(timer)
      cts.dispose()
    }
  }

  private _endRequestWithError(requestId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    // 用户主动取消（停止生成/切换模型）是正常路径，不算失败，降为 info。
    if (isCancellationError(error)) {
      this._logger.info(`request ${requestId} canceled`)
    } else {
      this._logger.warn(`request ${requestId} failed: ${message}`)
    }
    const serialized = transformErrorForSerialization(error)
    this._recorder?.finish(requestId, serialized)
    this._onDidEndRequest.fire({ requestId, error: serialized })
  }

  private _disposeInflight(requestId: string): void {
    this._inflight.get(requestId)?.dispose()
    this._inflight.delete(requestId)
  }

  override dispose(): void {
    if (this._reloadTimer) clearTimeout(this._reloadTimer)
    this._watcher?.close()
    for (const cts of this._inflight.values()) {
      cts.cancel()
      cts.dispose()
    }
    this._inflight.clear()
    super.dispose()
  }
}

/** Legacy secret-storage key holding a provider's API key: `ai.secret.<type>.<name>.apiKey`. */
function parseSecretKey(key: string): { type: string; name: string } | undefined {
  const prefix = 'ai.secret.'
  if (!key.startsWith(prefix) || !key.endsWith('.apiKey')) return undefined
  const middle = key.slice(prefix.length, -'.apiKey'.length)
  const dot = middle.indexOf('.')
  if (dot <= 0) return undefined
  const type = middle.slice(0, dot)
  const name = middle.slice(dot + 1)
  if (type === '' || name === '') return undefined
  return { type, name }
}

/** Migrate legacy `groups[]` into `providers[]` + a synthesized `providerTypes` layer. */
function migrateLegacyGroups(raw: unknown): {
  providers: AiProviderInstance[]
  providerTypes: Record<string, AiProviderType>
} {
  const providers: AiProviderInstance[] = []
  const providerTypes: Record<string, AiProviderType> = {}
  if (!Array.isArray(raw)) return { providers, providerTypes }
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const g = item as Record<string, unknown>
    const name = g['name']
    const vendor = g['vendor']
    if (typeof name !== 'string' || typeof vendor !== 'string') continue
    const baseUrl = typeof g['baseUrl'] === 'string' ? g['baseUrl'] : undefined
    const models = Array.isArray(g['models'])
      ? (g['models'] as readonly AiCustomModelConfig[])
      : undefined
    const settings =
      g['settings'] && typeof g['settings'] === 'object' && !Array.isArray(g['settings'])
        ? (g['settings'] as Record<string, AiModelConfiguration>)
        : undefined
    if (vendor === 'openai' || vendor === 'ollama') {
      providers.push({
        name,
        type: vendor,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(models !== undefined ? { models } : {}),
        ...(settings !== undefined ? { settings } : {}),
      })
    } else {
      providerTypes[vendor] = {
        protocol: 'openai-chat',
        ...(baseUrl !== undefined ? { defaultBaseUrl: baseUrl } : {}),
        requiresApiKey: true,
        ...(models !== undefined ? { models } : {}),
      }
      providers.push({
        name,
        type: vendor,
        ...(settings !== undefined ? { settings } : {}),
      })
    }
  }
  return { providers, providerTypes }
}

function missingProviderError(modelId: string): AiError {
  const ref = parseModelRef(modelId)
  if (ref !== undefined) {
    return new AiError(
      AiErrorCode.ProviderUnavailable,
      `AI provider type '${ref.type}' is not available for model '${modelId}'.`,
    )
  }
  return new AiError(AiErrorCode.ModelNotFound, `No AI model provider found for '${modelId}'.`)
}

function parseSettings(text: string): ParsedSettings {
  const empty: ParsedSettings = { providers: [], providerTypes: {}, activeModels: {}, file: {} }
  if (text.trim() === '') return empty
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty
  }
  const file = parsed as Record<string, unknown>
  return {
    providers: parseProviders(file['providers']),
    providerTypes: parseProviderTypes(file['providerTypes']),
    activeModels: parseActiveModels(file['activeModels']),
    file,
  }
}

function parseProviders(raw: unknown): AiProviderInstance[] {
  const out: AiProviderInstance[] = []
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      typeof (item as { type?: unknown }).type === 'string'
    ) {
      out.push(item as AiProviderInstance)
    }
  }
  return out
}

function parseProviderTypes(raw: unknown): Record<string, AiProviderType> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, AiProviderType> = {}
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { protocol?: unknown }).protocol === 'string'
    ) {
      out[id] = entry as AiProviderType
    }
  }
  return out
}

function parseActiveModels(raw: unknown): AiActiveModels {
  if (!raw || typeof raw !== 'object') return {}
  const out: { chat?: string; inlineCompletion?: string; commit?: string; sessionTitle?: string } =
    {}
  const chat = (raw as { chat?: unknown }).chat
  const inline = (raw as { inlineCompletion?: unknown }).inlineCompletion
  const commit = (raw as { commit?: unknown }).commit
  const sessionTitle = (raw as { sessionTitle?: unknown }).sessionTitle
  if (typeof chat === 'string') out.chat = chat
  if (typeof inline === 'string') out.inlineCompletion = inline
  if (typeof commit === 'string') out.commit = commit
  if (typeof sessionTitle === 'string') out.sessionTitle = sessionTitle
  return out
}

function hasAnyActive(active: AiActiveModels): boolean {
  return (
    active.chat !== undefined ||
    active.inlineCompletion !== undefined ||
    active.commit !== undefined ||
    active.sessionTitle !== undefined
  )
}

function cloneInstance(p: AiProviderInstance): MutableInstance {
  return { ...p, ...(p.settings !== undefined ? { settings: { ...p.settings } } : {}) }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'gateway'
}

function uniqueInstanceName(base: string, used: Set<string>, typeId: string): string {
  let candidate = base
  let suffix = 2
  while (used.has(`${typeId}/${candidate}`)) {
    candidate = `${base}-${suffix}`
    suffix++
  }
  return candidate
}

/** Schema default values overlaid by the user's stored settings. */
function mergeModelConfig(
  schema: AiModelConfigSchema | undefined,
  userSettings: AiModelConfiguration,
): AiModelConfiguration {
  const out: Record<string, string | number | boolean> = {}
  if (schema) {
    for (const [key, prop] of Object.entries(schema)) {
      if (prop.default !== undefined) out[key] = prop.default
    }
  }
  return { ...out, ...userSettings }
}

/** Drop keys whose value equals the schema default, so the file stays minimal. */
function dropDefaults(
  config: AiModelConfiguration,
  schema: AiModelConfigSchema | undefined,
): AiModelConfiguration {
  if (!schema) return config
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(config)) {
    if (schema[key]?.default === value) continue
    out[key] = value
  }
  return out
}

function reviveMessage(dto: AiMessageDto): AiMessage {
  return {
    role: dto.role,
    content: dto.content.map((part): AiMessagePart => {
      if (part.type === 'image') {
        return {
          type: 'image',
          mimeType: part.mimeType,
          data: Uint8Array.from(Buffer.from(part.dataBase64, 'base64')),
        }
      }
      return part
    }),
  }
}
