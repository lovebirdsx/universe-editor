/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionTitleService — generates a short, friendly title for an ACP session
 *  from its opening exchange using the user-selected `sessionTitle` model. The
 *  Claude Agent SDK does not expose the interactive CLI's auto-title, so we
 *  synthesize one ourselves. Best-effort: when no usable model is configured (or
 *  the request fails) it returns undefined and callers keep the existing
 *  first-prompt-derived title.
 *--------------------------------------------------------------------------------------------*/

import {
  AiErrorCode,
  AiMessageRole,
  CancellationTokenSource,
  getAiErrorCode,
  ICommandService,
  IAiModelService,
  ILoggerService,
  INotificationService,
  IStorageService,
  InstantiationType,
  Severity,
  StorageScope,
  createDecorator,
  createNamedLogger,
  getTextResponse,
  localize,
  registerSingleton,
  type CancellationToken,
  type ILogger,
} from '@universe-editor/platform'

/** Extra conversation context a generated title should reflect. */
export interface AcpSessionTitleContext {
  /**
   * Excerpt the user pulled aside into a side task — the actual subject of the
   * discussion. The bare question alone ("why is this wrong?") doesn't say what
   * "this" is, so the excerpt grounds the title.
   */
  readonly quotedText?: string
}

export interface IAcpSessionTitleService {
  readonly _serviceBrand: undefined
  /**
   * Produce a short title (<= ~6 words) summarizing the opening exchange, or
   * undefined when no session-title model is configured/available or generation
   * fails. Never throws.
   */
  generateTitle(
    userText: string,
    agentText: string,
    options?: { token?: CancellationToken; context?: AcpSessionTitleContext },
  ): Promise<string | undefined>
}

export const IAcpSessionTitleService =
  createDecorator<IAcpSessionTitleService>('acpSessionTitleService')

const MAX_INPUT_CHARS = 2000
const MAX_TITLE_CHARS = 60
const NO_MODEL_HINT_KEY = 'acp.sessionTitle.noModelHintShown'
const OUTPUT_LIMIT_HINT_KEY = 'acp.sessionTitle.outputLimitHintShown'

const SYSTEM_PROMPT = [
  'You generate a concise title for a coding-assistant conversation.',
  'Rules:',
  '- Reply with ONLY the title, nothing else.',
  '- At most 6 words. No surrounding quotes, no trailing punctuation.',
  '- Use the same language as the user message.',
  '- Capture the core task/topic, not pleasantries.',
  '- If an excerpt is provided, the user is asking about that excerpt — capture what they want to know about it.',
].join('\n')

export class AcpSessionTitleService implements IAcpSessionTitleService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @ILoggerService loggerService: ILoggerService,
    @INotificationService private readonly _notification: INotificationService,
    @IStorageService private readonly _storage: IStorageService,
    @ICommandService private readonly _commands: ICommandService,
  ) {
    this._logger = createNamedLogger(loggerService, {
      id: 'acp.sessionTitle',
      name: 'ACP Session Title',
    })
  }

  async generateTitle(
    userText: string,
    agentText: string,
    options?: { token?: CancellationToken; context?: AcpSessionTitleContext },
  ): Promise<string | undefined> {
    const modelId = await this._resolveModelId()
    if (!modelId) return undefined

    const user = clip(userText, MAX_INPUT_CHARS)
    if (user.length === 0) return undefined
    const agent = clip(agentText, MAX_INPUT_CHARS)
    const quote = clip(options?.context?.quotedText ?? '', MAX_INPUT_CHARS)

    const cts = new CancellationTokenSource(options?.token)
    try {
      const response = this._aiModel.sendRequest(
        [
          { role: AiMessageRole.System, content: [{ type: 'text', value: SYSTEM_PROMPT }] },
          {
            role: AiMessageRole.User,
            content: [{ type: 'text', value: buildTitlePrompt(user, agent, quote) }],
          },
        ],
        { modelId, maxTokens: 32, temperature: 0.2, purpose: 'session-title' },
        cts.token,
      )
      const raw = await getTextResponse(response)
      const title = sanitizeTitle(raw)
      if (title.length === 0) {
        this._logger.debug(
          `session title generation returned an unusable response: ${raw.slice(0, 120)}`,
        )
        return undefined
      }
      return title
    } catch (err) {
      if (!cts.token.isCancellationRequested) {
        this._logger.warn(`session title generation failed: ${(err as Error).message}`)
        if (getAiErrorCode(err) === AiErrorCode.OutputLimit) {
          await this._maybeShowOutputLimitHint()
        }
      }
      return undefined
    } finally {
      cts.dispose()
    }
  }

  /** Returns the configured session-title model id only if it is currently available. */
  private async _resolveModelId(): Promise<string | undefined> {
    const chosen = await this._aiModel.getSessionTitleModelId()
    if (!chosen) {
      this._logger.debug('no session-title model configured; skipping title generation')
      await this._maybeShowNoModelHint()
      return undefined
    }
    const models = await this._aiModel.getModels()
    if (!models.some((m) => m.id === chosen)) {
      this._logger.debug(
        `session-title model '${chosen}' not in the available model list; skipping`,
      )
      return undefined
    }
    return chosen
  }

  /**
   * One-time nudge to pick a session-title model. The flag is written before
   * notifying so re-armed concurrent calls cannot double-toast.
   */
  private async _maybeShowNoModelHint(): Promise<void> {
    try {
      const shown = await this._storage.get<boolean>(NO_MODEL_HINT_KEY, StorageScope.GLOBAL)
      if (shown) return
      await this._storage.set(NO_MODEL_HINT_KEY, true, StorageScope.GLOBAL)
      this._notification.notify({
        severity: Severity.Info,
        message: localize(
          'acp.sessionTitle.noModelHint',
          'No session title model configured — AI sessions will use their first message as the title. Pick a model to generate more fitting titles automatically.',
        ),
        actions: [
          {
            label: localize('acp.sessionTitle.selectModel', 'Select Model'),
            run: () => {
              void this._commands.executeCommand('ai.sessionTitle.pickModel')
            },
          },
        ],
      })
    } catch (err) {
      this._logger.debug(`no-model hint failed: ${(err as Error).message}`)
    }
  }

  /**
   * One-time nudge when the title request hit the output limit with zero text
   * (the model's thinking consumed the whole budget). Points at the fix: the
   * model's thinking parameter, configurable in AI Settings.
   */
  private async _maybeShowOutputLimitHint(): Promise<void> {
    try {
      const shown = await this._storage.get<boolean>(OUTPUT_LIMIT_HINT_KEY, StorageScope.GLOBAL)
      if (shown) return
      await this._storage.set(OUTPUT_LIMIT_HINT_KEY, true, StorageScope.GLOBAL)
      this._notification.notify({
        severity: Severity.Warning,
        message: localize(
          'acp.sessionTitle.outputLimitHint',
          'Session title generation hit the output token limit before producing any text — the model\'s thinking (reasoning) consumed the whole budget. Open AI Settings and set this model\'s "thinking" parameter to "disabled", or raise the request\'s token limit.',
        ),
        actions: [
          {
            label: localize('acp.sessionTitle.openAiSettings', 'Open AI Settings'),
            run: () => {
              void this._commands.executeCommand('ai.manageModels')
            },
          },
        ],
      })
    } catch (err) {
      this._logger.debug(`output-limit hint failed: ${(err as Error).message}`)
    }
  }
}

/** Exported for tests. `quotedText` (side-task excerpt) leads when present. */
export function buildTitlePrompt(userText: string, agentText: string, quotedText = ''): string {
  const parts: string[] = []
  if (quotedText.length > 0) {
    parts.push(`Excerpt the user pulled aside to discuss:\n${quotedText}`)
  }
  parts.push(`User message:\n${userText}`)
  if (agentText.length > 0) parts.push(`Assistant reply:\n${agentText}`)
  parts.push('Title:')
  return parts.join('\n\n')
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? t.slice(0, max) : t
}

/** Strip quotes/markdown/trailing punctuation a model may wrap the title in. */
export function sanitizeTitle(raw: string): string {
  let s = raw.trim()
  // Models sometimes emit a leading label or a code fence — take the first line.
  const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0)
  s = (firstLine ?? '').trim()
  // Drop surrounding matching quotes/backticks.
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '')
  // Drop a leading "Title:" style label if the model added one.
  s = s.replace(/^title\s*[:：]\s*/i, '')
  s = s.replace(/\s+/g, ' ').trim()
  // Drop trailing sentence punctuation.
  s = s.replace(/[.。!！?？,，;；:：]+$/, '').trim()
  return s.length > MAX_TITLE_CHARS ? `${s.slice(0, MAX_TITLE_CHARS - 1)}…` : s
}

registerSingleton(IAcpSessionTitleService, AcpSessionTitleService, InstantiationType.Delayed)
