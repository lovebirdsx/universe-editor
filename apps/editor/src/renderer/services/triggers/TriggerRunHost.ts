/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse IPC endpoint for agent triggers: main asks the window that owns a
 *  trigger's workspace to start / cancel an automated run, and probes whether
 *  that workspace is trusted. A finished run is reported back to main from here
 *  so the scheduler owns all run bookkeeping (dedupe, backoff, queue slots).
 *  Design §1 / §3.4.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILoggerService,
  IWorkspaceTrustManagementService,
  type ILogger,
} from '@universe-editor/platform'
import { ITriggerMainService, type ITriggerRunHost } from '../../../shared/ipc/triggerService.js'
import type { TriggerRunRequest } from '../../../shared/triggers/types.js'
import { IAutomatedSessionService } from './automatedSessionService.js'

export class TriggerRunHost extends Disposable implements ITriggerRunHost {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IAutomatedSessionService
    private readonly _sessions: IAutomatedSessionService,
    @ITriggerMainService private readonly _triggers: ITriggerMainService,
    @IWorkspaceTrustManagementService
    private readonly _trust: IWorkspaceTrustManagementService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'triggerRunHost', name: 'Triggers' })
    this._register(
      this._sessions.onDidEndRun((end) => {
        this._logger.debug(`run ${end.runId} (${end.triggerId}) ended: ${end.outcome}`)
        void this._triggers.reportRunEnd(end).catch((err: unknown) => {
          this._logger.warn(
            `failed to report end of run ${end.runId}: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }),
    )
  }

  async startRun(request: TriggerRunRequest): Promise<{ readonly sessionId: string }> {
    const { origin } = request
    this._logger.info(`starting run ${origin.runId} for trigger ${origin.triggerId}`)
    try {
      const { sessionId } = await this._sessions.startAutomatedSession(request)
      this._logger.info(`started run ${origin.runId} as session ${sessionId}`)
      return { sessionId }
    } catch (err) {
      this._logger.warn(
        `failed to start run ${origin.runId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this._logger.info(`cancelling run ${runId}`)
    this._sessions.cancelRun(runId)
  }

  async isWorkspaceTrusted(): Promise<boolean> {
    await this._trust.workspaceTrustInitialized
    const trusted = this._trust.isWorkspaceTrusted()
    this._logger.debug(`workspace trusted: ${trusted}`)
    return trusted
  }
}
