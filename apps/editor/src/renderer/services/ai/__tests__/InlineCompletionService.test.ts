/*---------------------------------------------------------------------------------------------
 *  Tests for InlineCompletionService — the policy half of AI ghost-text completions:
 *  the sanitizeCompletion post-processor (fence stripping, suffix-overlap trim,
 *  single-line truncation) plus provide()'s gating (disabled feature, disabled
 *  language, missing/stale model) and reply plumbing. Monaco model + AI service are
 *  stubbed; no real editor is involved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  AiError,
  AiErrorCode,
  AiMessageRole,
  CancellationToken,
  CancellationTokenSource,
  Emitter,
  Severity,
  type AiMessage,
  type AiModelMetadata,
  type AiRequestOptions,
  type AiResponse,
  type IAiModelService,
  type IConfigurationService,
  type ILogger,
  type ILoggerService,
  type INotificationService,
} from '@universe-editor/platform'
import { InlineCompletionService, sanitizeCompletion } from '../InlineCompletionService.js'

const MODEL: AiModelMetadata = {
  id: 'openai/default/m',
  vendor: 'openai',
  name: 'm',
  family: 'm',
  maxInputTokens: 8000,
  maxOutputTokens: 4000,
  capabilities: { streaming: true, vision: false, toolCalling: false },
}

function textResponse(text: string): AiResponse {
  async function* gen() {
    yield { type: 'text', value: text } as const
  }
  return { stream: gen(), result: Promise.resolve({}) }
}

function errorResponse(error: unknown): AiResponse {
  async function* gen() {
    throw error
    yield { type: 'text', value: '' } as const
  }
  const result = Promise.reject(error)
  result.catch(() => {})
  return { stream: gen(), result }
}

class FakeAiModel implements Partial<IAiModelService> {
  models: readonly AiModelMetadata[] = [MODEL]
  lastMessages: readonly AiMessage[] | undefined
  lastOptions: AiRequestOptions | undefined
  reply = 'hello'
  error: unknown
  private readonly _onDidChangeModels = new Emitter<void>()
  readonly onDidChangeModels = this._onDidChangeModels.event

  getModels(): Promise<readonly AiModelMetadata[]> {
    return Promise.resolve(this.models)
  }
  sendRequest(messages: readonly AiMessage[], options: AiRequestOptions): AiResponse {
    this.lastMessages = messages
    this.lastOptions = options
    if (this.error !== undefined) return errorResponse(this.error)
    return textResponse(this.reply)
  }
}

class FakeConfig implements Partial<IConfigurationService> {
  values: Record<string, unknown> = {}
  private readonly _onDidChange = new Emitter<{ affectsConfiguration: (k: string) => boolean }>()
  readonly onDidChangeConfiguration = this._onDidChange
    .event as IConfigurationService['onDidChangeConfiguration']
  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined
  }
  update(key: string, value: unknown): void {
    const old = this.values[key]
    this.values[key] = value
    if (old !== value) this._onDidChange.fire({ affectsConfiguration: (k) => k === key })
  }
}

const NULL_LOGGER: ILogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as ILogger

const FAKE_LOGGER_SERVICE: ILoggerService = {
  createLogger: () => NULL_LOGGER,
} as unknown as ILoggerService

interface NotifyCall {
  severity: Severity
  message: string
}

class FakeNotification implements Partial<INotificationService> {
  calls: NotifyCall[] = []
  notify(opts: { severity: Severity; message: string }): never {
    this.calls.push({ severity: opts.severity, message: opts.message })
    return { close() {}, updateMessage() {}, updateSeverity() {} } as never
  }
}

interface FakeModelOptions {
  value: string
  cursorOffset: number
  languageId?: string
}

function fakeMonacoModel(opts: FakeModelOptions) {
  return {
    getValue: () => opts.value,
    getLanguageId: () => opts.languageId ?? 'plaintext',
    getOffsetAt: () => opts.cursorOffset,
  }
}

const POSITION = { lineNumber: 1, column: 1 } as never
const EXPLICIT = { triggerKind: 1 } as never

function createService(overrides?: {
  ai?: FakeAiModel
  config?: FakeConfig
  notification?: FakeNotification
}) {
  const ai = overrides?.ai ?? new FakeAiModel()
  const config = overrides?.config ?? new FakeConfig()
  const notification = overrides?.notification ?? new FakeNotification()
  const service = new InlineCompletionService(
    ai as unknown as IAiModelService,
    config as unknown as IConfigurationService,
    notification as unknown as INotificationService,
    FAKE_LOGGER_SERVICE,
  )
  return { service, ai, config, notification }
}

async function provide(
  service: InlineCompletionService,
  model: ReturnType<typeof fakeMonacoModel>,
  ctx: never = EXPLICIT,
  token: CancellationToken = CancellationToken.None,
) {
  return service.provide(model as never, POSITION, ctx, token)
}

describe('sanitizeCompletion', () => {
  it('strips a fenced code block', () => {
    expect(sanitizeCompletion('```ts\nconst a = 1\n```', '', true)).toBe('const a = 1')
  })

  it('trims a tail that overlaps the suffix', () => {
    // Reply ends with the start of the existing suffix → drop the overlap.
    expect(sanitizeCompletion('foobar', 'bar baz', true)).toBe('foo')
  })

  it('truncates to a single line when multiline is off', () => {
    expect(sanitizeCompletion('line one\nline two', '', false)).toBe('line one')
  })

  it('keeps multiple lines when multiline is on', () => {
    expect(sanitizeCompletion('line one\nline two', '', true)).toBe('line one\nline two')
  })

  it('returns empty for whitespace-only replies', () => {
    expect(sanitizeCompletion('   \n  ', '', true)).toBe('')
  })
})

describe('InlineCompletionService.provide', () => {
  it('returns null when the feature is disabled', async () => {
    const { service, config } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    service.setEnabled(false)
    const result = await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }))
    expect(result).toBeNull()
  })

  it('returns null when no model is configured', async () => {
    const { service } = createService()
    const result = await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }))
    expect(result).toBeNull()
  })

  it('returns null for a disabled language', async () => {
    const { service, config } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    config.values['ai.inlineCompletion.disabledLanguages'] = ['json']
    const result = await provide(
      service,
      fakeMonacoModel({ value: '{}', cursorOffset: 1, languageId: 'json' }),
    )
    expect(result).toBeNull()
  })

  it('drops a stale model id that is no longer available', async () => {
    const { service, ai, config } = createService()
    config.values['ai.inlineCompletion.model'] = 'removed/group/model'
    ai.models = [MODEL]
    const result = await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }))
    expect(result).toBeNull()
  })

  it('produces a completion item from the model reply', async () => {
    const { service, ai, config } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    ai.reply = 'world'
    const result = await provide(service, fakeMonacoModel({ value: 'hello ', cursorOffset: 6 }))
    expect(result?.items[0]?.insertText).toBe('world')
    expect(ai.lastOptions?.modelId).toBe(MODEL.id)
    // Prefix/suffix are wrapped in the FIM-style user message.
    const user = ai.lastMessages?.find((m) => m.role === AiMessageRole.User)
    const text = user?.content[0]
    expect(text?.type === 'text' && text.value.includes('<|cursor|>')).toBe(true)
  })

  it('honors maxTokens from config', async () => {
    const { service, ai, config } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    config.values['ai.inlineCompletion.maxTokens'] = 42
    await provide(service, fakeMonacoModel({ value: 'hello ', cursorOffset: 6 }))
    expect(ai.lastOptions?.maxTokens).toBe(42)
  })

  it('returns null when cancelled before issuing the request', async () => {
    const { service, config } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    const cts = new CancellationTokenSource()
    cts.cancel()
    const result = await provide(
      service,
      fakeMonacoModel({ value: 'abc', cursorOffset: 3 }),
      EXPLICIT,
      cts.token,
    )
    expect(result).toBeNull()
  })

  it('persists the selected model id to the ai.inlineCompletion.model setting', async () => {
    const { service, config } = createService()
    await service.setModelId(MODEL.id)
    expect(config.values['ai.inlineCompletion.model']).toBe(MODEL.id)
    expect(await service.getModelId()).toBe(MODEL.id)

    // Clearing writes '' but reads back undefined.
    await service.setModelId(undefined)
    expect(config.values['ai.inlineCompletion.model']).toBe('')
    expect(await service.getModelId()).toBeUndefined()
  })

  it('surfaces a request failure as an error notification', async () => {
    const { service, ai, config, notification } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    ai.error = new AiError(AiErrorCode.QuotaExceeded, 'no balance')
    const result = await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }))
    expect(result).toBeNull()
    expect(notification.calls).toHaveLength(1)
    expect(notification.calls[0]?.severity).toBe(Severity.Error)
  })

  it('shows the same error only once until the next success', async () => {
    const { service, ai, config, notification } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    ai.error = new AiError(AiErrorCode.QuotaExceeded, 'no balance')
    const model = fakeMonacoModel({ value: 'abc', cursorOffset: 3 })
    await provide(service, model)
    await provide(service, model)
    expect(notification.calls).toHaveLength(1)

    // A success clears the de-dupe latch, so a later failure toasts again.
    ai.error = undefined
    await provide(service, model)
    ai.error = new AiError(AiErrorCode.QuotaExceeded, 'no balance')
    await provide(service, model)
    expect(notification.calls).toHaveLength(2)
  })

  it('does not notify when the request was cancelled', async () => {
    const { service, ai, config, notification } = createService()
    config.values['ai.inlineCompletion.model'] = MODEL.id
    ai.error = new AiError(AiErrorCode.NetworkError, 'aborted')
    const cts = new CancellationTokenSource()
    cts.cancel()
    await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }), EXPLICIT, cts.token)
    expect(notification.calls).toHaveLength(0)
  })
})
