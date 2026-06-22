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
  AiMessageRole,
  CancellationTokenSource,
  IAiModelService,
  ILoggerService,
  InstantiationType,
  createDecorator,
  createNamedLogger,
  getTextResponse,
  registerSingleton,
  type CancellationToken,
  type ILogger,
} from '@universe-editor/platform'

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
    token?: CancellationToken,
  ): Promise<string | undefined>
}

export const IAcpSessionTitleService =
  createDecorator<IAcpSessionTitleService>('acpSessionTitleService')

const MAX_INPUT_CHARS = 2000
const MAX_TITLE_CHARS = 60

const SYSTEM_PROMPT = [
  'You generate a concise title for a coding-assistant conversation.',
  'Rules:',
  '- Reply with ONLY the title, nothing else.',
  '- At most 6 words. No surrounding quotes, no trailing punctuation.',
  '- Use the same language as the user message.',
  '- Capture the core task/topic, not pleasantries.',
].join('\n')

export class AcpSessionTitleService implements IAcpSessionTitleService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, {
      id: 'acp.sessionTitle',
      name: 'ACP Session Title',
    })
  }

  async generateTitle(
    userText: string,
    agentText: string,
    token?: CancellationToken,
  ): Promise<string | undefined> {
    const modelId = await this._resolveModelId()
    if (!modelId) return undefined

    const user = clip(userText, MAX_INPUT_CHARS)
    if (user.length === 0) return undefined
    const agent = clip(agentText, MAX_INPUT_CHARS)

    const cts = new CancellationTokenSource(token)
    try {
      const response = this._aiModel.sendRequest(
        [
          { role: AiMessageRole.System, content: [{ type: 'text', value: SYSTEM_PROMPT }] },
          {
            role: AiMessageRole.User,
            content: [{ type: 'text', value: buildUserPrompt(user, agent) }],
          },
        ],
        { modelId, maxTokens: 32, temperature: 0.2, purpose: 'session-title' },
        cts.token,
      )
      const raw = await getTextResponse(response)
      const title = sanitizeTitle(raw)
      return title.length > 0 ? title : undefined
    } catch (err) {
      if (!cts.token.isCancellationRequested) {
        this._logger.warn(`session title generation failed: ${(err as Error).message}`)
      }
      return undefined
    } finally {
      cts.dispose()
    }
  }

  /** Returns the configured session-title model id only if it is currently available. */
  private async _resolveModelId(): Promise<string | undefined> {
    const chosen = await this._aiModel.getSessionTitleModelId()
    if (!chosen) return undefined
    const models = await this._aiModel.getModels()
    return models.some((m) => m.id === chosen) ? chosen : undefined
  }
}

function buildUserPrompt(userText: string, agentText: string): string {
  const parts = [`User message:\n${userText}`]
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
