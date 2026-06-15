/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process AI model facade: reads provider groups from <configDir>/aiModels.json,
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
  type AiCustomModelConfig,
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
} from '@universe-editor/platform'
import { type ParseError, parse } from 'jsonc-parser'
import { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'
import { OllamaProvider } from './providers/ollamaProvider.js'
import { OpenAiProvider } from './providers/openAiProvider.js'

const AI_MODELS_FILE = 'aiModels.json'

/** Out-of-box groups synthesized when aiModels.json is missing or empty. */
const DEFAULT_GROUPS: readonly AiProviderGroup[] = [
  { name: 'default', vendor: 'ollama' },
  { name: 'default', vendor: 'openai' },
]

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

  private readonly _inflight = new Map<string, CancellationTokenSource>()
  private _persistedGroups: readonly AiProviderGroup[] = DEFAULT_GROUPS
  private readonly _ready: Promise<void>

  private _watcher: FSWatcher | undefined
  private _watchedDir: string | undefined
  private _reloadTimer: ReturnType<typeof setTimeout> | undefined
  private _suppressUntil = 0

  constructor(
    @ISecretStorageService secrets: ISecretStorageService,
    @IConfigLocationService configLocation: IConfigLocationService,
    @ILoggerService loggerService?: ILoggerService,
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

    await this._writeGroups(groups)
    await this._reload()
  }

  async getGroups(): Promise<readonly AiProviderGroup[]> {
    await this._ready
    return this._persistedGroups
  }

  async updateGroups(groups: readonly AiProviderGroup[]): Promise<void> {
    await this._ready
    await this._writeGroups(groups)
    await this._reload()
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

    try {
      const resolved = await this._registry.resolveModel(options.modelId, cts.token)
      if (!resolved) {
        this._endRequestWithError(requestId, missingProviderError(options.modelId))
        this._disposeInflight(requestId)
        return
      }

      const domainMessages = messages.map(reviveMessage)
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

  private async _schemaFor(modelId: string): Promise<AiModelConfigSchema | undefined> {
    const models = await this._withTimeoutToken((token) => this._registry.getModels(token))
    return models.find((m) => m.id === modelId)?.configurationSchema
  }

  private async _reload(): Promise<void> {
    const { dir } = await this._configLocation.getInfo()
    this._setupWatcher(dir)
    const path = join(dir, AI_MODELS_FILE)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      text = ''
    }
    const parsed = parseGroups(text)
    this._persistedGroups = parsed.length > 0 ? parsed : DEFAULT_GROUPS
    this._registry.setGroups(this._toResolved(this._persistedGroups))
  }

  private async _writeGroups(groups: readonly AiProviderGroup[]): Promise<void> {
    const { dir } = await this._configLocation.getInfo()
    await mkdir(dir, { recursive: true })
    const path = join(dir, AI_MODELS_FILE)
    this._suppressUntil = Date.now() + 500
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(groups, null, 2) + '\n', 'utf8')
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
        if (filename && filename.toString() !== AI_MODELS_FILE) return
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
          this._onDidEmitChunk.fire({ requestId, chunk })
        }
        await response.result
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
    try {
      return await fn(cts.token)
    } finally {
      cts.dispose()
    }
  }

  private _endRequestWithError(requestId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this._logger.warn(`request ${requestId} failed: ${message}`)
    this._onDidEndRequest.fire({ requestId, error: transformErrorForSerialization(error) })
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

function parseGroups(text: string): AiProviderGroup[] {
  if (text.trim() === '') return []
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !Array.isArray(parsed)) return []
  const out: AiProviderGroup[] = []
  for (const item of parsed) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      typeof (item as { vendor?: unknown }).vendor === 'string'
    ) {
      out.push(item as AiProviderGroup)
    }
  }
  return out
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
