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
import type { IRecentEdit, IRecentEditsTracker } from '../RecentEditsTracker.js'

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
  inlineModelId: string | undefined
  private readonly _onDidChangeModels = new Emitter<void>()
  readonly onDidChangeModels = this._onDidChangeModels.event
  private readonly _onDidChangeInlineCompletionModel = new Emitter<void>()
  readonly onDidChangeInlineCompletionModel = this._onDidChangeInlineCompletionModel.event

  getModels(): Promise<readonly AiModelMetadata[]> {
    return Promise.resolve(this.models)
  }
  getInlineCompletionModelId(): Promise<string | undefined> {
    return Promise.resolve(this.inlineModelId)
  }
  setInlineCompletionModelId(modelId: string | undefined): Promise<void> {
    this.inlineModelId = modelId
    this._onDidChangeInlineCompletionModel.fire()
    return Promise.resolve()
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

class FakeRecentEditsTracker implements IRecentEditsTracker {
  declare readonly _serviceBrand: undefined
  edits: IRecentEdit[] = []
  record(): void {}
  getRecentEdits(): readonly IRecentEdit[] {
    return this.edits
  }
  clear(): void {
    this.edits = []
  }
}

interface FakeModelOptions {
  value: string
  cursorOffset: number
  languageId?: string
}

function fakeMonacoModel(opts: FakeModelOptions) {
  const lines = opts.value.split('\n')
  return {
    uri: { toString: () => 'file:///test' },
    getValue: () => opts.value,
    getLanguageId: () => opts.languageId ?? 'plaintext',
    getOffsetAt: () => opts.cursorOffset,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getValueInRange: (range: { startLineNumber: number; endLineNumber: number }) =>
      lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n'),
  }
}

const POSITION = { lineNumber: 1, column: 1 } as never
const EXPLICIT = { triggerKind: 1 } as never
const EXPLICIT_NES = { triggerKind: 1, includeInlineEdits: true } as never

function createService(overrides?: {
  ai?: FakeAiModel
  config?: FakeConfig
  notification?: FakeNotification
  recentEdits?: FakeRecentEditsTracker
}) {
  const ai = overrides?.ai ?? new FakeAiModel()
  const config = overrides?.config ?? new FakeConfig()
  const notification = overrides?.notification ?? new FakeNotification()
  const recentEdits = overrides?.recentEdits ?? new FakeRecentEditsTracker()
  const service = new InlineCompletionService(
    ai as unknown as IAiModelService,
    config as unknown as IConfigurationService,
    notification as unknown as INotificationService,
    FAKE_LOGGER_SERVICE,
    recentEdits,
  )
  return { service, ai, config, notification, recentEdits }
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

  it('prepends a newline when the directive declares true', () => {
    expect(sanitizeCompletion('<|newline|>true\nconst a = 1', '', true)).toBe('\nconst a = 1')
  })

  it('keeps the completion on the current line when the directive declares false', () => {
    expect(sanitizeCompletion('<|newline|>false\nconst a = 1', '', true)).toBe('const a = 1')
  })

  it('ignores a leaked leading newline in the body, trusting the directive', () => {
    // Directive says false but the model still emitted a stray newline → strip it.
    expect(sanitizeCompletion('<|newline|>false\n\n  x', '', true)).toBe('x')
    // Directive says true and the model also added its own newline → collapse to one.
    expect(sanitizeCompletion('<|newline|>true\n\nx', '', true)).toBe('\nx')
  })

  it('parses the directive case-insensitively with surrounding whitespace', () => {
    expect(sanitizeCompletion('  <|newline|> TRUE \nfoo', '', true)).toBe('\nfoo')
  })

  it('keeps body glued onto the directive line (no separating newline)', () => {
    // Real model output: `<|newline|>false孟浩然` — directive and body share a line.
    expect(sanitizeCompletion('<|newline|>false孟浩然', '', true)).toBe('孟浩然')
    expect(sanitizeCompletion('<|newline|>true孟浩然', '', true)).toBe('\n孟浩然')
  })

  it('applies the directive before code-fence stripping and suffix trim', () => {
    expect(sanitizeCompletion('<|newline|>true\n```ts\nfoobar\n```', 'bar baz', true)).toBe('\nfoo')
  })

  it('returns empty when the directive is present but the body is blank', () => {
    expect(sanitizeCompletion('<|newline|>false\n', '', true)).toBe('')
    expect(sanitizeCompletion('<|newline|>true\n   ', '', true)).toBe('')
  })

  it('falls back to honoring a leading newline when the directive is absent', () => {
    // Older/weaker models without the directive: keep the historical behavior.
    expect(sanitizeCompletion('\nconst a = 1', '', true)).toBe('\nconst a = 1')
  })
})

describe('InlineCompletionService.provide', () => {
  it('returns null when the feature is disabled', async () => {
    const { service, ai } = createService()
    ai.inlineModelId = MODEL.id
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
    const { service, ai, config } = createService()
    ai.inlineModelId = MODEL.id
    config.values['ai.inlineCompletion.disabledLanguages'] = ['json']
    const result = await provide(
      service,
      fakeMonacoModel({ value: '{}', cursorOffset: 1, languageId: 'json' }),
    )
    expect(result).toBeNull()
  })

  it('drops a stale model id that is no longer available', async () => {
    const { service, ai } = createService()
    ai.inlineModelId = 'removed/group/model'
    ai.models = [MODEL]
    const result = await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }))
    expect(result).toBeNull()
  })

  it('produces a completion item from the model reply', async () => {
    const { service, ai } = createService()
    ai.inlineModelId = MODEL.id
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
    ai.inlineModelId = MODEL.id
    config.values['ai.inlineCompletion.maxTokens'] = 42
    await provide(service, fakeMonacoModel({ value: 'hello ', cursorOffset: 6 }))
    expect(ai.lastOptions?.maxTokens).toBe(42)
  })

  it('returns null when cancelled before issuing the request', async () => {
    const { service, ai } = createService()
    ai.inlineModelId = MODEL.id
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

  it('persists the selected model id through the AI facade (aiSettings.json)', async () => {
    const { service, ai } = createService()
    await service.setModelId(MODEL.id)
    expect(ai.inlineModelId).toBe(MODEL.id)
    expect(await service.getModelId()).toBe(MODEL.id)

    await service.setModelId(undefined)
    expect(ai.inlineModelId).toBeUndefined()
    expect(await service.getModelId()).toBeUndefined()
  })

  it('surfaces a request failure as an error notification', async () => {
    const { service, ai, notification } = createService()
    ai.inlineModelId = MODEL.id
    ai.error = new AiError(AiErrorCode.QuotaExceeded, 'no balance')
    const result = await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }))
    expect(result).toBeNull()
    expect(notification.calls).toHaveLength(1)
    expect(notification.calls[0]?.severity).toBe(Severity.Error)
  })

  it('shows the same error only once until the next success', async () => {
    const { service, ai, notification } = createService()
    ai.inlineModelId = MODEL.id
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
    const { service, ai, notification } = createService()
    ai.inlineModelId = MODEL.id
    ai.error = new AiError(AiErrorCode.NetworkError, 'aborted')
    const cts = new CancellationTokenSource()
    cts.cancel()
    await provide(service, fakeMonacoModel({ value: 'abc', cursorOffset: 3 }), EXPLICIT, cts.token)
    expect(notification.calls).toHaveLength(0)
  })
})

describe('InlineCompletionService NES mode', () => {
  function enableNes(config: FakeConfig): void {
    config.values['ai.nes.enabled'] = true
  }

  it('falls back to ghost text when NES is disabled', async () => {
    const { service, ai } = createService()
    ai.inlineModelId = MODEL.id
    ai.reply = 'world'
    // includeInlineEdits true but feature off → plain continuation.
    const result = await provide(
      service,
      fakeMonacoModel({ value: 'hello ', cursorOffset: 6 }),
      EXPLICIT_NES,
    )
    expect(result?.items[0]?.insertText).toBe('world')
    expect(result?.items[0]).not.toHaveProperty('isInlineEdit')
  })

  it('produces an inline-edit item from a JSON reply', async () => {
    const config = new FakeConfig()
    enableNes(config)
    const { service, ai } = createService({ config })
    ai.inlineModelId = MODEL.id
    ai.reply = '{"edits":[{"startLine":1,"endLine":2,"newText":"const a = 2"}]}'
    const model = fakeMonacoModel({ value: 'const a = 1\nfoo()', cursorOffset: 0 })
    const result = await provide(service, model, EXPLICIT_NES)
    const item = result?.items[0]
    expect(item?.insertText).toBe('const a = 2')
    expect((item as { isInlineEdit?: boolean })?.isInlineEdit).toBe(true)
    expect(item?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 6, // 'foo()'.length + 1
    })
  })

  it('merges multiple edits into one span, keeping gap lines verbatim', async () => {
    const config = new FakeConfig()
    enableNes(config)
    const { service, ai } = createService({ config })
    ai.inlineModelId = MODEL.id
    // Rename `count` → `total` on lines 1 and 3; line 2 is untouched.
    ai.reply =
      '{"edits":[{"startLine":1,"endLine":1,"newText":"let total = 0"},' +
      '{"startLine":3,"endLine":3,"newText":"return total"}]}'
    const model = fakeMonacoModel({
      value: 'let count = 0\nuse(count)\nreturn count',
      cursorOffset: 0,
    })
    const result = await provide(service, model, EXPLICIT_NES)
    const item = result?.items[0]
    expect((item as { isInlineEdit?: boolean })?.isInlineEdit).toBe(true)
    // One item spanning lines 1–3, the unchanged middle line kept verbatim.
    expect(item?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 13, // 'return count'.length + 1
    })
    expect(item?.insertText).toBe('let total = 0\nuse(count)\nreturn total')
  })

  it('returns null on a noEdit reply when fallback is off', async () => {
    const config = new FakeConfig()
    enableNes(config)
    config.values['ai.nes.fallbackToCompletion'] = false
    const { service, ai } = createService({ config })
    ai.inlineModelId = MODEL.id
    ai.reply = '{"noEdit":true}'
    const result = await provide(
      service,
      fakeMonacoModel({ value: 'const a = 1', cursorOffset: 0 }),
      EXPLICIT_NES,
    )
    expect(result).toBeNull()
  })

  it('skips NES on automatic triggers with no recent edits', async () => {
    const config = new FakeConfig()
    enableNes(config)
    config.values['ai.nes.fallbackToCompletion'] = false
    config.values['ai.inlineCompletion.debounceDelay'] = 0
    config.values['ai.nes.debounceDelay'] = 0
    const { service, ai } = createService({ config })
    ai.inlineModelId = MODEL.id
    ai.reply = '{"edits":[{"startLine":1,"endLine":1,"newText":"x"}]}'
    const ctx = { triggerKind: 0, includeInlineEdits: true } as never
    const result = await provide(
      service,
      fakeMonacoModel({ value: 'const a = 1', cursorOffset: 0 }),
      ctx,
    )
    expect(result).toBeNull()
  })

  it('drops a no-op edit that restates the current lines', async () => {
    const config = new FakeConfig()
    enableNes(config)
    config.values['ai.nes.fallbackToCompletion'] = false
    const { service, ai } = createService({ config })
    ai.inlineModelId = MODEL.id
    ai.reply = '{"edits":[{"startLine":1,"endLine":1,"newText":"const a = 1"}]}'
    const result = await provide(
      service,
      fakeMonacoModel({ value: 'const a = 1', cursorOffset: 0 }),
      EXPLICIT_NES,
    )
    expect(result).toBeNull()
  })
})
