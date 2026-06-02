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

export class SessionShutdownParticipant extends Disposable implements IWorkbenchContribution {
  constructor(
    @ILifecycleService lifecycle: ILifecycleService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IDialogService private readonly _dialog: IDialogService,
  ) {
    super()
    this._register(
      lifecycle.onBeforeShutdown((e) => e.veto(this._maybeVeto(e.reason), 'acp.runningSessions')),
    )
  }

  /** @returns true to veto (cancel the action), false to proceed. */
  private async _maybeVeto(reason: ShutdownReason): Promise<boolean> {
    const running = this._sessions.sessions.get().filter((s) => s.status.get() === 'running')
    if (running.length === 0) return false

    const { confirmed } = await this._dialog.confirm({
      type: 'warning',
      message: localize(
        'shutdown.runningSessions.message',
        '{count} 个会话正在运行，{action}将中断它们',
        { count: running.length, action: actionLabel(reason) },
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
