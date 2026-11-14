/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer side of an agent-trigger run: creates the unattended session,
 *  verifies it actually landed in the requested (conservative) mode, sends the
 *  rendered prompt, and reports the terminal outcome back to main. The budget /
 *  timeout watchdog lives in automatedRunWatcher.ts. Design §3.4 / §5.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  IFileService,
  ILoggerService,
  InstantiationType,
  URI,
  createDecorator,
  fsPathToWorkspaceUri,
  registerSingleton,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { IAcpAgentRegistry } from '../acp/acpAgentRegistry.js'
import { supportsSystemPromptAppend } from '../acp/agentPromptCapabilities.js'
import { isSessionModeCategory } from '../acp/configOptionLabel.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import type { IAcpSession } from '../acp/session/acpSessionModel.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { TRIGGER_OUTPUT_CONTRACT_SYSTEM } from '../../../shared/triggers/promptTemplate.js'
import {
  CONSERVATIVE_MODE_BY_AGENT,
  isElevatedModeId,
  type TriggerRunEnd,
  type TriggerRunRequest,
} from '../../../shared/triggers/types.js'
import {
  AutomatedRunWatcher,
  defaultAutomatedVerdictResolver,
  type AutomatedVerdictResolution,
  type AutomatedVerdictResolver,
} from './automatedRunWatcher.js'

export interface AutomatedRunStartResult {
  readonly sessionId: string
}

export interface IAutomatedSessionService {
  readonly _serviceBrand: undefined
  /** Fired exactly once per started run, after the history row was updated. */
  readonly onDidEndRun: Event<TriggerRunEnd>
  /**
   * Create (inactive) + connect an automated session, verify its mode, dispatch
   * the prompt, and arm the watchdog. Resolves once the prompt was dispatched,
   * not when the turn ends — the outcome arrives via {@link onDidEndRun}.
   */
  startAutomatedSession(request: TriggerRunRequest): Promise<AutomatedRunStartResult>
  /** Cancel an in-flight run (logs `cancelled` when it was still running). */
  cancelRun(runId: string): void
  /**
   * Extension point for the P2 verdict parser / action executor. Pass undefined
   * to restore the default (no verdict, no actions).
   */
  setVerdictResolver(resolver: AutomatedVerdictResolver | undefined): void
}

export const IAutomatedSessionService =
  createDecorator<IAutomatedSessionService>('automatedSessionService')

interface ActiveRun {
  readonly session: IAcpSession
  readonly watcher: AutomatedRunWatcher
}

/** Case-insensitive + trimmed comparison of two agent mode ids. */
function sameMode(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** Wrap text in a backtick fence longer than any run of backticks inside it. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}\n${text}\n${ticks}`
}

/** The mode the agent actually applied, resolved by config id then mode category. */
export function readSessionModeId(session: {
  readonly configOptions: { get(): readonly SessionConfigOption[] }
}): string | undefined {
  const options = session.configOptions.get()
  const option =
    options.find((o) => o.id === 'mode') ?? options.find((o) => isSessionModeCategory(o.category))
  if (option === undefined || option.type !== 'select') return undefined
  return option.currentValue
}

export class AutomatedSessionService extends Disposable implements IAutomatedSessionService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidEndRun = this._register(new Emitter<TriggerRunEnd>())
  readonly onDidEndRun: Event<TriggerRunEnd> = this._onDidEndRun.event

  private readonly _runs = new Map<string, ActiveRun>()
  private readonly _logger: ILogger
  private _verdictResolver: AutomatedVerdictResolver = defaultAutomatedVerdictResolver

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IFileService private readonly _files: IFileService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'triggerSessions', name: 'Triggers' })
  }

  setVerdictResolver(resolver: AutomatedVerdictResolver | undefined): void {
    this._verdictResolver = resolver ?? defaultAutomatedVerdictResolver
  }

  async startAutomatedSession(request: TriggerRunRequest): Promise<AutomatedRunStartResult> {
    const runId = request.origin.runId
    if (this._runs.has(runId)) throw new Error(`Trigger run ${runId} is already started`)
    const agentId = request.agentId ?? this._registry.defaultAgentId()
    const requestedMode = request.mode?.trim() ?? CONSERVATIVE_MODE_BY_AGENT[agentId]
    // No explicit mode and no known conservative default: accepting whatever the
    // agent starts with would let an unattended run inherit a permissive mode.
    if (requestedMode === undefined || requestedMode.length === 0) {
      throw new Error('未知 agent 需在触发器中显式配置 mode')
    }
    if (isElevatedModeId(requestedMode) && !request.allowElevatedMode) {
      throw new Error(
        `Refusing elevated mode "${requestedMode}" for trigger ${request.origin.triggerId}: confirmation missing`,
      )
    }
    const configDesiredOverrides: Record<string, string> = {
      ...(requestedMode !== undefined ? { mode: requestedMode } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
    }
    // Resolved after the mode gates so an unknown agent without an explicit
    // mode still gets the actionable "configure mode" error.
    const descriptor = this._registry.get(agentId)
    const appendSystemContract = supportsSystemPromptAppend(descriptor)
    const firstPrompt = appendSystemContract ? request.promptForSystemContract : request.prompt
    this._logger.debug(
      `trigger run ${runId} agent=${agentId} outputContract=${
        appendSystemContract ? 'system+inline-runDir' : 'inline'
      }`,
    )
    const session = await this._sessions.createSession(agentId, {
      cwd: request.cwd,
      // The run's own host, not the window's: this window may show a local
      // workspace while a remote workspace's trigger is dispatching here.
      ...(request.authority !== undefined ? { authority: request.authority } : {}),
      activate: false,
      // Not `internal`: an automated session is persisted and listed so the
      // user can inspect what the trigger did.
      title: `${request.origin.triggerName} · ${request.origin.eventKey}`,
      automation: request.origin,
      automationRunDir: request.runDir,
      additionalDirectories: [request.runDir],
      ...(appendSystemContract ? { systemPromptAppend: TRIGGER_OUTPUT_CONTRACT_SYSTEM } : {}),
      ...(request.mcpServerNames !== undefined ? { mcpServerNames: request.mcpServerNames } : {}),
      ...(Object.keys(configDesiredOverrides).length > 0 ? { configDesiredOverrides } : {}),
    })

    try {
      await session.whenConnected()
      if (session.status.get() === 'errored') {
        throw new Error('Automated session failed to connect')
      }
      await session.whenConfigOptionsSettled()
      const actualMode = readSessionModeId(session)
      // Mode ids are agent-defined case conventions; a case/whitespace diff is
      // not a mismatch, but any other divergence means the agent ignored the pin.
      if (actualMode === undefined || !sameMode(actualMode, requestedMode)) {
        throw new Error(
          `Automated session mode mismatch: requested ${requestedMode}, agent applied ${actualMode ?? '(unknown)'}`,
        )
      }
    } catch (err) {
      this._logger.warn(`automated session setup failed: ${(err as Error).message}`)
      await session.close().catch(() => undefined)
      throw err
    }

    // History rows (and `TriggerRunEnd.sessionId`) key on the agent-issued
    // durable id, never the local uuid the UI briefly holds.
    const durableSessionId = session.sessionIdOnAgent.get()
    if (durableSessionId === undefined) {
      this._logger.warn('automated session setup failed: missing durable session id')
      await session.close().catch(() => undefined)
      throw new Error('Automated session did not report a durable session id')
    }

    const watcher = new AutomatedRunWatcher({
      request,
      session,
      readResultFile: (runRequest) => this._readResultFile(runRequest),
      resolveVerdict: this._verdictResolver,
      onRunEnd: (end, resolution) => this._handleRunEnd(end, resolution),
      logger: this._logger,
    })
    this._runs.set(runId, { session, watcher })
    watcher.start()
    // Audit copy only — nothing reads it back. Written before the first prompt
    // so the directory always shows what the agent was actually given.
    await this._writePromptAudit(request, firstPrompt, appendSystemContract)
    void session.sendPrompt(firstPrompt).then(
      () => watcher.notifyTurnSettled(),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this._logger.warn(`automated prompt failed: ${message}`)
        watcher.notifyTurnFailed(message)
      },
    )
    return { sessionId: durableSessionId }
  }

  cancelRun(runId: string): void {
    this._runs.get(runId)?.watcher.cancel()
  }

  override dispose(): void {
    for (const run of this._runs.values()) run.watcher.dispose()
    this._runs.clear()
    super.dispose()
  }

  /**
   * Best-effort `<runDir>/prompt.md`: the system prompt append actually used
   * (or a note that the contract was inline) plus the exact first message.
   * Purely an audit copy, so a failure only warns.
   */
  private async _writePromptAudit(
    request: TriggerRunRequest,
    firstPrompt: string,
    systemContract: boolean,
  ): Promise<void> {
    const appendSection = systemContract
      ? TRIGGER_OUTPUT_CONTRACT_SYSTEM
      : '未使用（输出契约已内联到首条消息）'
    const content = [
      '## System prompt append',
      appendSection,
      '',
      '## 首条用户消息',
      fence(firstPrompt),
    ].join('\n')
    try {
      await this._files.writeFile(
        URI.joinPath(fsPathToWorkspaceUri(request.runDir, request.authority), 'prompt.md'),
        content,
      )
    } catch (err) {
      this._logger.warn(`failed to write prompt audit: ${(err as Error).message}`)
    }
  }

  private async _readResultFile(request: TriggerRunRequest): Promise<string | undefined> {
    try {
      const resultUri = URI.joinPath(
        fsPathToWorkspaceUri(request.runDir, request.authority),
        'result.json',
      )
      return await this._files.readFileText(resultUri)
    } catch {
      return undefined
    }
  }

  private _handleRunEnd(end: TriggerRunEnd, resolution: AutomatedVerdictResolution): void {
    this._runs.delete(end.runId)
    if (end.sessionId !== undefined) {
      this._history.setAutomationResult(end.sessionId, {
        ...(resolution.verdict !== undefined ? { verdict: resolution.verdict } : {}),
        ...(resolution.summary !== undefined ? { summary: resolution.summary } : {}),
        outcome: end.outcome,
      })
    }
    this._onDidEndRun.fire(end)
  }
}

registerSingleton(IAutomatedSessionService, AutomatedSessionService, InstantiationType.Delayed)
