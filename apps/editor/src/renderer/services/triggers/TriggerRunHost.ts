/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse IPC endpoint for agent triggers: main asks the window that owns a
 *  trigger's workspace to start / cancel an automated run, and probes whether
 *  that workspace is trusted. A finished run is reported back to main from here
 *  so the scheduler owns all run bookkeeping (dedupe, backoff, queue slots).
 *  Docs: docs/development/triggers.md.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILoggerService,
  IWorkspaceService,
  IWorkspaceTrustManagementService,
  URI,
  type ILogger,
} from '@universe-editor/platform'
import { ITriggerMainService, type ITriggerRunHost } from '../../../shared/ipc/triggerService.js'
import type { TriggerRunRequest } from '../../../shared/triggers/types.js'
import { IUserSettingsSyncService } from '../configuration/UserSettingsSync.js'
import { IAutomatedSessionService } from './automatedSessionService.js'
import { ITriggerSessionRevealService } from './triggerSessionRevealService.js'

export class TriggerRunHost extends Disposable implements ITriggerRunHost {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IAutomatedSessionService
    private readonly _sessions: IAutomatedSessionService,
    @ITriggerMainService private readonly _triggers: ITriggerMainService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IWorkspaceTrustManagementService
    private readonly _trust: IWorkspaceTrustManagementService,
    @IUserSettingsSyncService private readonly _userSettings: IUserSettingsSyncService,
    @ITriggerSessionRevealService
    private readonly _reveal: ITriggerSessionRevealService,
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
    // Main holds a proxy from window creation, before this service is registered
    // on the channel: only after the ack may it route runs to this window.
    this._register(this._workspace.onDidChangeWorkspace(() => void this._markHostReady()))
    void this._markHostReady()
  }

  private async _markHostReady(): Promise<void> {
    try {
      // Settings hydration is a separate fire-and-forget chain: acking before it
      // lands lets the first run resolve an empty `acp.mcpServers` layer, which
      // silently drops its whole MCP whitelist.
      await Promise.all([this._workspace.whenReady, this._userSettings.whenInitialized])
      const folder = this._workspace.current?.folder
      if (folder === undefined) return
      await this._triggers.markHostReady(folder.toString())
    } catch (err) {
      this._logger.warn(
        `failed to acknowledge the trigger run host: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async startRun(request: TriggerRunRequest): Promise<{ readonly sessionId: string }> {
    const { origin } = request
    this._logger.info(`starting run ${origin.runId} for trigger ${origin.triggerId}`)
    try {
      const { sessionId } = await this._sessions.startAutomatedSession(request)
      this._logger.info(`started run ${origin.runId} as session ${sessionId}`)
      // Reveal is a convenience, not part of the run: a failure here must not
      // turn a started run into a failed one, and it must not delay the result.
      try {
        this._reveal.revealOnRunStart(sessionId, request.showSession)
      } catch (err) {
        this._logger.warn(
          `failed to reveal session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
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

  async isWorkspaceTrusted(workspace: string): Promise<boolean> {
    await this._trust.workspaceTrustInitialized
    const uri = URI.parse(workspace)
    if (uri.scheme === '') {
      this._logger.warn(`cannot judge trust for an invalid workspace uri: ${workspace}`)
      return false
    }
    // Per URI, not the window's current folder: the run belongs to the trigger's
    // workspace, which can differ from what this window shows by now.
    const trusted = this._trust.getUriTrustInfo(uri).trusted
    this._logger.debug(`workspace trusted (${workspace}): ${trusted}`)
    return trusted
  }
}
