/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  把上一会话的异常退出报成 sticky 警告，附「打开崩溃目录」action。
 *  main 侧靠会话哨兵发现；报告是 consume-once 的，多窗口下只有一个窗口提示。
 *  这里只知道「没有留下 dump」——归因在 main 的异常退出取证里，通知不猜死因。
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  INotificationService,
  IWorkbenchContribution,
  Severity,
  localize,
} from '@universe-editor/platform'
import { IDiagnosticsService } from '../../shared/ipc/services.js'

export class AbnormalExitNotificationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IDiagnosticsService private readonly _diagnostics: IDiagnosticsService,
    @INotificationService private readonly _notifications: INotificationService,
  ) {
    super()
    void this._checkPreviousSession()
  }

  private async _checkPreviousSession(): Promise<void> {
    const report = await this._diagnostics.consumeAbnormalExitReport()
    if (!report) return
    const hasDumps = report.crashDumps.length > 0
    const diedAround = new Date(report.previousLastAliveAt).toLocaleString()
    this._notifications.notify({
      severity: Severity.Warning,
      message: hasDumps
        ? localize(
            'abnormalExit.withDumps',
            'The previous session terminated abnormally and left {count} crash dump files.',
            {
              count: String(report.crashDumps.length),
            },
          )
        : localize(
            'abnormalExit.noDumps',
            'The previous session did not exit cleanly around {time} and left no crash dump; the cause is unknown.',
            { time: diedAround },
          ),
      sticky: true,
      actions: [
        {
          label: localize('abnormalExit.openCrashes', 'Open Crashes Folder'),
          run: () => {
            void this._diagnostics.revealCrashesFolder()
          },
        },
      ],
    })
  }
}
