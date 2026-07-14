/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Guards running ACP sessions across shutdown-like transitions. Participates in
 *  the lifecycle veto chain (quit / close window / reload / switch workspace):
 *  if any session is still running, it prompts the user before letting the action
 *  interrupt them. Modelled on VSCode's WorkingCopyBackupTracker.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IDialogService,
  ILifecycleService,
  localize,
  ShutdownReason,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

export class SessionShutdownParticipant extends Disposable implements IWorkbenchContribution {
  constructor(
    @ILifecycleService lifecycle: ILifecycleService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IDialogService private readonly _dialog: IDialogService,
  ) {
    super()
    this._register(
      lifecycle.onBeforeShutdown((e) =>
        e.veto(
          this._maybeVeto(
            e.reason,
            e.context?.runningSessionCount,
            e.context?.skipRunningSessionPrompt === true,
          ),
          'acp.runningSessions',
        ),
      ),
    )
  }

  /** @returns true to veto (cancel the action), false to proceed. */
  private async _maybeVeto(
    reason: ShutdownReason,
    aggregateRunningCount?: number,
    skipPrompt = false,
  ): Promise<boolean> {
    if (skipPrompt) return false
    const runningCount =
      aggregateRunningCount ??
      this._sessions.sessions.get().filter((s) => s.status.get() === 'running').length
    if (runningCount === 0) return false

    // E2E runs headless: a modal confirm has no one to answer it and would hang
    // app.close() until SIGKILL, which orphans child processes (node-pty / ACP
    // agents / extension host) on Windows and blows the worker teardown budget.
    // Proceed without prompting so graceful quit + will-quit dispose can run.
    // Mirrors ReloadWindowAction's isE2E modal skip in windowActions.ts.
    const isE2E = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
    if (isE2E) return false

    const { confirmed } = await this._dialog.confirm({
      type: 'warning',
      message: localize(
        'shutdown.runningSessions.message',
        '{count} 个会话正在运行，{action}将中断它们',
        { count: runningCount, action: actionLabel(reason) },
      ),
      detail: localize('shutdown.runningSessions.detail', '是否继续？'),
      primaryButton: localize('shutdown.runningSessions.continue', '继续'),
      cancelButton: localize('common.cancel', '取消'),
    })
    return !confirmed
  }
}

function actionLabel(reason: ShutdownReason): string {
  switch (reason) {
    case ShutdownReason.Quit:
      return localize('shutdown.action.quit', '退出')
    case ShutdownReason.CloseWindow:
      return localize('shutdown.action.closeWindow', '关闭窗口')
    case ShutdownReason.Reload:
      return localize('shutdown.action.reload', '重启编辑器')
    case ShutdownReason.SwitchWorkspace:
      return localize('shutdown.action.switchWorkspace', '切换工作区')
  }
}
