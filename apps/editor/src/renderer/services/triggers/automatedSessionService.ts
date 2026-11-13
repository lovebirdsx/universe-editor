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
  registerSingleton,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { IAcpAgentRegistry } from '../acp/acpAgentRegistry.js'
import { isSessionModeCategory } from '../acp/configOptionLabel.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import type { IAcpSession } from '../acp/session/acpSessionModel.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
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
    const session = await this._sessions.createSession(agentId, {
      cwd: request.cwd,
      activate: false,
      // Not `internal`: an automated session is persisted and listed so the
      // user can inspect what the trigger did.
      title: `${request.origin.triggerName} · ${request.origin.eventKey}`,
      automation: request.origin,
      automationRunDir: request.runDir,
      additionalDirectories: [request.runDir],
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
      readResultFile: (runDir) => this._readResultFile(runDir),
      resolveVerdict: this._verdictResolver,
      onRunEnd: (end, resolution) => this._handleRunEnd(end, resolution),
      logger: this._logger,
    })
    this._runs.set(runId, { session, watcher })
    watcher.start()
    void session.sendPrompt(request.prompt).then(
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

  private async _readResultFile(runDir: string): Promise<string | undefined> {
    try {
      return await this._files.readFileText(URI.joinPath(URI.file(runDir), 'result.json'))
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
