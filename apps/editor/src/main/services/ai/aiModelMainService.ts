/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process AI model facade: reads provider groups from <configDir>/aiSettings.json,
 *  resolves them into runtime groups (with lazy secret-backed getApiKey), feeds them
 *  to the registry, schedules requests, and pumps each provider stream into
 *  requestId-keyed chunk events. Per-model configuration (schema default → user
 *  settings → per-request options) is resolved here and handed to the provider.
 *--------------------------------------------------------------------------------------------*/

import { type FSWatcher, watch as fsWatch } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AiError,
  AiErrorCode,
  AiModelRegistry,
  type CancellationToken,
  CancellationTokenSource,
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
  ISecretStorageService,
  transformErrorForSerialization,
  type AiActiveModelKind,
  type AiActiveModels,
  type AiCustomModelConfig,
  type AiGroupVerifyInput,
  type AiGroupVerifyResult,
  type AiMessage,
  type AiMessagePart,
  type AiModelConfiguration,
  type AiModelConfigSchema,
  type AiModelMetadata,
  type AiModelSelector,
  type AiProviderGroup,
  type AiRequestOptions,
  type AiResolvedGroup,
  type AiResponse,
  type AiVendorDescriptor,
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
import { OllamaProvider } from './providers/ollamaProvider.js'
import { OpenAiProvider } from './providers/openAiProvider.js'
import { AiDebugRecorder, IAiDebugRecorderService } from './aiDebugRecorder.js'

const AI_SETTINGS_FILE = 'aiSettings.json'

/**
 * Upper bound for one-shot metadata calls (model enumeration, token counting,
 * model selection). Without it, a provider whose endpoint never responds (e.g. a
 * misconfigured baseUrl) keeps its fetch — and the cancellation listener / abort
 * store it registers — pending forever, surfacing as a leak on process exit.
 */
const METADATA_REQUEST_TIMEOUT_MS = 10_000

/**
 * Endpoint defaults per built-in vendor, surfaced in the "add provider" picker.
 * Vendors without an entry still appear (from the registry) with no defaults.
 */
const VENDOR_DESCRIPTORS: Readonly<Record<string, Omit<AiVendorDescriptor, 'vendor'>>> = {
  openai: {
    label: 'OpenAI (compatible)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
  },
  ollama: {
    label: 'Ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    requiresApiKey: false,
  },
}

/** Mutable working copy of a group, used when editing the persisted file. */
interface MutableGroup {
  name: string
  vendor: string
  baseUrl?: string
  models?: readonly AiCustomModelConfig[]
  settings?: Record<string, AiModelConfiguration>
}

export class AiModelMainService extends Disposable implements IAiModelMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _registry = this._register(new AiModelRegistry())
  private readonly _secrets: ISecretStorageService
  private readonly _configLocation: IConfigLocationService

  private readonly _onDidEmitChunk = this._register(new Emitter<AiChunkEvent>())
  readonly onDidEmitChunk = this._onDidEmitChunk.event

  private readonly _onDidEndRequest = this._register(new Emitter<AiEndEvent>())
  readonly onDidEndRequest = this._onDidEndRequest.event

  readonly onDidChangeModels = this._registry.onDidChangeModels

  private readonly _onDidChangeActiveModel = this._register(new Emitter<AiActiveModelChangeEvent>())
  readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event

  private readonly _inflight = new Map<string, CancellationTokenSource>()
  private _persistedGroups: readonly AiProviderGroup[] = []
  private _activeModels: AiActiveModels = {}
  private readonly _ready: Promise<void>

  private _watcher: FSWatcher | undefined
  private _watchedDir: string | undefined
  private _reloadTimer: ReturnType<typeof setTimeout> | undefined
  private _suppressUntil = 0

  constructor(
    @ISecretStorageService secrets: ISecretStorageService,
    @IConfigLocationService configLocation: IConfigLocationService,
    @ILoggerService loggerService?: ILoggerService,
    @IAiDebugRecorderService private readonly _recorder?: AiDebugRecorder,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'aiModel', name: 'AI Model' })
    this._secrets = secrets
    this._configLocation = configLocation

    this._registerBuiltInProviders()
    this._register(configLocation.onDidChangeConfigDir(() => void this._reload()))
    this._ready = this._reload()
  }

  private _registerBuiltInProviders(): void {
    this._register(this._registry.registerProvider('ollama', new OllamaProvider()))
    this._register(this._registry.registerProvider('openai', new OpenAiProvider()))
  }

  async getModels(): Promise<readonly AiModelMetadata[]> {
    await this._ready
    return this._withTimeoutToken((token) => this._registry.getModels(token))
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
      return resolved.provider.provideTokenCount(modelId, text, resolved.group, token)
    })
  }

  async getModelConfiguration(modelId: string): Promise<AiModelConfiguration> {
    await this._ready
    const ref = parseGroupRef(modelId)
    const group = ref
      ? this._persistedGroups.find((g) => g.vendor === ref.vendor && g.name === ref.group)
      : undefined
    const userSettings = group?.settings?.[modelId] ?? {}
    const schema = await this._schemaFor(modelId)
    return mergeModelConfig(schema, userSettings)
  }

  async setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void> {
    await this._ready
    const ref = parseGroupRef(modelId)
    if (!ref) return
    const schema = await this._schemaFor(modelId)
    const cleaned = dropDefaults(config, schema)

    const groups = this._persistedGroups.map(cloneGroup)
    let idx = groups.findIndex((g) => g.vendor === ref.vendor && g.name === ref.group)
    if (idx === -1) {
      groups.push({ name: ref.group, vendor: ref.vendor })
      idx = groups.length - 1
    }
    const group = groups[idx]!
    const settings: Record<string, AiModelConfiguration> = { ...(group.settings ?? {}) }
    if (Object.keys(cleaned).length === 0) delete settings[modelId]
    else settings[modelId] = cleaned
    if (Object.keys(settings).length === 0) delete group.settings
    else group.settings = settings

    await this._writeSettings(groups, this._activeModels)
    await this._reload()
  }

  async getGroups(): Promise<readonly AiProviderGroup[]> {
    await this._ready
    return this._persistedGroups
  }

  async updateGroups(groups: readonly AiProviderGroup[]): Promise<void> {
    await this._ready
    await this._writeSettings(groups, this._activeModels)
    await this._reload()
  }

  async getVendors(): Promise<readonly AiVendorDescriptor[]> {
    await this._ready
    return this._registry.getVendors().map((vendor) => {
      const desc = VENDOR_DESCRIPTORS[vendor]
      return {
        vendor,
        label: desc?.label ?? vendor,
        requiresApiKey: desc?.requiresApiKey ?? false,
        ...(desc?.defaultBaseUrl !== undefined ? { defaultBaseUrl: desc.defaultBaseUrl } : {}),
      }
    })
  }

  async verifyGroup(input: AiGroupVerifyInput): Promise<AiGroupVerifyResult> {
    await this._ready
    const provider = this._registry.getProvider(input.vendor)
    if (!provider) {
      return { ok: false, modelCount: 0, error: `No provider registered for '${input.vendor}'.` }
    }
    // A throwaway resolved group: the probed key is read from the input only and
    // never written to secret storage or aiSettings.json.
    const group: AiResolvedGroup = {
      vendor: input.vendor,
      name: input.name,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      getApiKey: () => Promise.resolve(input.apiKey),
    }
    try {
      const models = await this._withTimeoutToken((token) => provider.provideModels(group, token))
      if (models.length === 0) {
        return {
          ok: false,
          modelCount: 0,
          error: 'The endpoint responded but no models are available.',
        }
      }
      return { ok: true, modelCount: models.length }
    } catch (err) {
      return { ok: false, modelCount: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async setApiKey(vendor: string, group: string, key: string): Promise<void> {
    await this._secrets.set(secretKey(vendor, group), key)
    await this._reload()
  }

  async deleteApiKey(vendor: string, group: string): Promise<void> {
    await this._secrets.delete(secretKey(vendor, group))
    await this._reload()
  }

  async hasApiKey(vendor: string, group: string): Promise<boolean> {
    return (await this._secrets.get(secretKey(vendor, group))) !== undefined
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
        resolved.provider.sendRequest(domainMessages, merged, resolved.group, cts.token),
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
    await this._writeSettings(this._persistedGroups, next)
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
    this._persistedGroups = parsed.groups
    this._activeModels = parsed.activeModels
    this._registry.setGroups(this._toResolved(this._persistedGroups))
  }

  private async _writeSettings(
    groups: readonly AiProviderGroup[],
    activeModels: AiActiveModels,
  ): Promise<void> {
    const { dir } = await this._configLocation.getInfo()
    await mkdir(dir, { recursive: true })
    const path = join(dir, AI_SETTINGS_FILE)
    this._suppressUntil = Date.now() + 500
    // Credential libraries and unfinished agent-authentication forms share this
    // file. Re-read it immediately before writing so model changes preserve state
    // written by the agent settings services.
    let existing: Record<string, unknown> = {}
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = parse(raw, [], { allowTrailingComma: true })
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      }
    } catch {
      // The normal write below restores a missing or malformed file.
    }
    const file: Record<string, unknown> = {
      ...existing,
      groups,
    }
    if (hasAnyActive(activeModels)) file.activeModels = activeModels
    else delete file.activeModels
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await rename(tmp, path)
  }

  private _toResolved(groups: readonly AiProviderGroup[]): readonly AiResolvedGroup[] {
    return groups.map(
      (g): AiResolvedGroup => ({
        vendor: g.vendor,
        name: g.name,
        ...(g.baseUrl !== undefined ? { baseUrl: g.baseUrl } : {}),
        ...(g.models !== undefined ? { declaredModels: g.models } : {}),
        getApiKey: () => this._secrets.get(secretKey(g.vendor, g.name)),
      }),
    )
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
    this._logger.warn(`request ${requestId} failed: ${message}`)
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

/** Secret-storage key holding a group's API key, e.g. `ai.secret.openai.default.apiKey`. */
function secretKey(vendor: string, group: string): string {
  return `ai.secret.${vendor}.${group}.apiKey`
}

/** Vendor + group segments of a three-part model id (`vendor/group/model`). */
function parseGroupRef(modelId: string): { vendor: string; group: string } | undefined {
  const parts = modelId.split('/')
  if (parts.length < 3 || !parts[0] || !parts[1]) return undefined
  return { vendor: parts[0], group: parts[1] }
}

function missingProviderError(modelId: string): AiError {
  const ref = parseGroupRef(modelId)
  if (ref !== undefined) {
    return new AiError(
      AiErrorCode.ProviderUnavailable,
      `AI provider '${ref.vendor}' is not available for model '${modelId}'.`,
    )
  }
  return new AiError(AiErrorCode.ModelNotFound, `No AI model provider found for '${modelId}'.`)
}

function parseSettings(text: string): { groups: AiProviderGroup[]; activeModels: AiActiveModels } {
  const empty = { groups: [] as AiProviderGroup[], activeModels: {} as AiActiveModels }
  if (text.trim() === '') return empty
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty
  }
  const groupsRaw = (parsed as { groups?: unknown }).groups
  const groups: AiProviderGroup[] = []
  if (Array.isArray(groupsRaw)) {
    for (const item of groupsRaw) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { vendor?: unknown }).vendor === 'string'
      ) {
        groups.push(item as AiProviderGroup)
      }
    }
  }
  return {
    groups,
    activeModels: parseActiveModels((parsed as { activeModels?: unknown }).activeModels),
  }
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

function cloneGroup(g: AiProviderGroup): MutableGroup {
  return { ...g, ...(g.settings ? { settings: { ...g.settings } } : {}) }
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
