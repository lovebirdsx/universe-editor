/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InlineCompletionService — drives Copilot-style ghost-text completions. It owns
 *  the runtime enable flag and the (separately persisted) completion model id,
 *  extracts prefix/suffix context around the cursor, asks IAiModelService to
 *  continue the text, and post-processes the reply into a Monaco inline
 *  completion. The Monaco-facing provider is a thin shell registered by
 *  InlineCompletionContribution; all policy lives here so it stays unit-testable
 *  without a real editor.
 *--------------------------------------------------------------------------------------------*/

import {
  AiErrorCode,
  AiMessageRole,
  CancellationTokenSource,
  Disposable,
  Emitter,
  IAiModelService,
  IConfigurationService,
  ILoggerService,
  INotificationService,
  Severity,
  createDecorator,
  getAiErrorCode,
  getTextResponse,
  localize,
  type AiMessage,
  type CancellationToken,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

const CONFIG = {
  enabled: 'ai.inlineCompletion.enabled',
  debounceDelay: 'ai.inlineCompletion.debounceDelay',
  prefixChars: 'ai.inlineCompletion.maxContextPrefixChars',
  suffixChars: 'ai.inlineCompletion.maxContextSuffixChars',
  maxTokens: 'ai.inlineCompletion.maxTokens',
  multiline: 'ai.inlineCompletion.multiline',
  disabledLanguages: 'ai.inlineCompletion.disabledLanguages',
} as const

const DEFAULTS = {
  enabled: true,
  debounceDelay: 300,
  prefixChars: 2000,
  suffixChars: 500,
  maxTokens: 128,
  multiline: true,
} as const

export interface IInlineCompletionService {
  readonly _serviceBrand: undefined
  /** Fires when enablement, the selected model, or the in-flight state changes. */
  readonly onDidChange: Event<void>
  /** Runtime on/off; seeded from config, toggled by the status bar / command. */
  readonly enabled: boolean
  /** True while a request is in flight (drives the status-bar spinner). */
  readonly requesting: boolean
  /** The completion model id from settings, or undefined when none is chosen. */
  getModelId(): Promise<string | undefined>
  setModelId(modelId: string | undefined): Promise<void>
  toggleEnabled(): void
  setEnabled(enabled: boolean): void
  /** The Monaco provider entry point. Returns null when nothing should be shown. */
  provide(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.InlineCompletionContext,
    token: CancellationToken,
  ): Promise<monaco.languages.InlineCompletions | null>
}

export const IInlineCompletionService =
  createDecorator<IInlineCompletionService>('inlineCompletionService')

// Monaco's enum is a const enum in the .d.ts; re-declare the one value we need
// to avoid a value import of the whole monaco namespace into this node-testable
// module.
const TRIGGER_KIND_AUTOMATIC = 0

export class InlineCompletionService extends Disposable implements IInlineCompletionService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  private readonly _logger: ILogger

  private _enabled: boolean
  private _requesting = false

  // Debounce + cancellation for the most recent automatic request.
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private _activeCts: CancellationTokenSource | undefined

  // De-dupe error toasts: automatic triggers fire on every keystroke, so a
  // persistent failure (no balance, bad key) would otherwise flood the screen.
  // We show one toast per distinct error and reset after any success.
  private _lastErrorKey: string | undefined

  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @INotificationService private readonly _notification: INotificationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'inlineCompletion', name: 'Inline Completion' })
    this._enabled = this._config.get<boolean>(CONFIG.enabled) ?? DEFAULTS.enabled
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG.enabled)) {
          this._enabled = this._config.get<boolean>(CONFIG.enabled) ?? DEFAULTS.enabled
          this._onDidChange.fire()
        }
      }),
    )
    // Keep the status bar / pick-model UI in sync when the completion model
    // selection changes — including the user hand-editing aiSettings.json.
    this._register(this._aiModel.onDidChangeInlineCompletionModel(() => this._onDidChange.fire()))
    // A model removed from aiSettings.json should stop being advertised.
    this._register(this._aiModel.onDidChangeModels(() => this._onDidChange.fire()))
    this._register({ dispose: () => this._cancelInFlight() })
  }

  get enabled(): boolean {
    return this._enabled
  }

  get requesting(): boolean {
    return this._requesting
  }

  getModelId(): Promise<string | undefined> {
    return this._aiModel.getInlineCompletionModelId()
  }

  setModelId(modelId: string | undefined): Promise<void> {
    return this._aiModel.setInlineCompletionModelId(modelId)
  }

  toggleEnabled(): void {
    this.setEnabled(!this._enabled)
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return
    this._enabled = enabled
    if (!enabled) this._cancelInFlight()
    this._onDidChange.fire()
  }

  async provide(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.InlineCompletionContext,
    token: CancellationToken,
  ): Promise<monaco.languages.InlineCompletions | null> {
    if (!this._enabled) return null
    if (token.isCancellationRequested) return null

    const disabled = this._config.get<readonly string[]>(CONFIG.disabledLanguages) ?? []
    if (disabled.includes(model.getLanguageId())) return null

    const modelId = await this._resolveModelId()
    if (!modelId) return null

    const automatic = context.triggerKind === TRIGGER_KIND_AUTOMATIC
    if (automatic) {
      const delay = this._config.get<number>(CONFIG.debounceDelay) ?? DEFAULTS.debounceDelay
      const waited = await this._debounce(delay, token)
      if (!waited || token.isCancellationRequested) return null
    }

    const prompt = this._buildPrompt(model, position)
    if (prompt === null) return null

    const cts = new CancellationTokenSource()
    const tokenSub = token.onCancellationRequested(() => cts.cancel())
    this._cancelInFlight()
    this._activeCts = cts
    this._setRequesting(true)

    let text: string
    try {
      const response = this._aiModel.sendRequest(
        prompt.messages,
        {
          modelId,
          maxTokens: this._config.get<number>(CONFIG.maxTokens) ?? DEFAULTS.maxTokens,
          purpose: 'inline-completion',
        },
        cts.token,
      )
      text = await getTextResponse(response)
      this._lastErrorKey = undefined
    } catch (err) {
      if (!cts.token.isCancellationRequested) {
        this._logger.warn('inline completion failed', err)
        this._notifyError(err, modelId)
      }
      return null
    } finally {
      tokenSub.dispose()
      if (this._activeCts === cts) {
        this._activeCts = undefined
        this._setRequesting(false)
      }
      cts.dispose()
    }

    if (token.isCancellationRequested) return null

    const multiline = this._config.get<boolean>(CONFIG.multiline) ?? DEFAULTS.multiline
    const insertText = sanitizeCompletion(text, prompt.suffix, multiline)
    if (!insertText) return null

    return {
      items: [{ insertText, range: this._cursorRange(position) }],
      enableForwardStability: true,
    }
  }

  private async _resolveModelId(): Promise<string | undefined> {
    const chosen = await this.getModelId()
    if (!chosen) return undefined
    // Drop a stale selection (model removed from aiSettings.json).
    const models = await this._aiModel.getModels()
    return models.some((m) => m.id === chosen) ? chosen : undefined
  }

  private _debounce(delay: number, token: CancellationToken): Promise<boolean> {
    if (this._debounceTimer !== undefined) clearTimeout(this._debounceTimer)
    return new Promise<boolean>((resolve) => {
      const sub = token.onCancellationRequested(() => {
        if (this._debounceTimer !== undefined) clearTimeout(this._debounceTimer)
        this._debounceTimer = undefined
        sub.dispose()
        resolve(false)
      })
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined
        sub.dispose()
        resolve(true)
      }, delay)
    })
  }

  private _buildPrompt(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): { messages: AiMessage[]; suffix: string } | null {
    const prefixChars = this._config.get<number>(CONFIG.prefixChars) ?? DEFAULTS.prefixChars
    const suffixChars = this._config.get<number>(CONFIG.suffixChars) ?? DEFAULTS.suffixChars

    const full = model.getValue()
    const offset = model.getOffsetAt(position)
    const prefix = full.slice(Math.max(0, offset - prefixChars), offset)
    const suffix = full.slice(offset, offset + suffixChars)
    if (prefix.trim().length === 0 && suffix.trim().length === 0) return null

    const messages: AiMessage[] = [
      {
        role: AiMessageRole.System,
        content: [{ type: 'text', value: SYSTEM_PROMPT }],
      },
      {
        role: AiMessageRole.User,
        content: [
          {
            type: 'text',
            value: `<|prefix|>${prefix}<|cursor|>${suffix}<|suffix|>`,
          },
        ],
      },
    ]
    return { messages, suffix }
  }

  private _cursorRange(position: monaco.Position): monaco.IRange {
    return {
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    }
  }

  private _setRequesting(value: boolean): void {
    if (this._requesting === value) return
    this._requesting = value
    this._onDidChange.fire()
  }

  private _cancelInFlight(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = undefined
    }
    if (this._activeCts) {
      this._activeCts.cancel()
      this._activeCts = undefined
      this._setRequesting(false)
    }
  }

  private _notifyError(err: unknown, modelId: string): void {
    const message = err instanceof Error ? err.message : String(err)
    const code = getAiErrorCode(err)
    // One toast per distinct failure (keyed by model too, so switching the
    // completion model surfaces its own error); cleared on the next success.
    const key = `${modelId}:${code ?? 'unknown'}:${message}`
    if (key === this._lastErrorKey) return
    this._lastErrorKey = key

    this._notification.notify({
      severity: Severity.Error,
      message: localize('inlineCompletion.error', 'Inline completion failed for model "{0}": {1}', {
        0: modelId,
        1: describeAiError(code, message),
      }),
      actions: [
        {
          label: localize('inlineCompletion.error.disable', 'Disable'),
          run: () => this.setEnabled(false),
        },
      ],
    })
  }
}

function describeAiError(code: AiErrorCode | undefined, message: string): string {
  switch (code) {
    case AiErrorCode.Unauthorized:
      return localize('inlineCompletion.error.unauthorized', 'API key rejected (check your key)')
    case AiErrorCode.RateLimited:
      return localize('inlineCompletion.error.rateLimited', 'Rate limited, try again later')
    case AiErrorCode.QuotaExceeded:
      return localize('inlineCompletion.error.quota', 'Quota or balance exhausted')
    case AiErrorCode.NetworkError:
      return localize('inlineCompletion.error.network', 'Network error reaching the provider')
    case AiErrorCode.ConfigurationRequired:
      return localize('inlineCompletion.error.config', 'The completion model needs configuration')
    case AiErrorCode.ModelNotFound:
      return localize('inlineCompletion.error.model', 'The selected completion model is missing')
    default:
      return message
  }
}

const SYSTEM_PROMPT = [
  'You are an inline text completion engine, like GitHub Copilot.',
  'The user message contains the document around the cursor: text before the',
  'cursor is wrapped as <|prefix|>…<|cursor|>, text after as <|cursor|>…<|suffix|>.',
  'Your output is inserted verbatim at the cursor, immediately after the prefix.',
  'If the completion should begin on a new line (for example a new list item, a',
  'new statement, or a new paragraph), your output MUST start with a newline',
  'character — otherwise it is glued onto the end of the current line.',
  'Output ONLY the raw text to insert — no explanations, no markdown code fences,',
  'no repetition of the surrounding text. Keep it focused; use multiple lines only',
  'when natural. If nothing should be inserted, output nothing.',
].join(' ')

/**
 * Clean a model reply into insertable text: strip code fences the model may wrap
 * around its answer, drop a tail that merely repeats the suffix, and collapse to
 * a single line when multiline is off. Exported for unit tests.
 */
export function sanitizeCompletion(raw: string, suffix: string, multiline: boolean): string {
  let text = stripCodeFence(raw)
  // Models sometimes echo the suffix back; if our reply ends with the start of
  // the existing suffix, trim that overlap so we don't duplicate it.
  text = trimSuffixOverlap(text, suffix)
  if (!multiline) {
    const nl = text.indexOf('\n')
    if (nl !== -1) text = text.slice(0, nl)
  }
  // Never offer a pure-whitespace completion.
  return text.trim().length === 0 ? '' : text
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return raw
  const lines = trimmed.split('\n')
  lines.shift() // opening ``` (optionally with a language tag)
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === '```') lines.pop()
  return lines.join('\n')
}

function trimSuffixOverlap(text: string, suffix: string): string {
  const head = suffix.trimStart()
  if (head.length === 0) return text
  // Largest k such that text ends with the first k chars of the suffix.
  const max = Math.min(text.length, head.length)
  for (let k = max; k > 0; k--) {
    if (text.endsWith(head.slice(0, k))) return text.slice(0, text.length - k)
  }
  return text
}
