/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process AI model facade: reads the single-layer `providers[]` from
 *  <configDir>/aiSettings.json, flattens `extends` and applies the model knowledge
 *  base via resolveProviderEntries, feeds the registry, schedules requests, and
 *  pumps each provider stream into requestId-keyed chunk events. Per-model
 *  configuration (schema default → user settings → per-request options) lives at the
 *  top-level `modelSettings` and is resolved here. Remote rate/usage sources are
 *  coordinated here (off the hot path) and exposed to the renderer as a synchronous
 *  mirror; each model's rate comes only from its provider's declared pricingSource.
 *--------------------------------------------------------------------------------------------*/

import { type FSWatcher, watch as fsWatch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  mergeModelKnowledge,
  parseModelRef,
  resolveProviderEntries,
  transformErrorForSerialization,
  type AiAccountUsage,
  type AiActiveModelKind,
  type AiActiveModels,
  type AiMessage,
  type AiMessagePart,
  type AiModelConfiguration,
  type AiModelConfigSchema,
  type AiModelKnowledge,
  type AiModelMetadata,
  type AiModelSelector,
  type AiProviderEntry,
  type AiProviderIssue,
  type AiProviderRuntime,
  type AiProviderVerifyInput,
  type AiProviderVerifyResult,
  type AiRateTableSnapshot,
  type AiRequestOptions,
  type AiResolvedProvider,
  type AiResponse,
  type AiSettingsFile,
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
import { BUILTIN_MODEL_KNOWLEDGE } from '../../../shared/ai/catalog/modelKnowledge.js'
import { resolveModelPricing } from '../../../shared/ai/resolveProviderPricing.js'
import { OllamaProvider } from './providers/ollamaProvider.js'
import { OpenAiChatProvider } from './providers/openAiChatProvider.js'
import { AnthropicMessagesProvider } from './providers/anthropicMessagesProvider.js'
import { OpenAiResponsesProvider } from './providers/openAiResponsesProvider.js'
import { HttpJsonPricingSource } from './remote/httpJsonPricingSource.js'
import { HttpJsonUsageSource } from './remote/httpJsonUsageSource.js'
import { CatalogPricingSource } from './remote/catalogPricingSource.js'
import { AiRemoteCache } from './remote/remoteCache.js'
import { AiRemoteCoordinator } from './remote/remoteCoordinator.js'
import { AiDebugRecorder, IAiDebugRecorderService } from './aiDebugRecorder.js'
import { mutateAiSettingsFile } from './aiSettingsFile.js'

const AI_SETTINGS_FILE = 'aiSettings.json'

/**
 * Upper bound for one-shot metadata calls (model enumeration, token counting,
 * model selection). Without it, a provider whose endpoint never responds (e.g. a
 * misconfigured baseUrl) keeps its fetch — and the cancellation listener / abort
 * store it registers — pending forever, surfacing as a leak on process exit.
 */
const METADATA_REQUEST_TIMEOUT_MS = 10_000

/** Mutable working copy of a provider entry, used when editing the persisted file. */
type MutableEntry = {
  -readonly [K in keyof AiProviderEntry]: AiProviderEntry[K]
}

/** Typed + legacy-flag result of parsing an aiSettings.json. */
interface ParsedSettings {
  readonly file: AiSettingsFile
  readonly legacyDetected: boolean
  /** Entries too malformed to become an `AiProviderEntry` at all. */
  readonly malformed: readonly AiProviderIssue[]
}

/** Fields `_writeSettings` should change; absent fields preserve what is on disk. */
interface SettingsWrite {
  readonly providers?: readonly AiProviderEntry[]
  readonly modelSettings?: Readonly<Record<string, AiModelConfiguration>>
  readonly activeModels?: AiActiveModels
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
  /** One-shot metadata calls in flight; cancelled on dispose so their fetches abort. */
  private readonly _metadataRequests = new Set<CancellationTokenSource>()
  private _providers: readonly AiProviderEntry[] = []
  private _knowledge: Readonly<Record<string, AiModelKnowledge>> = BUILTIN_MODEL_KNOWLEDGE
  private _resolvedProviders: readonly AiResolvedProvider[] = []
  private _modelSettings: Readonly<Record<string, AiModelConfiguration>> = {}
  private _activeModels: AiActiveModels = {}
  private _issues: readonly AiProviderIssue[] = []
  private _legacyDetected = false
  private readonly _ready: Promise<void>

  private _watcher: FSWatcher | undefined
  private _watchedDir: string | undefined
  private _reloadTimer: ReturnType<typeof setTimeout> | undefined
  private _suppressUntil = 0

  constructor(
    @IConfigLocationService configLocation: IConfigLocationService,
    @ILoggerService loggerService?: ILoggerService,
    @IAiDebugRecorderService private readonly _recorder?: AiDebugRecorder,
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
    this._register(
      this._remoteRegistry.registerPricingSource(new CatalogPricingSource(this._logger)),
    )
  }

  async getModels(): Promise<readonly AiModelMetadata[]> {
    await this._ready
    return this._withTimeoutToken(async (token) => {
      const models = await this._registry.getModels(token)
      return this._withPricing(models)
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
      return resolved.provider.provideTokenCount(modelId, text, resolved.runtime, token)
    })
  }

  async getModelConfiguration(modelId: string): Promise<AiModelConfiguration> {
    await this._ready
    const schema = await this._schemaFor(modelId)
    return mergeModelConfig(schema, this._modelSettings[modelId] ?? {})
  }

  async setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void> {
    await this._ready
    const schema = await this._schemaFor(modelId)
    const cleaned = dropDefaults(config, schema)

    const next: Record<string, AiModelConfiguration> = { ...this._modelSettings }
    if (Object.keys(cleaned).length === 0) delete next[modelId]
    else next[modelId] = cleaned

    await this._writeSettings({ modelSettings: next })
    await this._reload()
  }

  async getProviders(): Promise<readonly AiProviderEntry[]> {
    await this._ready
    return this._providers
  }

  async updateProviders(providers: readonly AiProviderEntry[]): Promise<void> {
    await this._ready
    await this._writeSettings({ providers })
    await this._reload()
  }

  async getModelKnowledge(): Promise<Readonly<Record<string, AiModelKnowledge>>> {
    await this._ready
    return this._knowledge
  }

  async getProviderIssues(): Promise<readonly AiProviderIssue[]> {
    await this._ready
    return this._issues
  }

  async isLegacySettingsFormat(): Promise<boolean> {
    await this._ready
    return this._legacyDetected
  }

  async verifyProvider(input: AiProviderVerifyInput): Promise<AiProviderVerifyResult> {
    await this._ready
    const impl = this._registry.getProvider(input.protocol)
    if (!impl) {
      return {
        ok: false,
        modelCount: 0,
        error: localize('ai.verify.noProvider', "No provider registered for '{protocol}'.", {
          protocol: input.protocol,
        }),
      }
    }
    // A throwaway runtime: the probed key is read from the input only and never
    // written to aiSettings.json.
    const runtime: AiProviderRuntime = {
      id: input.id,
      protocol: input.protocol,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    }
    try {
      const models = await this._withTimeoutToken((token) => impl.listModels(runtime, token))
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

  async setApiKey(providerId: string, key: string): Promise<void> {
    await this._ready
    const providers = this._providers.map(cloneEntry)
    const entry = providers.find((p) => p.id === providerId)
    if (entry === undefined) return
    entry.apiKey = key
    await this._writeSettings({ providers })
    await this._reload()
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await this._ready
    const providers = this._providers.map(cloneEntry)
    const entry = providers.find((p) => p.id === providerId)
    if (entry === undefined || entry.apiKey === undefined) return
    delete entry.apiKey
    await this._writeSettings({ providers })
    await this._reload()
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    await this._ready
    return this._providers.some((p) => p.id === providerId && p.apiKey !== undefined)
  }

  async getRateTables(): Promise<readonly AiRateTableSnapshot[]> {
    await this._ready
    return this._remoteCoordinator.allRateSnapshots()
  }

  async getAccountUsage(providerId: string): Promise<AiAccountUsage | undefined> {
    await this._ready
    return this._remoteCoordinator.getUsage(providerId)
  }

  async refreshRemote(providerId?: string): Promise<void> {
    await this._ready
    await this._remoteCoordinator.refresh(providerId)
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
        resolved.provider.sendRequest(domainMessages, merged, resolved.runtime, cts.token),
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
    this._legacyDetected = parsed.legacyDetected
    if (parsed.legacyDetected) {
      // The retired two-layer format is never rewritten — the user rebuilds by hand.
      this._logger.warn(
        'ai settings: legacy two-layer format detected; configuration ignored (rebuild manually)',
      )
      this._providers = []
      this._knowledge = BUILTIN_MODEL_KNOWLEDGE
      this._resolvedProviders = []
      this._modelSettings = {}
      this._activeModels = {}
      this._issues = []
      this._registry.setProviders([], this._knowledge)
      this._remoteCoordinator.setProviders([])
      return
    }

    this._knowledge = mergeModelKnowledge(BUILTIN_MODEL_KNOWLEDGE, parsed.file.models)
    this._providers = parsed.file.providers
    this._modelSettings = parsed.file.modelSettings ?? {}
    this._activeModels = parsed.file.activeModels ?? {}

    const resolved = resolveProviderEntries(this._providers, this._knowledge)
    this._resolvedProviders = resolved.providers
    this._issues = [...parsed.malformed, ...resolved.issues]
    for (const issue of this._issues) {
      this._logger.warn(
        `ai settings: provider '${issue.providerId}' ${issue.reason}${
          issue.detail !== undefined ? ` (${issue.detail})` : ''
        }`,
      )
    }
    this._logger.info(
      `ai settings: ${resolved.providers.length} provider(s) resolved from ${this._providers.length} entry(ies), ${this._issues.length} issue(s)`,
    )
    this._registry.setProviders(resolved.providers, this._knowledge)
    this._remoteCoordinator.setProviders(resolved.providers)
  }

  private async _writeSettings(write: SettingsWrite): Promise<void> {
    const { dir } = await this._configLocation.getInfo()
    const path = join(dir, AI_SETTINGS_FILE)
    this._suppressUntil = Date.now() + 500
    // The agent-authentication helpers share this file; the read-modify-write
    // below is serialized with them by aiSettingsFile.
    await mutateAiSettingsFile(
      path,
      (root) => {
        if (write.providers !== undefined) root['providers'] = write.providers
        if (write.modelSettings !== undefined) {
          if (Object.keys(write.modelSettings).length > 0)
            root['modelSettings'] = write.modelSettings
          else delete root['modelSettings']
        }
        if (write.activeModels !== undefined) {
          if (hasAnyActive(write.activeModels)) root['activeModels'] = write.activeModels
          else delete root['activeModels']
        }
      },
      (error) => {
        this._logger.warn(`ai settings: chmod 0600 failed: ${error.message}`)
      },
    )
  }

  /** Stamp each model with its provider-declared pricingSource — never another provider's rate. */
  private _withPricing(models: readonly AiModelMetadata[]): readonly AiModelMetadata[] {
    return models.map((m) => {
      const provider = this._resolvedProviders.find((p) => p.id === m.providerId)
      if (provider === undefined || provider.pricingSource === undefined) return m
      const gatewayRates = this._remoteCoordinator.getRates(provider.id)
      const resolved = resolveModelPricing({
        bareModel: m.channelModel,
        pricingSource: provider.pricingSource,
        ...(gatewayRates !== undefined ? { gatewayRates } : {}),
      })
      if (resolved.pricing === undefined) return m
      return {
        ...m,
        pricing: resolved.pricing,
        ...(resolved.origin !== undefined ? { pricingOrigin: resolved.origin } : {}),
      }
    })
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
    this._metadataRequests.add(cts)
    try {
      return await fn(cts.token)
    } finally {
      clearTimeout(timer)
      this._metadataRequests.delete(cts)
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
    // Metadata calls (model enumeration / token counting) can still be waiting on
    // a fetch that will never answer. Cancelling tears down each provider's abort
    // pipeline synchronously (see toAbortSignal); their own `finally` would only
    // run a microtask later — after the process-exit leak check.
    for (const cts of this._metadataRequests) {
      cts.cancel()
      cts.dispose()
    }
    this._metadataRequests.clear()
    super.dispose()
  }
}

function missingProviderError(modelId: string): AiError {
  const ref = parseModelRef(modelId)
  if (ref !== undefined) {
    return new AiError(
      AiErrorCode.ProviderUnavailable,
      `AI provider '${ref.providerId}' is not available for model '${modelId}'.`,
    )
  }
  return new AiError(AiErrorCode.ModelNotFound, `No AI model provider found for '${modelId}'.`)
}

function parseSettings(text: string): ParsedSettings {
  const empty: ParsedSettings = { file: { providers: [] }, legacyDetected: false, malformed: [] }
  if (text.trim() === '') return empty
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty
  }
  const file = parsed as Record<string, unknown>
  if (isLegacyFile(file)) {
    return { file: { providers: [] }, legacyDetected: true, malformed: [] }
  }
  const models = parseKnowledge(file['models'])
  const modelSettings = parseModelSettings(file['modelSettings'])
  const agentSettings = asRecord(file['agentSettings'])
  const providers = parseProviders(file['providers'])
  return {
    file: {
      ...(models !== undefined ? { models } : {}),
      providers: providers.entries,
      ...(modelSettings !== undefined ? { modelSettings } : {}),
      activeModels: parseActiveModels(file['activeModels']),
      ...(agentSettings !== undefined ? { agentSettings } : {}),
    },
    legacyDetected: false,
    malformed: providers.malformed,
  }
}

/** The retired two-layer format: a `providerTypes` key, a `groups` key, or any `providers[].type`. */
function isLegacyFile(file: Record<string, unknown>): boolean {
  if ('providerTypes' in file) return true
  if ('groups' in file) return true
  const providers = file['providers']
  if (Array.isArray(providers)) {
    return providers.some(
      (p) => p !== null && typeof p === 'object' && 'type' in (p as Record<string, unknown>),
    )
  }
  return false
}

function parseProviders(raw: unknown): {
  entries: AiProviderEntry[]
  malformed: AiProviderIssue[]
} {
  const entries: AiProviderEntry[] = []
  const malformed: AiProviderIssue[] = []
  if (!Array.isArray(raw)) return { entries, malformed }
  for (const [index, item] of raw.entries()) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      entries.push(item as AiProviderEntry)
      continue
    }
    // A typo'd or non-object element would otherwise vanish with no feedback at all.
    malformed.push({
      providerId: `providers[${index}]`,
      reason: 'malformed-entry',
      fatal: true,
    })
  }
  return { entries, malformed }
}

function parseKnowledge(raw: unknown): Readonly<Record<string, AiModelKnowledge>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Readonly<Record<string, AiModelKnowledge>>
}

function parseModelSettings(
  raw: unknown,
): Readonly<Record<string, AiModelConfiguration>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Readonly<Record<string, AiModelConfiguration>>
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

function cloneEntry(p: AiProviderEntry): MutableEntry {
  return { ...p }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
